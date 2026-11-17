//! On-device text recognition via Apple's Vision framework (`VNRecognizeTextRequest`).

use std::ffi::{c_char, c_void, CStr};
use std::ptr::NonNull;

use anyhow::{anyhow, bail, Result};
use core_foundation_sys::base::{kCFAllocatorDefault, CFTypeRef};
use core_foundation_sys::data::{CFDataCreate, CFDataRef};

use super::cf;
use crate::backend::OcrLine;

type Id = *mut c_void;
type Sel = *mut c_void;

const RECOGNITION_LEVEL_ACCURATE: isize = 0;

#[repr(C)]
#[derive(Clone, Copy, Default)]
struct NSPoint {
    x: f64,
    y: f64,
}

#[repr(C)]
#[derive(Clone, Copy, Default)]
struct NSSize {
    width: f64,
    height: f64,
}

#[repr(C)]
#[derive(Clone, Copy, Default)]
struct NSRect {
    origin: NSPoint,
    size: NSSize,
}

#[link(name = "objc", kind = "dylib")]
extern "C" {
    fn objc_getClass(name: *const c_char) -> Id;
    fn sel_registerName(name: *const c_char) -> Sel;
    fn objc_msgSend();
    #[cfg(target_arch = "x86_64")]
    fn objc_msgSend_stret();
    fn objc_autoreleasePoolPush() -> *mut c_void;
    fn objc_autoreleasePoolPop(pool: *mut c_void);
}

#[link(name = "Foundation", kind = "framework")]
extern "C" {}

#[link(name = "Vision", kind = "framework")]
extern "C" {}

struct AutoreleasePool(*mut c_void);

impl AutoreleasePool {
    fn new() -> Self {
        // SAFETY: paired push/pop on the calling thread.
        Self(unsafe { objc_autoreleasePoolPush() })
    }
}

impl Drop for AutoreleasePool {
    fn drop(&mut self) {
        if !self.0.is_null() {
            // SAFETY: popped in LIFO order when the guard drops.
            unsafe { objc_autoreleasePoolPop(self.0) };
        }
    }
}

struct ObjcOwned(Id);

impl ObjcOwned {
    fn new(ptr: Id) -> Option<Self> {
        (!ptr.is_null()).then_some(Self(ptr))
    }

    fn raw(&self) -> Id {
        self.0
    }
}

impl Drop for ObjcOwned {
    fn drop(&mut self) {
        // SAFETY: owned +1 Objective-C object released once.
        unsafe { send_void(self.0, sel(c"release")) };
    }
}

fn cls(name: &CStr) -> Result<Id> {
    // SAFETY: valid static CStr passed to objc_getClass.
    let raw = unsafe { objc_getClass(name.as_ptr()) };
    if raw.is_null() {
        bail!(
            "Objective-C class {} is unavailable",
            name.to_string_lossy()
        );
    }
    Ok(raw)
}

fn sel(name: &CStr) -> Sel {
    // SAFETY: valid static CStr passed to sel_registerName.
    unsafe { sel_registerName(name.as_ptr()) }
}

unsafe fn send_void(obj: Id, s: Sel) {
    let f: unsafe extern "C" fn(Id, Sel) = std::mem::transmute(objc_msgSend as *const c_void);
    f(obj, s);
}

unsafe fn send_id0(obj: Id, s: Sel) -> Id {
    let f: unsafe extern "C" fn(Id, Sel) -> Id = std::mem::transmute(objc_msgSend as *const c_void);
    f(obj, s)
}

unsafe fn send_id1(obj: Id, s: Sel, arg: Id) -> Id {
    let f: unsafe extern "C" fn(Id, Sel, Id) -> Id =
        std::mem::transmute(objc_msgSend as *const c_void);
    f(obj, s, arg)
}

unsafe fn send_id2(obj: Id, s: Sel, a1: Id, a2: Id) -> Id {
    let f: unsafe extern "C" fn(Id, Sel, Id, Id) -> Id =
        std::mem::transmute(objc_msgSend as *const c_void);
    f(obj, s, a1, a2)
}

unsafe fn send_id_usize(obj: Id, s: Sel, index: usize) -> Id {
    let f: unsafe extern "C" fn(Id, Sel, usize) -> Id =
        std::mem::transmute(objc_msgSend as *const c_void);
    f(obj, s, index)
}

