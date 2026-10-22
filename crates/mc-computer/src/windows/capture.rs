//! Capture the visible foreground window, without invoking an app's PrintWindow
//! handler (which can hang indefinitely). Occlusion remains visible in the image.
use crate::backend::{Point, Screenshot};
use anyhow::{bail, Result};
use windows::Win32::{Foundation::RECT, Graphics::Gdi::*, UI::WindowsAndMessaging::*};

pub fn screenshot_point(rect: RECT, size: (u32, u32), point: Point) -> Result<Point> {
    if size.0 == 0
        || size.1 == 0
        || !point.x.is_finite()
        || !point.y.is_finite()
        || point.x < 0.0
        || point.y < 0.0
        || point.x >= f64::from(size.0)
        || point.y >= f64::from(size.1)
    {
        bail!("Point is outside the last screenshot");
    }
    Ok(Point {
        x: f64::from(rect.left) + point.x * f64::from(rect.right - rect.left) / f64::from(size.0),
        y: f64::from(rect.top) + point.y * f64::from(rect.bottom - rect.top) / f64::from(size.1),
    })
}

struct ScreenDc(HDC);
impl Drop for ScreenDc {
    fn drop(&mut self) {
        unsafe {
            ReleaseDC(None, self.0);
        }
    }
}
struct MemoryDc(HDC);
impl Drop for MemoryDc {
    fn drop(&mut self) {
        unsafe {
            let _ = DeleteDC(self.0);
        }
    }
}
struct Bitmap(HBITMAP);
impl Drop for Bitmap {
    fn drop(&mut self) {
        unsafe {
            let _ = DeleteObject(self.0.into());
        }
    }
}
struct Selection {
    dc: HDC,
    old: HGDIOBJ,
}
impl Drop for Selection {
    fn drop(&mut self) {
        unsafe {
            SelectObject(self.dc, self.old);
        }
    }
}

pub fn capture(rect: RECT) -> Result<Screenshot> {
    let width = rect.right - rect.left;
    let height = rect.bottom - rect.top;
    unsafe {
        let left = GetSystemMetrics(SM_XVIRTUALSCREEN);
        let top = GetSystemMetrics(SM_YVIRTUALSCREEN);
        if width <= 0
            || height <= 0
            || width > 16384
            || height > 16384
            || rect.left < left
            || rect.top < top
            || rect.right > left + GetSystemMetrics(SM_CXVIRTUALSCREEN)
            || rect.bottom > top + GetSystemMetrics(SM_CYVIRTUALSCREEN)
        {
            bail!("Window is partly outside the desktop or too large. Move/resize it fully onscreen and read again.");
        }
        let scale = (1280.0 / f64::from(width.max(height))).min(1.0);
        let w = (f64::from(width) * scale).round().max(1.0) as i32;
        let h = (f64::from(height) * scale).round().max(1.0) as i32;
        let screen = ScreenDc(GetDC(None));
        if screen.0.is_invalid() {
            bail!("Cannot acquire desktop pixels");
        }
        let memory = MemoryDc(CreateCompatibleDC(Some(screen.0)));
        if memory.0.is_invalid() {
            bail!("Cannot create capture DC");
        }
        let info = BITMAPINFO {
            bmiHeader: BITMAPINFOHEADER {
                biSize: size_of::<BITMAPINFOHEADER>() as u32,
                biWidth: w,
                biHeight: -h,
                biPlanes: 1,
                biBitCount: 32,
                biCompression: BI_RGB.0,
                ..Default::default()
            },
            ..Default::default()
        };
        let mut bits = std::ptr::null_mut();
        let bitmap = Bitmap(CreateDIBSection(
            Some(screen.0),
            &info,
            DIB_RGB_COLORS,
            &mut bits,
            None,
            0,
        )?);
        if bits.is_null() {
            bail!("Capture bitmap has no pixels");
        }
        let old = SelectObject(memory.0, bitmap.0.into());
        if old.is_invalid() {
            bail!("Cannot select capture bitmap");
        }
        let _selection = Selection { dc: memory.0, old };
        if SetStretchBltMode(memory.0, HALFTONE) == 0 {
            bail!("Cannot set capture scaling mode");
        }
        let _ = SetBrushOrgEx(memory.0, 0, 0, None);
        StretchBlt(
            memory.0,
            0,
            0,
            w,
            h,
            Some(screen.0),
            rect.left,
            rect.top,
            width,
            height,
            SRCCOPY | CAPTUREBLT,
        )
        .ok()?;
        GdiFlush().ok()?;
        let bgra = std::slice::from_raw_parts(bits.cast::<u8>(), (w * h * 4) as usize);
        let rgb: Vec<u8> = bgra
            .as_chunks::<4>()
            .0
            .iter()
            .flat_map(|p| [p[2], p[1], p[0]])
            .collect();
        let mut data = Vec::new();
        {
            let mut encoder = png::Encoder::new(&mut data, w as u32, h as u32);
            encoder.set_color(png::ColorType::Rgb);
            encoder.set_depth(png::BitDepth::Eight);
            encoder.write_header()?.write_image_data(&rgb)?;
        }
        Ok(Screenshot {
            data,
            mime: "image/png",
            width: w as u32,
            height: h as u32,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn maps_scaled_pixels_on_negative_origin_monitor() {
        let rect = RECT {
            left: -1920,
            top: -100,
            right: 0,
            bottom: 980,
        };
        assert_eq!(
            screenshot_point(rect, (1280, 720), Point { x: 640.0, y: 360.0 }).unwrap(),
            Point {
                x: -960.0,
                y: 440.0
            }
        );
        for p in [
            Point { x: -1.0, y: 0.0 },
            Point { x: 1280.0, y: 0.0 },
            Point {
                x: f64::NAN,
                y: 0.0,
            },
        ] {
            assert!(screenshot_point(rect, (1280, 720), p).is_err());
        }
    }
}
