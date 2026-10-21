//! The few ApplicationServices / CoreGraphics functions this backend calls.

#![allow(non_upper_case_globals, non_snake_case)]

use std::ffi::c_void;

use core_foundation_sys::array::CFArrayRef;
use core_foundation_sys::base::{CFTypeID, CFTypeRef};
use core_foundation_sys::dictionary::CFDictionaryRef;
use core_foundation_sys::string::CFStringRef;

pub type AXUIElementRef = CFTypeRef;
pub type AXValueRef = CFTypeRef;
pub type AXError = i32;
pub type CGEventRef = *mut c_void;

pub const kAXErrorSuccess: AXError = 0;
pub const kAXErrorAPIDisabled: AXError = -25211;
pub const kAXValueCGPointType: u32 = 1;
pub const kAXValueCGSizeType: u32 = 2;

#[repr(C)]
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct CGPoint {
    pub x: f64,
    pub y: f64,
}

#[repr(C)]
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct CGSize {
    pub width: f64,
    pub height: f64,
}

// CGEventType
pub const kCGEventLeftMouseDown: u32 = 1;
pub const kCGEventLeftMouseUp: u32 = 2;
pub const kCGEventRightMouseDown: u32 = 3;
pub const kCGEventRightMouseUp: u32 = 4;
pub const kCGEventMouseMoved: u32 = 5;
pub const kCGEventLeftMouseDragged: u32 = 6;
// CGMouseButton
pub const kCGMouseButtonLeft: u32 = 0;
pub const kCGMouseButtonRight: u32 = 1;
// CGEventTapLocation
pub const kCGHIDEventTap: u32 = 0;
// CGEventField
pub const kCGMouseEventClickState: u32 = 1;
// CGScrollEventUnit
pub const kCGScrollEventUnitLine: u32 = 1;
// CGEventFlags
pub const kCGEventFlagMaskShift: u64 = 0x0002_0000;
pub const kCGEventFlagMaskControl: u64 = 0x0004_0000;
pub const kCGEventFlagMaskAlternate: u64 = 0x0008_0000;
pub const kCGEventFlagMaskCommand: u64 = 0x0010_0000;
// CGWindowListOption
pub const kCGWindowListOptionOnScreenOnly: u32 = 1;
pub const kCGWindowListExcludeDesktopElements: u32 = 16;

#[link(name = "ApplicationServices", kind = "framework")]
extern "C" {
    pub fn AXUIElementCreateApplication(pid: i32) -> AXUIElementRef;
    pub fn AXUIElementCreateSystemWide() -> AXUIElementRef;
    pub fn AXUIElementCopyAttributeValue(
        element: AXUIElementRef,
        attribute: CFStringRef,
        value: *mut CFTypeRef,
    ) -> AXError;
    pub fn AXUIElementCopyActionNames(element: AXUIElementRef, names: *mut CFArrayRef) -> AXError;
    pub fn AXUIElementSetAttributeValue(
        element: AXUIElementRef,
        attribute: CFStringRef,
        value: CFTypeRef,
    ) -> AXError;
    pub fn AXUIElementPerformAction(element: AXUIElementRef, action: CFStringRef) -> AXError;
    pub fn AXUIElementGetPid(element: AXUIElementRef, pid: *mut i32) -> AXError;
    pub fn AXUIElementSetMessagingTimeout(element: AXUIElementRef, seconds: f32) -> AXError;
    pub fn AXIsProcessTrustedWithOptions(options: CFDictionaryRef) -> u8;
    pub static kAXTrustedCheckOptionPrompt: CFStringRef;
    pub fn AXValueGetValue(value: AXValueRef, the_type: u32, out: *mut c_void) -> u8;
    pub fn AXValueGetTypeID() -> CFTypeID;
}

#[link(name = "CoreGraphics", kind = "framework")]
extern "C" {
    pub fn CGEventCreateMouseEvent(
        source: *const c_void,
        kind: u32,
        position: CGPoint,
        button: u32,
    ) -> CGEventRef;
    pub fn CGEventCreateKeyboardEvent(
        source: *const c_void,
        keycode: u16,
        key_down: bool,
    ) -> CGEventRef;
    pub fn CGEventKeyboardSetUnicodeString(event: CGEventRef, length: usize, text: *const u16);
    pub fn CGEventCreateScrollWheelEvent2(
        source: *const c_void,
        units: u32,
        wheel_count: u32,
        wheel1: i32,
        wheel2: i32,
        wheel3: i32,
    ) -> CGEventRef;
    pub fn CGEventSetFlags(event: CGEventRef, flags: u64);
    pub fn CGEventSetIntegerValueField(event: CGEventRef, field: u32, value: i64);
    pub fn CGEventPost(tap: u32, event: CGEventRef);
    pub fn CGWindowListCopyWindowInfo(option: u32, relative_to: u32) -> CFArrayRef;
    pub fn CGPreflightScreenCaptureAccess() -> bool;
    pub fn CGRequestScreenCaptureAccess() -> bool;
}
