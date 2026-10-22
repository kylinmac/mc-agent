//! Window list (CGWindowList) and window screenshots (`screencapture`).

use std::path::{Path, PathBuf};
use std::process::Command;

use anyhow::{anyhow, Context, Result};

use super::ax::Frame;
use super::cf::{self, Cf};
use super::ffi::*;
use crate::backend::Screenshot;

/// Longest screenshot side sent to the model.
const MAX_SIDE: u32 = 1280;
/// JPEG quality (sips `formatOptions`, 0–100).
const JPEG_QUALITY: &str = "70";

#[derive(Debug, Clone)]
pub struct WindowInfo {
    pub id: u32,
    pub pid: i32,
    pub owner: String,
    /// Screen points, top-left origin.
    pub bounds: Frame,
    pub layer: i64,
}

/// On-screen windows, front to back.
pub fn on_screen() -> Vec<WindowInfo> {
    // SAFETY: returns a +1 array (or null).
    let list = unsafe {
        CGWindowListCopyWindowInfo(
            kCGWindowListOptionOnScreenOnly | kCGWindowListExcludeDesktopElements,
            0,
        )
    };
    let Some(list) = Cf::owned(list as _) else {
        return Vec::new();
    };
    cf::array_items(list.raw())
        .iter()
        .filter_map(|entry| {
            let raw = entry.raw();
            let number = |key: &str| cf::to_f64(cf::dict_get(raw, key));
            let bounds = cf::dict_get(raw, "kCGWindowBounds");
            Some(WindowInfo {
                id: number("kCGWindowNumber")? as u32,
                pid: number("kCGWindowOwnerPID")? as i32,
                owner: cf::to_string(cf::dict_get(raw, "kCGWindowOwnerName")).unwrap_or_default(),
                bounds: Frame {
                    x: cf::to_f64(cf::dict_get(bounds, "X"))?,
                    y: cf::to_f64(cf::dict_get(bounds, "Y"))?,
                    width: cf::to_f64(cf::dict_get(bounds, "Width"))?,
                    height: cf::to_f64(cf::dict_get(bounds, "Height"))?,
                },
                layer: number("kCGWindowLayer").unwrap_or(0.0) as i64,
            })
        })
        .collect()
}

/// The app's normal window closest to `frame` (the AX window), else its frontmost one.
pub fn matching(windows: &[WindowInfo], pid: i32, frame: Option<Frame>) -> Option<WindowInfo> {
    let own: Vec<&WindowInfo> = windows
        .iter()
        .filter(|w| w.pid == pid && w.layer == 0 && w.bounds.width > 1.0 && w.bounds.height > 1.0)
        .collect();
    let distance = |w: &WindowInfo, f: &Frame| {
        (w.bounds.x - f.x).abs()
            + (w.bounds.y - f.y).abs()
            + (w.bounds.width - f.width).abs()
            + (w.bounds.height - f.height).abs()
    };
    match frame {
        Some(f) => own
            .iter()
            .min_by(|a, b| distance(a, &f).total_cmp(&distance(b, &f)))
            .map(|w| (*w).clone()),
        None => own.first().map(|w| (*w).clone()),
    }
}

/// Width and height from a JPEG's frame header.
pub fn jpeg_size(bytes: &[u8]) -> Option<(u32, u32)> {
    if bytes.get(..2)? != [0xFF, 0xD8] {
        return None;
    }
    let mut at = 2;
    while at + 9 < bytes.len() {
        if bytes[at] != 0xFF {
            return None;
        }
        let marker = bytes[at + 1];
        let length = u16::from_be_bytes([bytes[at + 2], bytes[at + 3]]) as usize;
        // SOF0–SOF15, except DHT (C4), JPG (C8) and DAC (CC).
        if (0xC0..=0xCF).contains(&marker) && !matches!(marker, 0xC4 | 0xC8 | 0xCC) {
            let height = u16::from_be_bytes([bytes[at + 5], bytes[at + 6]]) as u32;
            let width = u16::from_be_bytes([bytes[at + 7], bytes[at + 8]]) as u32;
            return Some((width, height));
        }
        at += 2 + length;
    }
    None
}

struct TempFile(PathBuf);

impl Drop for TempFile {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

fn temp_file(tag: &str) -> TempFile {
    let unique = format!(
        "mc-computer-{}-{}-{tag}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0)
    );
    TempFile(std::env::temp_dir().join(unique))
}

fn run(program: &str, args: &[&str]) -> Result<()> {
    let output = Command::new(program)
        .args(args)
        .output()
        .with_context(|| format!("run {program}"))?;
    if output.status.success() {
        Ok(())
    } else {
        Err(anyhow!(
            "{program} failed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ))
    }
}

fn path_str(path: &Path) -> Result<&str> {
    path.to_str()
        .ok_or_else(|| anyhow!("temporary path is not UTF-8"))
}

/// A JPEG of one window (no shadow), its long side at most [`MAX_SIDE`].
pub fn capture(window_id: u32) -> Result<Screenshot> {
    let shot = temp_file("shot.png");
    let small = temp_file("small.jpg");
    let id = window_id.to_string();
    run(
        "/usr/sbin/screencapture",
        &["-x", "-o", "-l", &id, "-t", "png", path_str(&shot.0)?],
    )?;
    let side = MAX_SIDE.to_string();
    run(
        "/usr/bin/sips",
        &[
            "-s",
            "format",
            "jpeg",
            "-s",
            "formatOptions",
            JPEG_QUALITY,
            "-Z",
            &side,
            path_str(&shot.0)?,
            "--out",
            path_str(&small.0)?,
        ],
    )?;
    let data = std::fs::read(&small.0).context("read screenshot")?;
    let (width, height) = jpeg_size(&data).ok_or_else(|| anyhow!("screenshot is not a JPEG"))?;
    Ok(Screenshot {
        data,
        mime: "image/jpeg",
        width,
        height,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn window(id: u32, pid: i32, x: f64, width: f64) -> WindowInfo {
        WindowInfo {
            id,
            pid,
            owner: "App".into(),
            bounds: Frame {
                x,
                y: 0.0,
                width,
                height: 100.0,
            },
            layer: 0,
        }
    }

    #[test]
    fn picks_the_window_closest_to_the_accessibility_frame() {
        let windows = vec![
            window(1, 9, 0.0, 300.0),
            window(2, 9, 500.0, 300.0),
            window(3, 4, 500.0, 300.0),
        ];
        let frame = Frame {
            x: 498.0,
            y: 0.0,
            width: 300.0,
            height: 100.0,
        };
        assert_eq!(matching(&windows, 9, Some(frame)).unwrap().id, 2);
        assert_eq!(matching(&windows, 9, None).unwrap().id, 1);
        assert!(matching(&windows, 5, None).is_none());
    }

    #[test]
    fn reads_jpeg_dimensions() {
        // SOI, an APP0 segment, then SOF0 with height 480 and width 640.
        let mut bytes = vec![0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x04, 0x00, 0x00];
        bytes.extend_from_slice(&[0xFF, 0xC0, 0x00, 0x11, 0x08, 0x01, 0xE0, 0x02, 0x80, 0x03]);
        bytes.extend_from_slice(&[0u8; 8]);
        assert_eq!(jpeg_size(&bytes), Some((640, 480)));
        assert_eq!(jpeg_size(b"nope"), None);
    }
}
