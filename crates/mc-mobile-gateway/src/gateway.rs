//! iroh endpoint listener, per-connection dispatch, and host bridge routing.

use std::collections::HashMap;
use std::net::{Ipv4Addr, Ipv6Addr, SocketAddr};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use anyhow::Result;
use iroh::endpoint::{presets, BindOpts, Connection, QuicTransportConfig};
use iroh::{Endpoint, SecretKey, Watcher as _};
use iroh_mdns_address_lookup::MdnsAddressLookup;
use tokio::sync::{mpsc, Mutex};
use tokio::time::timeout;

use crate::proto::{
    read_json_frame, write_json_frame, GatewayWireMessage, HostCommand, HostEvent, PhoneMessage,
    StreamOpen, StreamReply, ALPN, MDNS_SERVICE, PROTOCOL_VERSION,
};
use crate::state::GatewayState;

const OPEN_TIMEOUT: Duration = Duration::from_secs(10);
const PAIR_FAIL_DELAY: Duration = Duration::from_secs(1);
const IDLE_TIMEOUT: Duration = Duration::from_secs(20);
const MAX_OUTBOUND_QUEUE: usize = 512;

struct ActiveConnection {
    device_id: String,
    tx: mpsc::Sender<GatewayWireMessage>,
    quic: Connection,
}

#[derive(Clone)]
pub struct ConnectionRegistry {
    next_id: Arc<AtomicU64>,
    conns: Arc<Mutex<HashMap<String, ActiveConnection>>>,
}