unsafe fn send_usize(obj: Id, s: Sel) -> usize {
    let f: unsafe extern "C" fn(Id, Sel) -> usize =
        std::mem::transmute(objc_msgSend as *const c_void);
    f(obj, s)
}

unsafe fn send_cstr(obj: Id, s: Sel) -> *const c_char {
    let f: unsafe extern "C" fn(Id, Sel) -> *const c_char =
        std::mem::transmute(objc_msgSend as *const c_void);
    f(obj, s)
}

unsafe fn send_set_isize(obj: Id, s: Sel, value: isize) {
    let f: unsafe extern "C" fn(Id, Sel, isize) =
        std::mem::transmute(objc_msgSend as *const c_void);
    f(obj, s, value);
}

unsafe fn send_set_bool(obj: Id, s: Sel, value: u8) {
    let f: unsafe extern "C" fn(Id, Sel, u8) = std::mem::transmute(objc_msgSend as *const c_void);
    f(obj, s, value);
}

unsafe fn send_responds(obj: Id, target_sel: Sel) -> bool {
    let f: unsafe extern "C" fn(Id, Sel, Sel) -> u8 =
        std::mem::transmute(objc_msgSend as *const c_void);
    f(obj, sel(c"respondsToSelector:"), target_sel) != 0
}

unsafe fn send_perform_requests(handler: Id, requests: Id, error: *mut Id) -> bool {
    let f: unsafe extern "C" fn(Id, Sel, Id, *mut Id) -> u8 =
        std::mem::transmute(objc_msgSend as *const c_void);
    f(handler, sel(c"performRequests:error:"), requests, error) != 0
}

unsafe fn send_bounding_box(obs: Id) -> NSRect {
    #[cfg(target_arch = "aarch64")]
    {
        let f: unsafe extern "C" fn(Id, Sel) -> NSRect =
            std::mem::transmute(objc_msgSend as *const c_void);
        f(obs, sel(c"boundingBox"))
    }
    #[cfg(target_arch = "x86_64")]
    {
        let mut rect = NSRect::default();
        let f: unsafe extern "C" fn(*mut NSRect, Id, Sel) =
            std::mem::transmute(objc_msgSend_stret as *const c_void);
        f(&mut rect, obs, sel(c"boundingBox"));
        rect
    }
}

fn ns_string_text(ns_string: Id) -> Option<String> {
    if ns_string.is_null() {
        return None;
    }
    // SAFETY: `ns_string` is an autoreleased/retained NSString; UTF8String is valid in the active pool.
    let ptr = unsafe { send_cstr(ns_string, sel(c"UTF8String")) };
    NonNull::new(ptr as *mut c_char).map(|non_null| {
        unsafe { CStr::from_ptr(non_null.as_ptr()) }
            .to_string_lossy()
            .into_owned()
    })
}

fn nserror_message(err: Id) -> String {
    if err.is_null() {
        return "unknown Vision error".into();
    }
    // SAFETY: valid NSError pointer populated by performRequests:error:.
    let desc = unsafe { send_id0(err, sel(c"localizedDescription")) };
    ns_string_text(desc).unwrap_or_else(|| "Vision OCR failed".into())
}

/// Convert a normalized bottom-left Vision bounding box into top-left window pixels.
pub fn to_pixel_rect(
    origin_x: f64,
    origin_y: f64,
    box_w: f64,
    box_h: f64,
    width: u32,
    height: u32,
) -> (u32, u32, u32, u32) {
    let fw = f64::from(width);
    let fh = f64::from(height);
    let px_x = (origin_x * fw).round().clamp(0.0, fw) as u32;
    let px_y = ((1.0 - origin_y - box_h) * fh).round().clamp(0.0, fh) as u32;
    let px_w = (box_w * fw).round().max(1.0).min(fw) as u32;
    let px_h = (box_h * fh).round().max(1.0).min(fh) as u32;
    (px_x, px_y, px_w, px_h)
}

/// Sort OCR detections in natural reading order (top-to-bottom rows, left-to-right within a row).
fn sort_reading_order(lines: &mut [OcrLine]) {
    lines.sort_by(|a, b| {
        let same_row = a.y.abs_diff(b.y) <= (a.height.min(b.height) / 2).max(4);
        if same_row {
            a.x.cmp(&b.x).then_with(|| a.y.cmp(&b.y))
        } else {
            a.y.cmp(&b.y).then_with(|| a.x.cmp(&b.x))
        }
    });
}

