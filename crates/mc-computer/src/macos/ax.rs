//! Accessibility: reading attributes, walking the element tree, acting.

use std::ffi::c_void;

use anyhow::{anyhow, Result};
use core_foundation_sys::array::CFArrayRef;
use core_foundation_sys::base::{CFGetTypeID, CFTypeRef};
use core_foundation_sys::number::kCFBooleanTrue;
use core_foundation_sys::string::CFStringRef;

use super::cf::{self, Cf};
use super::ffi::*;
use crate::backend::Element;

/// Elements kept per state; larger trees are cut off.
pub const MAX_ELEMENTS: usize = 1200;
const MAX_DEPTH: usize = 48;
/// Children read per element (long lists and tables).
const MAX_CHILDREN: usize = 300;

/// A rectangle in screen points (top-left origin).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Frame {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

impl Frame {
    pub fn center(&self) -> CGPoint {
        CGPoint {
            x: self.x + self.width / 2.0,
            y: self.y + self.height / 2.0,
        }
    }
}

fn error_text(code: AXError) -> String {
    match code {
        code if code == kAXErrorAPIDisabled => "Accessibility permission is missing".into(),
        -25202 => "the element no longer exists (take a new state)".into(),
        -25204 => "the app is not responding to accessibility requests".into(),
        -25205 => "this attribute is not supported".into(),
        -25206 => "this action is not supported by the element".into(),
        -25200 => "the app refused the request".into(),
        other => format!("accessibility error {other}"),
    }
}

pub fn check(code: AXError, what: &str) -> Result<()> {
    if code == kAXErrorSuccess {
        Ok(())
    } else {
        Err(anyhow!("{what}: {}", error_text(code)))
    }
}

pub fn application(pid: i32) -> Option<Cf> {
    // SAFETY: returns a +1 element.
    let app = Cf::owned(unsafe { AXUIElementCreateApplication(pid) })?;
    // Do not let a hung app hang every call.
    // SAFETY: `app` is a live AX element.
    unsafe { AXUIElementSetMessagingTimeout(app.raw(), 1.5) };
    Some(app)
}

pub fn system_wide() -> Option<Cf> {
    // SAFETY: returns a +1 element.
    Cf::owned(unsafe { AXUIElementCreateSystemWide() })
}

/// An attribute's value (+1), if the element has it.
pub fn attribute(element: CFTypeRef, name: &str) -> Option<Cf> {
    let key = cf::string(name);
    let mut value: CFTypeRef = std::ptr::null();
    // SAFETY: out-parameter receives a +1 value on success.
    let code =
        unsafe { AXUIElementCopyAttributeValue(element, key.raw() as CFStringRef, &mut value) };
    if code == kAXErrorSuccess {
        Cf::owned(value)
    } else {
        None
    }
}

pub fn text(element: CFTypeRef, name: &str) -> Option<String> {
    attribute(element, name)
        .and_then(|value| cf::to_text(value.raw()))
        .filter(|text| !text.trim().is_empty())
}

pub fn flag(element: CFTypeRef, name: &str) -> Option<bool> {
    attribute(element, name).and_then(|value| cf::to_bool(value.raw()))
}

pub fn pid(element: CFTypeRef) -> Option<i32> {
    let mut pid = 0;
    // SAFETY: plain out-parameter.
    (unsafe { AXUIElementGetPid(element, &mut pid) } == kAXErrorSuccess).then_some(pid)
}

fn ax_value<T: Default>(value: &Cf, kind: u32) -> Option<T> {
    // SAFETY: AXValueGetValue writes a `T` matching `kind`.
    unsafe {
        if CFGetTypeID(value.raw()) != AXValueGetTypeID() {
            return None;
        }
        let mut out = T::default();
        (AXValueGetValue(value.raw(), kind, &mut out as *mut T as *mut c_void) != 0).then_some(out)
    }
}

pub fn frame(element: CFTypeRef) -> Option<Frame> {
    let position: CGPoint = ax_value(&attribute(element, "AXPosition")?, kAXValueCGPointType)?;
    let size: CGSize = ax_value(&attribute(element, "AXSize")?, kAXValueCGSizeType)?;
    Some(Frame {
        x: position.x,
        y: position.y,
        width: size.width,
        height: size.height,
    })
}

