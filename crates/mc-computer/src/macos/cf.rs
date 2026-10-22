//! Core Foundation plumbing: an owning handle and conversions to Rust values.

use std::ffi::c_void;

use core_foundation_sys::array::{
    kCFTypeArrayCallBacks, CFArrayCreate, CFArrayGetCount, CFArrayGetTypeID,
    CFArrayGetValueAtIndex, CFArrayRef,
};
use core_foundation_sys::base::{kCFAllocatorDefault, CFGetTypeID, CFRelease, CFRetain, CFTypeRef};
use core_foundation_sys::dictionary::{
    CFDictionaryGetTypeID, CFDictionaryGetValue, CFDictionaryRef,
};
use core_foundation_sys::number::{
    kCFNumberFloat64Type, CFBooleanGetTypeID, CFBooleanGetValue, CFBooleanRef, CFNumberGetTypeID,
    CFNumberGetValue, CFNumberRef,
};
use core_foundation_sys::string::{
    kCFStringEncodingUTF8, CFStringCreateWithBytes, CFStringGetCString, CFStringGetLength,
    CFStringGetMaximumSizeForEncoding, CFStringGetTypeID, CFStringRef,
};

/// An owned (+1) Core Foundation object, released on drop.
pub struct Cf(CFTypeRef);

impl Cf {
    /// Take ownership of a +1 reference; `None` for null.
    pub fn owned(raw: CFTypeRef) -> Option<Self> {
        (!raw.is_null()).then_some(Self(raw))
    }

    /// Retain a borrowed (+0) reference.
    pub fn retained(raw: CFTypeRef) -> Option<Self> {
        if raw.is_null() {
            return None;
        }
        // SAFETY: `raw` is a live CF object borrowed from its container.
        Some(Self(unsafe { CFRetain(raw) }))
    }

    pub fn raw(&self) -> CFTypeRef {
        self.0
    }
}

impl Drop for Cf {
    fn drop(&mut self) {
        // SAFETY: we hold exactly one reference.
        unsafe { CFRelease(self.0) }
    }
}

/// A new CFString.
pub fn string(text: &str) -> Cf {
    // SAFETY: the bytes outlive the call; CF copies them.
    let raw = unsafe {
        CFStringCreateWithBytes(
            kCFAllocatorDefault,
            text.as_ptr(),
            text.len() as isize,
            kCFStringEncodingUTF8,
            0,
        )
    };
    Cf::owned(raw as CFTypeRef).unwrap_or_else(|| string("?"))
}

fn is(raw: CFTypeRef, type_id: core_foundation_sys::base::CFTypeID) -> bool {
    // SAFETY: `raw` is non-null and a CF object.
    !raw.is_null() && unsafe { CFGetTypeID(raw) } == type_id
}

/// The text of a CFString, or `None` for anything else.
pub fn to_string(raw: CFTypeRef) -> Option<String> {
    // SAFETY: type checked before use as a CFString.
    unsafe {
        if !is(raw, CFStringGetTypeID()) {
            return None;
        }
        let string = raw as CFStringRef;
        let length = CFStringGetLength(string);
        let capacity = CFStringGetMaximumSizeForEncoding(length, kCFStringEncodingUTF8) + 1;
        let mut buffer = vec![0u8; capacity.max(1) as usize];
        if CFStringGetCString(
            string,
            buffer.as_mut_ptr() as *mut _,
            capacity,
            kCFStringEncodingUTF8,
        ) == 0
        {
            return None;
        }
        let end = buffer
            .iter()
            .position(|byte| *byte == 0)
            .unwrap_or(buffer.len());
        buffer.truncate(end);
        String::from_utf8(buffer).ok()
    }
}

pub fn to_f64(raw: CFTypeRef) -> Option<f64> {
    // SAFETY: type checked before use as a CFNumber.
    unsafe {
        if !is(raw, CFNumberGetTypeID()) {
            return None;
        }
        let mut value = 0f64;
        CFNumberGetValue(
            raw as CFNumberRef,
            kCFNumberFloat64Type,
            &mut value as *mut f64 as *mut c_void,
        )
        .then_some(value)
    }
}

pub fn to_bool(raw: CFTypeRef) -> Option<bool> {
    // SAFETY: type checked before use as a CFBoolean.
    unsafe { is(raw, CFBooleanGetTypeID()).then(|| CFBooleanGetValue(raw as CFBooleanRef)) }
}

/// A new CFArray of CFStrings.
pub fn string_array(items: &[&str]) -> Cf {
    let strings: Vec<Cf> = items.iter().map(|item| string(item)).collect();
    let raws: Vec<CFTypeRef> = strings.iter().map(Cf::raw).collect();
    // SAFETY: the array retains its items; `strings` releases ours after.
    let array = unsafe {
        CFArrayCreate(
            kCFAllocatorDefault,
            raws.as_ptr(),
            raws.len() as isize,
            &kCFTypeArrayCallBacks,
        )
    };
    Cf::owned(array as CFTypeRef).expect("CFArrayCreate")
}

/// The string form of a CFURL.
fn url_text(raw: CFTypeRef) -> Option<String> {
    use core_foundation_sys::url::{CFURLGetString, CFURLGetTypeID};
    // SAFETY: type checked; CFURLGetString returns a borrowed string.
    unsafe {
        if !is(raw, CFURLGetTypeID()) {
            return None;
        }
        to_string(CFURLGetString(raw as _) as CFTypeRef)
    }
}

/// A short text form of a string, URL, number or boolean value.
pub fn to_text(raw: CFTypeRef) -> Option<String> {
    if let Some(text) = to_string(raw) {
        return Some(text);
    }
    if let Some(url) = url_text(raw) {
        return Some(url);
    }
    if let Some(flag) = to_bool(raw) {
        return Some(flag.to_string());
    }
    to_f64(raw).map(|number| {
        if number.fract() == 0.0 && number.abs() < 1e15 {
            format!("{}", number as i64)
        } else {
            format!("{number}")
        }
    })
}

/// The items of a CFArray, each retained.
pub fn array_items(raw: CFTypeRef) -> Vec<Cf> {
    // SAFETY: type checked before use as a CFArray; items are retained.
    unsafe {
        if !is(raw, CFArrayGetTypeID()) {
            return Vec::new();
        }
        let array = raw as CFArrayRef;
        (0..CFArrayGetCount(array))
            .filter_map(|index| Cf::retained(CFArrayGetValueAtIndex(array, index)))
            .collect()
    }
}

/// A value of a CFDictionary by string key (borrowed, +0).
pub fn dict_get(raw: CFTypeRef, key: &str) -> CFTypeRef {
    // SAFETY: type checked before use as a CFDictionary.
    unsafe {
        if !is(raw, CFDictionaryGetTypeID()) {
            return std::ptr::null();
        }
        let key = string(key);
        CFDictionaryGetValue(raw as CFDictionaryRef, key.raw())
    }
}
