//! mc-agent Computer Use helper (docs/mc-agent/computer-use.md,
//! MC-ADR-0014).
//!
//! `mc-computer mcp` serves the tools over stdio for the bundled
//! `mc.computer-use` plugin. Everything runs on this machine: the program
//! makes no network requests.

mod backend;
mod keys;
mod mcp;
mod render;
mod tools;

#[cfg(target_os = "macos")]
mod macos;
#[cfg(not(any(target_os = "macos", target_os = "windows")))]
mod unsupported;
#[cfg(target_os = "windows")]
mod windows;

use std::io::{stdin, stdout, BufReader};
use std::process::ExitCode;

fn platform_backend() -> Box<dyn backend::Backend> {
    #[cfg(target_os = "macos")]
    {
        Box::new(macos::MacBackend::new())
    }
    #[cfg(target_os = "windows")]
    {
        Box::new(windows::WindowsBackend::new())
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        Box::new(unsupported::Unsupported)
    }
}

fn main() -> ExitCode {
    let command = std::env::args().nth(1).unwrap_or_default();
    match command.as_str() {
        "mcp" => {
            let mut backend = platform_backend();
            match mcp::serve(
                backend.as_mut(),
                BufReader::new(stdin().lock()),
                stdout().lock(),
            ) {
                Ok(()) => ExitCode::SUCCESS,
                Err(error) => {
                    eprintln!("mc-computer: {error:#}");
                    ExitCode::FAILURE
                }
            }
        }
        "--version" | "-V" => {
            println!("mc-computer {}", env!("CARGO_PKG_VERSION"));
            ExitCode::SUCCESS
        }
        _ => {
            eprintln!("usage: mc-computer mcp");
            ExitCode::from(2)
        }
    }
}