pub fn actions(element: CFTypeRef) -> Vec<String> {
    let mut names: CFArrayRef = std::ptr::null();
    // SAFETY: out-parameter receives a +1 array on success.
    if unsafe { AXUIElementCopyActionNames(element, &mut names) } != kAXErrorSuccess {
        return Vec::new();
    }
    let Some(names) = Cf::owned(names as CFTypeRef) else {
        return Vec::new();
    };
    cf::array_items(names.raw())
        .iter()
        .filter_map(|name| cf::to_string(name.raw()))
        .collect()
}

pub fn children(element: CFTypeRef) -> Vec<Cf> {
    attribute(element, "AXChildren")
        .map(|list| cf::array_items(list.raw()))
        .unwrap_or_default()
}

pub fn perform(element: CFTypeRef, action: &str) -> Result<()> {
    let name = cf::string(action);
    // SAFETY: live element and CFString.
    check(
        unsafe { AXUIElementPerformAction(element, name.raw() as CFStringRef) },
        action,
    )
}

pub fn set_string(element: CFTypeRef, attribute_name: &str, value: &str) -> Result<()> {
    let key = cf::string(attribute_name);
    let value = cf::string(value);
    // SAFETY: live element, key and value.
    check(
        unsafe { AXUIElementSetAttributeValue(element, key.raw() as CFStringRef, value.raw()) },
        "set value",
    )
}

/// Bring the app to the front (its own request, no window shuffling).
pub fn set_frontmost(app: CFTypeRef) -> Result<()> {
    let key = cf::string("AXFrontmost");
    // SAFETY: live element; kCFBooleanTrue is a static.
    check(
        unsafe {
            AXUIElementSetAttributeValue(app, key.raw() as CFStringRef, kCFBooleanTrue as CFTypeRef)
        },
        "bring the app to the front",
    )
}

/// The window to show: focused, else main, else the first one.
pub fn front_window(app: CFTypeRef) -> Option<Cf> {
    attribute(app, "AXFocusedWindow")
        .or_else(|| attribute(app, "AXMainWindow"))
        .or_else(|| {
            attribute(app, "AXWindows")
                .and_then(|list| cf::array_items(list.raw()).into_iter().next())
        })
}

fn describe(element: CFTypeRef, depth: usize) -> Element {
    let role = text(element, "AXRole").unwrap_or_else(|| "AXUnknown".into());
    let value = text(element, "AXValue");
    Element {
        depth,
        subrole: text(element, "AXSubrole"),
        title: text(element, "AXTitle"),
        // Secure fields report bullets; never echo their contents.
        value: if role == "AXSecureTextField" {
            value.map(|_| "••••".into())
        } else {
            value
        },
        description: text(element, "AXDescription").or_else(|| text(element, "AXHelp")),
        placeholder: text(element, "AXPlaceholderValue"),
        enabled: flag(element, "AXEnabled").unwrap_or(true),
        focused: flag(element, "AXFocused").unwrap_or(false),
        selected: flag(element, "AXSelected").unwrap_or(false),
        actions: actions(element),
        role,
    }
}

/// Depth-first walk from `root`: the described elements, the handles that
/// back their indices, and whether the walk stopped at the limit.
pub fn walk(root: Cf) -> (Vec<Element>, Vec<Cf>, bool) {
    let mut elements = Vec::new();
    let mut handles = Vec::new();
    let mut truncated = false;
    // Explicit stack, children pushed in reverse to keep document order.
    let mut stack: Vec<(Cf, usize)> = vec![(root, 0)];
    while let Some((element, depth)) = stack.pop() {
        if elements.len() >= MAX_ELEMENTS {
            truncated = true;
            break;
        }
        elements.push(describe(element.raw(), depth));
        if depth < MAX_DEPTH {
            let mut kids = children(element.raw());
            if kids.len() > MAX_CHILDREN {
                kids.truncate(MAX_CHILDREN);
                truncated = true;
            }
            for kid in kids.into_iter().rev() {
                stack.push((kid, depth + 1));
            }
        }
        handles.push(element);
    }
    (elements, handles, truncated)
}
