//! `mc-mobile-gateway` binary entry point.
//!
//! Spawned as a child process by `mc-agent` Electron Main when Mobile Access is
//! switched on. Communicates strictly over stdin/stdout NDJSON (zero local TCP
//! ports) and exits cleanly when stdin closes.

mod gateway;
mod proto;
mod state;

use std::env;
use std::path::PathBuf;

use anyhow::{Context as _, Result};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::sync::mpsc;

use crate::proto::{HostCommand, HostEvent};
use crate::state::GatewayState;

const VERSION: &str = env!("CARGO_PKG_VERSION");

fn default_hostname() -> String {
    env::var("HOSTNAME")
        .or_else(|_| env::var("COMPUTERNAME"))
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "mc-agent Desktop".to_string())
}

fn parse_args() -> Result<Option<(PathBuf, String, bool)>> {
    let mut args = env::args().skip(1);
    let mut data_dir: Option<PathBuf> = None;
    let mut hostname: Option<String> = None;
    let mut mdns = true;

    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--version" | "-V" => {
                println!("mc-mobile-gateway {VERSION}");
                return Ok(None);
            }
            "--data-dir" => {
                let val = args.next().context("--data-dir requires a path")?;
                data_dir = Some(PathBuf::from(val));
            }
            "--name" => {
                let val = args.next().context("--name requires a hostname")?;
                hostname = Some(val);
            }
            "--no-mdns" => {
                mdns = false;
            }
            other => {
                anyhow::bail!("unknown argument: {other}");
            }
        }
    }

    let dir = match data_dir {
        Some(d) => d,
        None => {
            let home = env::var("HOME")
                .or_else(|_| env::var("USERPROFILE"))
                .context("HOME / USERPROFILE not set")?;
            PathBuf::from(home).join(".mc-agent").join("mobile")
        }
    };
    let name = hostname
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(default_hostname);
    Ok(Some((dir, name, mdns)))
}

#[tokio::main(flavor = "multi_thread", worker_threads = 2)]
async fn main() -> Result<()> {
    let Some((data_dir, hostname, mdns)) = parse_args()? else {
        return Ok(());
    };

    let state = GatewayState::open(data_dir, hostname)?;
    let secret = state.load_or_create_secret_key()?;
    let endpoint = gateway::bind_endpoint(secret, mdns).await?;

    let (cmd_tx, cmd_rx) = mpsc::channel::<HostCommand>(128);
    let (ev_tx, mut ev_rx) = mpsc::unbounded_channel::<HostEvent>();

    // Stdout writer task (NDJSON lines back to Electron Main).
    let stdout_task = tokio::spawn(async move {
        let mut stdout = tokio::io::stdout();
        while let Some(ev) = ev_rx.recv().await {
            if let Ok(mut line) = serde_json::to_string(&ev) {
                line.push('\n');
                if stdout.write_all(line.as_bytes()).await.is_err() {
                    break;
                }
                let _ = stdout.flush().await;
            }
        }
    });

    // Stdin reader task (NDJSON commands from Electron Main).
    let stdin_err_tx = ev_tx.clone();
    let stdin_task = tokio::spawn(async move {
        let mut lines = BufReader::new(tokio::io::stdin()).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            let trimmed = line.trim();
            if trimmed.is_empty() {
                continue;
            }
            match serde_json::from_str::<HostCommand>(trimmed) {
                Ok(cmd) => {
                    let is_shutdown = matches!(cmd, HostCommand::Shutdown);
                    if cmd_tx.send(cmd).await.is_err() || is_shutdown {
                        break;
                    }
                }
                Err(e) => {
                    let _ = stdin_err_tx.send(HostEvent::Error {
                        message: format!("invalid host command: {e}"),
                    });
                }
            }
        }
        // Stdin closed (parent exited): ensure gateway shuts down cleanly.
        let _ = cmd_tx.send(HostCommand::Shutdown).await;
    });

    let res = gateway::run_gateway(endpoint, state, cmd_rx, ev_tx).await;
    stdin_task.abort();
    let _ = stdout_task.await;
    res
}
