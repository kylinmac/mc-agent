//! Wire framing and message types shared across the iroh mobile link and the
//! Electron Main stdio NDJSON bridge (mc-agent R43).

use std::io;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};

/// ALPN presented during the iroh QUIC handshake.
pub const ALPN: &[u8] = b"mc-agent/mobile/1";

/// mDNS service name for zero-config LAN discovery.
pub const MDNS_SERVICE: &str = "mc-agent";

/// Current wire protocol version.
pub const PROTOCOL_VERSION: u32 = 1;

/// Maximum single frame payload size (12 MiB to accommodate image attachments & whiteboard scenes).
pub const MAX_FRAME_BYTES: usize = 12 * 1024 * 1024;

/// Frame kind: UTF-8 JSON payload.
pub const KIND_JSON: u8 = 0;

/// Pairing code scheme prefix.
pub const PAIR_URI_PREFIX: &str = "mc-pair://v1";

/// First message sent by a phone when opening a bidirectional QUIC stream.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum StreamOpen {
    Pair {
        secret: String,
        device_name: String,
        #[serde(default)]
        platform: String,
    },
    Control {
        protocol_version: u32,
    },
}

/// Immediate reply sent by the gateway to a [`StreamOpen`].
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum StreamReply {
    PairOk {
        protocol_version: u32,
        node_id: String,
        machine_name: String,
    },
    ControlOk {
        protocol_version: u32,
        node_id: String,
        machine_name: String,
    },
    Denied {
        code: String,
        message: String,
    },
}

/// Message sent from phone to gateway on an authenticated control stream.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum PhoneMessage {
    Req {
        id: String,
        method: String,
        #[serde(default)]
        params: Value,
    },
    Ping {
        ts: u64,
    },
}

/// Message sent from gateway to phone on an authenticated control stream.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum GatewayWireMessage {
    Res {
        id: String,
        ok: bool,
        #[serde(skip_serializing_if = "Option::is_none")]
        result: Option<Value>,
        #[serde(skip_serializing_if = "Option::is_none")]
        error: Option<RpcErrorPayload>,
    },
    Event {
        event: String,
        payload: Value,
    },
    Pong {
        ts: u64,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RpcErrorPayload {
    pub code: String,
    pub message: String,
}

/// Summary of a paired mobile device exposed to Electron Main and Settings UI.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PairedDeviceView {
    pub device_id: String,
    pub name: String,
    pub platform: String,
    pub paired_at: u64,
    pub last_seen_at: u64,
    pub online: bool,
}

/// Commands received on stdin (NDJSON) from Electron Main.
#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum HostCommand {
    CreatePair {
        #[serde(default = "default_ttl_secs", rename = "ttlSecs")]
        ttl_secs: u64,
    },
    RevokeDevice {
        #[serde(rename = "deviceId")]
        device_id: String,
    },
    ListDevices,
    RpcResponse {
        #[serde(rename = "connId")]
        conn_id: String,
        id: String,
        ok: bool,
        #[serde(default)]
        result: Option<Value>,
        #[serde(default)]
        error: Option<RpcErrorPayload>,
    },
    PushEvent {
        #[serde(default, rename = "connId")]
        conn_id: Option<String>,
        event: String,
        payload: Value,
    },
    Shutdown,
}

fn default_ttl_secs() -> u64 {
    600
}

/// Events emitted on stdout (NDJSON) to Electron Main.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum HostEvent {
    Ready {
        #[serde(rename = "nodeId")]
        node_id: String,
        relay: Option<String>,
        addrs: Vec<String>,
        hostname: String,
        devices: Vec<PairedDeviceView>,
    },
    Reachable {
        relay: Option<String>,
        addrs: Vec<String>,
    },
    PairCreated {
        secret: String,
        #[serde(rename = "expiresAt")]
        expires_at: u64,
        #[serde(rename = "pairUri")]
        pair_uri: String,
        #[serde(rename = "qrSvg")]
        qr_svg: String,
    },
    DevicesChanged {
        devices: Vec<PairedDeviceView>,
    },
    RpcRequest {
        #[serde(rename = "connId")]
        conn_id: String,
        #[serde(rename = "deviceId")]
        device_id: String,
        id: String,
        method: String,
        params: Value,
    },
    Error {
        message: String,
    },
}

/// Write a single JSON frame (`u32 LE len` + `u8 kind` + UTF-8 JSON bytes).
pub async fn write_json_frame<W, T>(writer: &mut W, value: &T) -> io::Result<()>
where
    W: AsyncWrite + Unpin,
    T: Serialize,
{
    let payload = serde_json::to_vec(value)
        .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e.to_string()))?;
    if payload.len() > MAX_FRAME_BYTES {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!("frame exceeds max size ({} bytes)", MAX_FRAME_BYTES),
        ));
    }
    let len = payload.len() as u32;
    writer.write_all(&len.to_le_bytes()).await?;
    writer.write_all(&[KIND_JSON]).await?;
    writer.write_all(&payload).await?;
    writer.flush().await
}

/// Read a single JSON frame from a QUIC stream.
pub async fn read_json_frame<R, T>(reader: &mut R) -> io::Result<T>
where
    R: AsyncRead + Unpin,
    T: for<'de> Deserialize<'de>,
{
    let mut len_buf = [0u8; 4];
    reader.read_exact(&mut len_buf).await?;
    let len = u32::from_le_bytes(len_buf) as usize;
    if len > MAX_FRAME_BYTES {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!("incoming frame too large ({len} bytes)"),
        ));
    }
    let mut kind_buf = [0u8; 1];
    reader.read_exact(&mut kind_buf).await?;
    if kind_buf[0] != KIND_JSON {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!("unsupported frame kind {}", kind_buf[0]),
        ));
    }
    let mut buf = vec![0u8; len];
    reader.read_exact(&mut buf).await?;
    serde_json::from_slice(&buf)
        .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e.to_string()))
}