/// Run on-device `VNRecognizeTextRequest` against encoded image bytes (`JPEG`/`PNG`/`BMP`).
pub fn recognize(image_bytes: &[u8], width: u32, height: u32) -> Result<Vec<OcrLine>> {
    if image_bytes.is_empty() || width == 0 || height == 0 {
        bail!("cannot run OCR on an empty image");
    }
    let _pool = AutoreleasePool::new();
    let cf_data: CFDataRef = unsafe {
        CFDataCreate(
            kCFAllocatorDefault,
            image_bytes.as_ptr(),
            image_bytes.len() as isize,
        )
    };
    let data = cf::Cf::owned(cf_data as CFTypeRef)
        .ok_or_else(|| anyhow!("failed to wrap screenshot bytes for OCR"))?;

    let dict_cls = cls(c"NSDictionary")?;
    let handler_cls = cls(c"VNImageRequestHandler")?;
    let req_cls = cls(c"VNRecognizeTextRequest")?;
    let arr_cls = cls(c"NSArray")?;

    // SAFETY: Objective-C objects are properly retained/released inside the active autorelease pool.
    let handler = unsafe {
        let empty_opts = send_id0(dict_cls, sel(c"dictionary"));
        let alloc = send_id0(handler_cls, sel(c"alloc"));
        let raw = send_id2(
            alloc,
            sel(c"initWithData:options:"),
            data.raw() as Id,
            empty_opts,
        );
        ObjcOwned::new(raw).ok_or_else(|| anyhow!("Vision could not open the captured image"))?
    };

    let request = unsafe {
        let alloc = send_id0(req_cls, sel(c"alloc"));
        let raw = send_id0(alloc, sel(c"init"));
        ObjcOwned::new(raw).ok_or_else(|| anyhow!("failed to allocate VNRecognizeTextRequest"))?
    };

    let langs = cf::string_array(&["zh-Hans", "zh-Hant", "en-US"]);

    unsafe {
        send_set_isize(
            request.raw(),
            sel(c"setRecognitionLevel:"),
            RECOGNITION_LEVEL_ACCURATE,
        );
        send_set_bool(request.raw(), sel(c"setUsesLanguageCorrection:"), 1);
        let auto_sel = sel(c"setAutomaticallyDetectsLanguage:");
        if send_responds(request.raw(), auto_sel) {
            send_set_bool(request.raw(), auto_sel, 1);
        }
        send_id1(
            request.raw(),
            sel(c"setRecognitionLanguages:"),
            langs.raw() as Id,
        );

        let req_array = send_id1(arr_cls, sel(c"arrayWithObject:"), request.raw());
        let mut error_ptr: Id = std::ptr::null_mut();
        if !send_perform_requests(handler.raw(), req_array, &mut error_ptr) {
            bail!("Vision OCR failed: {}", nserror_message(error_ptr));
        }

        let results = send_id0(request.raw(), sel(c"results"));
        if results.is_null() {
            return Ok(Vec::new());
        }
        let count = send_usize(results, sel(c"count"));
        let mut out = Vec::with_capacity(count);
        for index in 0..count {
            let obs = send_id_usize(results, sel(c"objectAtIndex:"), index);
            if obs.is_null() {
                continue;
            }
            let candidates = send_id_usize(obs, sel(c"topCandidates:"), 1);
            if candidates.is_null() || send_usize(candidates, sel(c"count")) == 0 {
                continue;
            }
            let top = send_id_usize(candidates, sel(c"objectAtIndex:"), 0);
            let ns_str = send_id0(top, sel(c"string"));
            let Some(text) = ns_string_text(ns_str).map(|s| s.trim().to_string()) else {
                continue;
            };
            if text.is_empty() {
                continue;
            }
            let bbox = send_bounding_box(obs);
            let (x, y, w, h) = to_pixel_rect(
                bbox.origin.x,
                bbox.origin.y,
                bbox.size.width,
                bbox.size.height,
                width,
                height,
            );
            out.push(OcrLine {
                text,
                x,
                y,
                width: w,
                height: h,
            });
        }
        sort_reading_order(&mut out);
        Ok(out)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn glyph(ch: char) -> [u8; 7] {
        match ch {
            'S' => [
                0b01110, 0b10001, 0b10000, 0b01110, 0b00001, 0b10001, 0b01110,
            ],
            'A' => [
                0b01110, 0b10001, 0b10001, 0b11111, 0b10001, 0b10001, 0b10001,
            ],
            'F' => [
                0b11111, 0b10000, 0b10000, 0b11110, 0b10000, 0b10000, 0b10000,
            ],
            'E' => [
                0b11111, 0b10000, 0b10000, 0b11110, 0b10000, 0b10000, 0b11111,
            ],
            '2' => [
                0b01110, 0b10001, 0b00001, 0b00110, 0b01000, 0b10000, 0b11111,
            ],
            '0' => [
                0b01110, 0b10001, 0b10011, 0b10101, 0b11001, 0b10001, 0b01110,
            ],
            '4' => [
                0b00010, 0b00110, 0b01010, 0b10010, 0b11111, 0b00010, 0b00010,
            ],
            '8' => [
                0b01110, 0b10001, 0b10001, 0b01110, 0b10001, 0b10001, 0b01110,
            ],
            _ => [0; 7],
        }
    }

    fn render_bmp(
        text: &str,
        width: u32,
        height: u32,
        scale: u32,
        start_x: u32,
        start_y: u32,
    ) -> Vec<u8> {
        let stride = (width * 3).div_ceil(4) * 4;
        let mut pixels = vec![255u8; (stride * height) as usize];
        let mut cursor_x = start_x;
        for ch in text.chars() {
            let rows = glyph(ch);
            for (r, bits) in rows.iter().enumerate() {
                for c in 0..5u32 {
                    if (bits >> (4 - c)) & 1 == 1 {
                        for sy in 0..scale {
                            for sx in 0..scale {
                                let px = cursor_x + c * scale + sx;
                                let py = start_y + (r as u32) * scale + sy;
                                if px < width && py < height {
                                    let bmp_row = height - 1 - py;
                                    let idx = (bmp_row * stride + px * 3) as usize;
                                    pixels[idx] = 0;
                                    pixels[idx + 1] = 0;
                                    pixels[idx + 2] = 0;
                                }
                            }
                        }
                    }
                }
            }
            cursor_x += 7 * scale;
        }
        let image_size = stride * height;
        let file_size = 54 + image_size;
        let mut bmp = Vec::with_capacity(file_size as usize);
        bmp.extend_from_slice(b"BM");
        bmp.extend_from_slice(&file_size.to_le_bytes());
        bmp.extend_from_slice(&0u32.to_le_bytes());
        bmp.extend_from_slice(&54u32.to_le_bytes());
        bmp.extend_from_slice(&40u32.to_le_bytes());
        bmp.extend_from_slice(&width.to_le_bytes());
        bmp.extend_from_slice(&height.to_le_bytes());
        bmp.extend_from_slice(&1u16.to_le_bytes());
        bmp.extend_from_slice(&24u16.to_le_bytes());
        bmp.extend_from_slice(&0u32.to_le_bytes());
        bmp.extend_from_slice(&image_size.to_le_bytes());
        bmp.extend_from_slice(&2835u32.to_le_bytes());
        bmp.extend_from_slice(&2835u32.to_le_bytes());
        bmp.extend_from_slice(&0u64.to_le_bytes());
        bmp.extend_from_slice(&pixels);
        bmp
    }

    #[test]
    fn converts_vision_normalized_coordinates_to_top_left_pixels() {
        assert_eq!(
            to_pixel_rect(0.25, 0.25, 0.5, 0.25, 400, 200),
            (100, 100, 200, 50)
        );
    }

    #[test]
    fn recognizes_text_and_coordinates_in_memory_bitmap() {
        let bmp = render_bmp("SAFE 2048", 400, 120, 5, 30, 40);
        let lines = recognize(&bmp, 400, 120).expect("Vision OCR should run cleanly");
        let combined: String = lines
            .iter()
            .map(|line| line.text.as_str())
            .collect::<Vec<_>>()
            .join(" ");
        assert!(
            combined.contains("SAFE") && combined.contains("2048"),
            "unexpected Vision OCR output: {combined}"
        );
        let hit = lines
            .iter()
            .find(|line| line.text.contains("SAFE") || line.text.contains("2048"))
            .unwrap();
        assert!(
            hit.y >= 20 && hit.y <= 90,
            "expected y near painted text, got {}",
            hit.y
        );
    }
}
