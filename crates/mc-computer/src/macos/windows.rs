//! Window list (CGWindowList) and window screenshots (`screencapture`).

use std::path::{Path, PathBuf};
use std::process::Command;

use anyhow::{anyhow, Context, Result};

use super::ax::Frame;
use super::cf::{self, Cf};
use super::ffi::*;
use crate::backend::Screenshot;

/// Longest screenshot side sent to the model.
const MAX_SIDE: u32 = 1600;

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

/// Width and height from a PNG header.
pub fn png_size(bytes: &[u8]) -> Option<(u32, u32)> {
    if bytes.len() < 24 || &bytes[..8] != b"\x89PNG\r\n\x1a\n" || &bytes[12..16] != b"IHDR" {
        return None;
    }
    let width = u32::from_be_bytes(bytes[16..20].try_into().ok()?);
    let height = u32::from_be_bytes(bytes[20..24].try_into().ok()?);
    Some((width, height))
}

struct TempFile(PathBuf);

impl Drop for TempFile {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

fn temp_png(tag: &str) -> TempFile {
    let unique = format!(
        "mc-computer-{}-{}-{tag}.png",
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

/// A PNG of one window (no shadow), scaled down so its long side fits.
pub fn capture(window_id: u32) -> Result<Screenshot> {
    let shot = temp_png("shot");
    let id = window_id.to_string();
    run(
        "/usr/sbin/screencapture",
        &["-x", "-o", "-l", &id, "-t", "png", path_str(&shot.0)?],
    )?;
    let mut target = &shot;
    let scaled = temp_png("scaled");
    let bytes = std::fs::read(&shot.0).context("read screenshot")?;
    let (width, height) = png_size(&bytes).ok_or_else(|| anyhow!("screenshot is not a PNG"))?;
    if width.max(height) > MAX_SIDE {
        run(
            "/usr/bin/sips",
            &[
                "-Z",
                &MAX_SIDE.to_string(),
                path_str(&shot.0)?,
                "--out",
                path_str(&scaled.0)?,
            ],
        )?;
        target = &scaled;
    }
    let png = if std::ptr::eq(target, &shot) {
        bytes
    } else {
        std::fs::read(&target.0).context("read scaled screenshot")?
    };
    let (width, height) =
        png_size(&png).ok_or_else(|| anyhow!("scaled screenshot is not a PNG"))?;
    Ok(Screenshot { png, width, height })
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
    fn reads_png_dimensions() {
        let mut header = b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR".to_vec();
        header.extend_from_slice(&640u32.to_be_bytes());
        header.extend_from_slice(&480u32.to_be_bytes());
        assert_eq!(png_size(&header), Some((640, 480)));
        assert_eq!(png_size(b"nope"), None);
    }
}