impl ConnectionRegistry {
    pub fn new() -> Self {
        Self {
            next_id: Arc::new(AtomicU64::new(1)),
            conns: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    pub async fn register(
        &self,
        device_id: String,
        tx: mpsc::Sender<GatewayWireMessage>,
        quic: Connection,
    ) -> String {
        let id = format!("c{}", self.next_id.fetch_add(1, Ordering::Relaxed));
        self.conns.lock().await.insert(
            id.clone(),
            ActiveConnection {
                device_id,
                tx,
                quic,
            },
        );
        id
    }

    pub async fn remove(&self, conn_id: &str) -> Option<String> {
        let removed = self.conns.lock().await.remove(conn_id)?;
        let device_id = removed.device_id;
        let still_online = self
            .conns
            .lock()
            .await
            .values()
            .any(|c| c.device_id == device_id);
        if still_online {
            None
        } else {
            Some(device_id)
        }
    }

    pub async fn send_to(&self, conn_id: &str, msg: GatewayWireMessage) {
        let tx = { self.conns.lock().await.get(conn_id).map(|c| c.tx.clone()) };
        if let Some(tx) = tx {
            let _ = tx.try_send(msg);
        }
    }

    pub async fn broadcast(&self, msg: GatewayWireMessage) {
        let txs: Vec<mpsc::Sender<GatewayWireMessage>> = {
            self.conns
                .lock()
                .await
                .values()
                .map(|c| c.tx.clone())
                .collect()
        };
        for tx in txs {
            let _ = tx.try_send(msg.clone());
        }
    }

    pub async fn kick_device(&self, device_id: &str) {
        let targets: Vec<Connection> = {
            let mut map = self.conns.lock().await;
            let ids: Vec<String> = map
                .iter()
                .filter(|(_, c)| c.device_id == device_id)
                .map(|(k, _)| k.clone())
                .collect();
            ids.into_iter()
                .filter_map(|k| map.remove(&k).map(|c| c.quic))
                .collect()
        };
        for conn in targets {
            conn.close(1u32.into(), b"revoked");
        }
    }
}

fn transport_config() -> QuicTransportConfig {
    QuicTransportConfig::builder()
        .max_idle_timeout(IDLE_TIMEOUT.try_into().ok())
        .build()
}

pub async fn bind_endpoint(key: SecretKey, enable_mdns: bool) -> Result<Endpoint> {
    let attempts: &[bool] = if enable_mdns {
        &[true, false]
    } else {
        &[false]
    };
    let mut last_err = None;
    for &mdns in attempts {
        let mut builder = Endpoint::builder(presets::N0)
            .secret_key(key.clone())
            .alpns(vec![ALPN.to_vec()])
            .transport_config(transport_config())
            .clear_ip_transports()
            .bind_addr(SocketAddr::from((Ipv4Addr::UNSPECIFIED, 0)))?
            .bind_addr_with_opts(
                SocketAddr::from((Ipv6Addr::UNSPECIFIED, 0)),
                BindOpts::default().set_is_required(false),
            )?;
        if mdns {
            builder =
                builder.address_lookup(MdnsAddressLookup::builder().service_name(MDNS_SERVICE));
        }
        match builder.bind().await {
            Ok(ep) => return Ok(ep),
            Err(e) => last_err = Some(e),
        }
    }
    Err(last_err
        .map(anyhow::Error::from)
        .unwrap_or_else(|| anyhow::anyhow!("failed to bind iroh endpoint")))
}

pub fn connected_relay(endpoint: &Endpoint) -> Option<String> {
    endpoint
        .home_relay_status()
        .get()
        .iter()
        .find(|status| status.is_connected())
        .map(|status| status.url().to_string())
}

pub fn local_addrs(endpoint: &Endpoint) -> Vec<String> {
    endpoint.addr().ip_addrs().map(|a| a.to_string()).collect()
}

pub async fn run_gateway(
    endpoint: Endpoint,
    state: GatewayState,
    mut cmd_rx: mpsc::Receiver<HostCommand>,
    event_tx: mpsc::UnboundedSender<HostEvent>,
) -> Result<()> {
    let node_id = endpoint.id().to_string();
    let registry = ConnectionRegistry::new();

    let relay = connected_relay(&endpoint);
    let addrs = local_addrs(&endpoint);
    state.set_reachable(relay.clone(), addrs.clone());

    let _ = event_tx.send(HostEvent::Ready {
        node_id: node_id.clone(),
        relay,
        addrs,
        hostname: state.hostname().to_string(),
        devices: state.list_devices(),
    });

    // Periodically refresh relay & IP addresses so pairing codes stay accurate.
    let reach_ep = endpoint.clone();
    let reach_state = state.clone();
    let reach_tx = event_tx.clone();
    let reach_task = tokio::spawn(async move {
        let mut interval = tokio::time::interval(Duration::from_secs(3));
        loop {
            interval.tick().await;
            let relay = connected_relay(&reach_ep);
            let addrs = local_addrs(&reach_ep);
            if reach_state.set_reachable(relay.clone(), addrs.clone()) {
                let _ = reach_tx.send(HostEvent::Reachable { relay, addrs });
            }
        }
    });

    // Accept incoming iroh connections.
    let accept_ep = endpoint.clone();
    let accept_state = state.clone();
    let accept_reg = registry.clone();
    let accept_tx = event_tx.clone();
    let accept_node_id = node_id.clone();
    let accept_task = tokio::spawn(async move {
        while let Some(incoming) = accept_ep.accept().await {
            let state = accept_state.clone();
            let registry = accept_reg.clone();
            let event_tx = accept_tx.clone();
            let node_id = accept_node_id.clone();
            tokio::spawn(async move {
                let Ok(connecting) = incoming.accept() else {
                    return;
                };
                let Ok(conn) = connecting.await else {
                    return;
                };
                handle_connection(conn, node_id, state, registry, event_tx).await;
            });
        }
    });

    // Process commands from Electron Main until Shutdown or stdin EOF.
    while let Some(cmd) = cmd_rx.recv().await {
        match cmd {
            HostCommand::CreatePair { ttl_secs } => {
                match state.create_pairing_offer(&node_id, ttl_secs) {
                    Ok((secret, expires_at, pair_uri, qr_svg)) => {
                        let _ = event_tx.send(HostEvent::PairCreated {
                            secret,
                            expires_at,
                            pair_uri,
                            qr_svg,
                        });
                    }
                    Err(e) => {
                        let _ = event_tx.send(HostEvent::Error {
                            message: format!("create pair failed: {e}"),
                        });
                    }
                }
            }
            HostCommand::RevokeDevice { device_id } => {
                registry.kick_device(&device_id).await;
                match state.revoke_device(&device_id) {
                    Ok((_, devices)) => {
                        let _ = event_tx.send(HostEvent::DevicesChanged { devices });
                    }
                    Err(e) => {
                        let _ = event_tx.send(HostEvent::Error {
                            message: format!("revoke device failed: {e}"),
                        });
                    }
                }
            }
            HostCommand::ListDevices => {
                let _ = event_tx.send(HostEvent::DevicesChanged {
                    devices: state.list_devices(),
                });
            }
            HostCommand::RpcResponse {
                conn_id,
                id,
                ok,
                result,
                error,
            } => {
                registry
                    .send_to(
                        &conn_id,
                        GatewayWireMessage::Res {
                            id,
                            ok,
                            result,
                            error,
                        },
                    )
                    .await;
            }
            HostCommand::PushEvent {
                conn_id,
                event,
                payload,
            } => {
                let msg = GatewayWireMessage::Event { event, payload };
                if let Some(target) = conn_id {
                    registry.send_to(&target, msg).await;
                } else {
                    registry.broadcast(msg).await;
                }
            }
            HostCommand::Shutdown => break,
        }
    }

    reach_task.abort();
    accept_task.abort();
    endpoint.close().await;
    Ok(())
}

async fn handle_connection(
    conn: Connection,
    node_id: String,
    state: GatewayState,
    registry: ConnectionRegistry,
    event_tx: mpsc::UnboundedSender<HostEvent>,
) {
    let remote_id = conn.remote_id().to_string();

    while let Ok((mut send, mut recv)) = conn.accept_bi().await {
        let open: StreamOpen = match timeout(OPEN_TIMEOUT, read_json_frame(&mut recv)).await {
            Ok(Ok(msg)) => msg,
            _ => {
                let _ = send.finish();
                continue;
            }
        };

        match open {
            StreamOpen::Pair {
                secret,
                device_name,
                platform,
            } => {
                let ok = state
                    .consume_pairing_offer(&secret, remote_id.clone(), device_name, platform)
                    .unwrap_or(false);
                if ok {
                    let _ = write_json_frame(
                        &mut send,
                        &StreamReply::PairOk {
                            protocol_version: PROTOCOL_VERSION,
                            node_id: node_id.clone(),
                            machine_name: state.hostname().to_string(),
                        },
                    )
                    .await;
                    let _ = send.finish();
                    let _ = event_tx.send(HostEvent::DevicesChanged {
                        devices: state.list_devices(),
                    });
                } else {
                    tokio::time::sleep(PAIR_FAIL_DELAY).await;
                    let _ = write_json_frame(
                        &mut send,
                        &StreamReply::Denied {
                            code: "PAIR_INVALID".to_string(),
                            message: "Pairing code is invalid or expired.".to_string(),
                        },
                    )
                    .await;
                    let _ = send.finish();
                }
            }
            StreamOpen::Control { protocol_version } => {
                if protocol_version != PROTOCOL_VERSION {
                    let _ = write_json_frame(
                        &mut send,
                        &StreamReply::Denied {
                            code: "PROTOCOL_MISMATCH".to_string(),
                            message: format!(
                                "Expected protocol v{PROTOCOL_VERSION}, got v{protocol_version}."
                            ),
                        },
                    )
                    .await;
                    let _ = send.finish();
                    continue;
                }
                if !state.is_paired(&remote_id) {
                    let _ = write_json_frame(
                        &mut send,
                        &StreamReply::Denied {
                            code: "UNPAIRED".to_string(),
                            message: "Device is not paired with this desktop.".to_string(),
                        },
                    )
                    .await;
                    let _ = send.finish();
                    continue;
                }

                if write_json_frame(
                    &mut send,
                    &StreamReply::ControlOk {
                        protocol_version: PROTOCOL_VERSION,
                        node_id: node_id.clone(),
                        machine_name: state.hostname().to_string(),
                    },
                )
                .await
                .is_err()
                {
                    continue;
                }

                let (out_tx, mut out_rx) = mpsc::channel::<GatewayWireMessage>(MAX_OUTBOUND_QUEUE);
                let conn_id = registry
                    .register(remote_id.clone(), out_tx.clone(), conn.clone())
                    .await;
                let devices = state.mark_online(&remote_id, true);
                let _ = event_tx.send(HostEvent::DevicesChanged { devices });

                let writer_task = tokio::spawn(async move {
                    while let Some(msg) = out_rx.recv().await {
                        if write_json_frame(&mut send, &msg).await.is_err() {
                            break;
                        }
                    }
                    let _ = send.finish();
                });

                let event_tx_clone = event_tx.clone();
                let conn_id_clone = conn_id.clone();
                let device_id_clone = remote_id.clone();
                let out_tx_clone = out_tx.clone();
                let registry_clone = registry.clone();
                let state_clone = state.clone();

                tokio::spawn(async move {
                    while let Ok(msg) = read_json_frame::<_, PhoneMessage>(&mut recv).await {
                        match msg {
                            PhoneMessage::Ping { ts } => {
                                let _ = out_tx_clone.try_send(GatewayWireMessage::Pong { ts });
                            }
                            PhoneMessage::Req { id, method, params } => {
                                let _ = event_tx_clone.send(HostEvent::RpcRequest {
                                    conn_id: conn_id_clone.clone(),
                                    device_id: device_id_clone.clone(),
                                    id,
                                    method,
                                    params,
                                });
                            }
                        }
                    }
                    writer_task.abort();
                    if let Some(offline_dev) = registry_clone.remove(&conn_id_clone).await {
                        let devices = state_clone.mark_online(&offline_dev, false);
                        let _ = event_tx_clone.send(HostEvent::DevicesChanged { devices });
                    }
                });
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::proto::PAIR_URI_PREFIX;
    use anyhow::Context as _;
    use iroh::EndpointAddr;
    use serde_json::json;
    use tempfile::tempdir;

    #[tokio::test]
    async fn full_iroh_pair_control_rpc_event_and_revoke_cycle() -> Result<()> {
        let dir = tempdir()?;
        let state = GatewayState::open(dir.path().to_path_buf(), "Test-Mac".to_string())?;
        let gw_key = state.load_or_create_secret_key()?;
        let gw_ep = bind_endpoint(gw_key, false).await?;
        let gw_addr: EndpointAddr = gw_ep.addr();

        let (cmd_tx, cmd_rx) = mpsc::channel(32);
        let (ev_tx, mut ev_rx) = mpsc::unbounded_channel();
        let gw_task = tokio::spawn(run_gateway(gw_ep, state, cmd_rx, ev_tx));

        // 1. Wait for Ready event.
        let ready = timeout(Duration::from_secs(10), ev_rx.recv())
            .await?
            .context("expected ready event")?;
        let gw_node_id = match ready {
            HostEvent::Ready { node_id, .. } => node_id,
            other => anyhow::bail!("expected Ready, got {other:?}"),
        };

        // 2. Spin up a real phone iroh endpoint.
        let phone_secret = SecretKey::from_bytes(&[7u8; 32]);
        let phone_ep = Endpoint::builder(presets::N0)
            .secret_key(phone_secret)
            .transport_config(transport_config())
            .bind()
            .await?;
        let phone_node_id = phone_ep.id().to_string();

        // 3. Unpaired control stream must be rejected.
        let conn = phone_ep.connect(gw_addr.clone(), ALPN).await?;
        {
            let (mut s, mut r) = conn.open_bi().await?;
            write_json_frame(
                &mut s,
                &StreamOpen::Control {
                    protocol_version: PROTOCOL_VERSION,
                },
            )
            .await?;
            let reply: StreamReply = read_json_frame(&mut r).await?;
            assert!(matches!(reply, StreamReply::Denied { code, .. } if code == "UNPAIRED"));
        }

        // 4. Ask gateway to issue a single-use pairing code.
        cmd_tx
            .send(HostCommand::CreatePair { ttl_secs: 300 })
            .await?;
        let secret = loop {
            match timeout(Duration::from_secs(5), ev_rx.recv())
                .await?
                .context("ev")?
            {
                HostEvent::PairCreated {
                    secret,
                    pair_uri,
                    qr_svg,
                    ..
                } => {
                    assert!(pair_uri.starts_with(PAIR_URI_PREFIX));
                    assert!(pair_uri.contains(&gw_node_id));
                    assert!(qr_svg.contains("<svg"));
                    break secret;
                }
                _ => continue,
            }
        };

        // 5. Pair with the valid secret.
        {
            let (mut s, mut r) = conn.open_bi().await?;
            write_json_frame(
                &mut s,
                &StreamOpen::Pair {
                    secret: secret.clone(),
                    device_name: "Galaxy S24 Ultra".to_string(),
                    platform: "android".to_string(),
                },
            )
            .await?;
            let reply: StreamReply = read_json_frame(&mut r).await?;
            assert!(matches!(
                reply,
                StreamReply::PairOk {
                    protocol_version: 1,
                    ..
                }
            ));
        }

        // 6. Replaying the same single-use secret must fail.
        {
            let (mut s, mut r) = conn.open_bi().await?;
            write_json_frame(
                &mut s,
                &StreamOpen::Pair {
                    secret,
                    device_name: "Replay".to_string(),
                    platform: "android".to_string(),
                },
            )
            .await?;
            let reply: StreamReply = read_json_frame(&mut r).await?;
            assert!(matches!(reply, StreamReply::Denied { code, .. } if code == "PAIR_INVALID"));
        }

        // 7. Open authenticated control stream and round-trip RPC + broadcast event.
        let (mut ctrl_send, mut ctrl_recv) = conn.open_bi().await?;
        write_json_frame(
            &mut ctrl_send,
            &StreamOpen::Control {
                protocol_version: PROTOCOL_VERSION,
            },
        )
        .await?;
        let ctrl_reply: StreamReply = read_json_frame(&mut ctrl_recv).await?;
        assert!(matches!(ctrl_reply, StreamReply::ControlOk { .. }));

        write_json_frame(
            &mut ctrl_send,
            &PhoneMessage::Req {
                id: "req-1".to_string(),
                method: "host.info".to_string(),
                params: json!({}),
            },
        )
        .await?;

        let conn_id = loop {
            match timeout(Duration::from_secs(5), ev_rx.recv())
                .await?
                .context("ev")?
            {
                HostEvent::RpcRequest {
                    conn_id,
                    device_id,
                    id,
                    method,
                    ..
                } => {
                    assert_eq!(device_id, phone_node_id);
                    assert_eq!(id, "req-1");
                    assert_eq!(method, "host.info");
                    break conn_id;
                }
                _ => continue,
            }
        };

        cmd_tx
            .send(HostCommand::RpcResponse {
                conn_id: conn_id.clone(),
                id: "req-1".to_string(),
                ok: true,
                result: Some(json!({ "hostname": "Test-Mac" })),
                error: None,
            })
            .await?;

        let wire_res: GatewayWireMessage = read_json_frame(&mut ctrl_recv).await?;
        assert!(
            matches!(wire_res, GatewayWireMessage::Res { ref id, ok: true, .. } if id == "req-1")
        );

        cmd_tx
            .send(HostCommand::PushEvent {
                conn_id: None,
                event: "attention.updated".to_string(),
                payload: json!({ "pending": 2 }),
            })
            .await?;
        let wire_ev: GatewayWireMessage = read_json_frame(&mut ctrl_recv).await?;
        assert!(
            matches!(wire_ev, GatewayWireMessage::Event { ref event, .. } if event == "attention.updated")
        );

        // 8. Revoke device: active connection gets kicked and re-opening control is denied.
        cmd_tx
            .send(HostCommand::RevokeDevice {
                device_id: phone_node_id,
            })
            .await?;
        tokio::time::sleep(Duration::from_millis(150)).await;
        let conn2 = phone_ep.connect(gw_addr, ALPN).await?;
        let (mut s2, mut r2) = conn2.open_bi().await?;
        write_json_frame(
            &mut s2,
            &StreamOpen::Control {
                protocol_version: PROTOCOL_VERSION,
            },
        )
        .await?;
        let denied: StreamReply = read_json_frame(&mut r2).await?;
        assert!(matches!(denied, StreamReply::Denied { code, .. } if code == "UNPAIRED"));

        cmd_tx.send(HostCommand::Shutdown).await?;
        let _ = timeout(Duration::from_secs(5), gw_task).await;
        phone_ep.close().await;
        Ok(())
    }
}
