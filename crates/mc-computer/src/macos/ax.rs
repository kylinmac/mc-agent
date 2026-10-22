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

/// Attributes read for every element, in one request each (`Attrs` keeps
/// their order).
const ATTRIBUTES: [&str; 13] = [
    "AXRole",
    "AXSubrole",
    "AXTitle",
    "AXValue",
    "AXDescription",
    "AXHelp",
    "AXPlaceholderValue",
    "AXEnabled",
    "AXFocused",
    "AXSelected",
    "AXExpanded",
    "AXURL",
    "AXChildren",
];

/// Roles whose value the model may set directly.
const SETTABLE_ROLES: [&str; 8] = [
    "AXTextField",
    "AXTextArea",
    "AXComboBox",
    "AXCheckBox",
    "AXSlider",
    "AXIncrementor",
    "AXDateField",
    "AXSearchField",
];

/// Roles whose actions are only scrolling or plain press: not worth a request.
const NO_ACTION_ROLES: [&str; 10] = [
    "AXStaticText",
    "AXImage",
    "AXGroup",
    "AXScrollArea",
    "AXSplitGroup",
    "AXSplitter",
    "AXCell",
    "AXColumn",
    "AXLayoutArea",
    "AXUnknown",
];

/// The attribute names as one CFArray, reused for the whole walk.
pub struct Attrs {
    names: Cf,
    value_key: Cf,
}

impl Attrs {
    pub fn new() -> Self {
        Self {
            names: cf::string_array(&ATTRIBUTES),
            value_key: cf::string("AXValue"),
        }
    }
}

/// Every attribute in [`ATTRIBUTES`] order; `None` where the element has none.
fn read_all(element: CFTypeRef, attrs: &Attrs) -> Vec<Option<Cf>> {
    let mut values: CFArrayRef = std::ptr::null();
    // SAFETY: out-parameter receives a +1 array on success.
    let code = unsafe {
        AXUIElementCopyMultipleAttributeValues(
            element,
            attrs.names.raw() as CFArrayRef,
            0,
            &mut values,
        )
    };
    let batch = (code == kAXErrorSuccess)
        .then(|| Cf::owned(values as CFTypeRef))
        .flatten()
        .map(|values| cf::array_items(values.raw()))
        .filter(|items| items.len() == ATTRIBUTES.len());
    let Some(items) = batch else {
        // Some apps do not answer the batch request; ask one by one.
        return ATTRIBUTES
            .iter()
            .map(|name| attribute(element, name))
            .collect();
    };
    items
        .into_iter()
        .map(|value| {
            // SAFETY: type checked before reading the AXValue kind.
            let failed = unsafe {
                CFGetTypeID(value.raw()) == AXValueGetTypeID()
                    && AXValueGetType(value.raw()) == kAXValueAXErrorType
            };
            (!failed).then_some(value)
        })
        .collect()
}

fn settable(element: CFTypeRef, attrs: &Attrs) -> bool {
    let mut out = 0u8;
    // SAFETY: plain out-parameter; live element and key.
    let code = unsafe {
        AXUIElementIsAttributeSettable(element, attrs.value_key.raw() as CFStringRef, &mut out)
    };
    code == kAXErrorSuccess && out != 0
}

/// One element, and its children to walk.
fn describe(element: CFTypeRef, depth: usize, attrs: &Attrs) -> (Element, Vec<Cf>) {
    let values = read_all(element, attrs);
    let text = |i: usize| {
        values[i]
            .as_ref()
            .and_then(|value| cf::to_text(value.raw()))
            .filter(|text| !text.trim().is_empty())
    };
    let boolean = |i: usize| {
        values[i]
            .as_ref()
            .and_then(|value| cf::to_bool(value.raw()))
    };
    let role = text(0).unwrap_or_else(|| "AXUnknown".into());
    let subrole = text(1);
    let value = text(3);
    let children = if role == "AXColumn" {
        // A column repeats the cells its rows already list.
        Vec::new()
    } else {
        values[12]
            .as_ref()
            .map(|list| cf::array_items(list.raw()))
            .unwrap_or_default()
    };
    let settable_role =
        SETTABLE_ROLES.contains(&role.as_str()) || subrole.as_deref() == Some("AXSearchField");
    let element_out = Element {
        depth,
        title: text(2),
        // Secure fields report bullets; never echo their contents.
        value: if role == "AXSecureTextField" || subrole.as_deref() == Some("AXSecureTextField") {
            value.map(|_| "••••".into())
        } else {
            value
        },
        description: text(4).or_else(|| text(5)),
        placeholder: text(6),
        url: text(11),
        enabled: boolean(7).unwrap_or(true),
        focused: boolean(8).unwrap_or(false),
        selected: boolean(9).unwrap_or(false),
        expanded: boolean(10),
        settable: settable_role && settable(element, attrs),
        actions: if NO_ACTION_ROLES.contains(&role.as_str()) {
            Vec::new()
        } else {
            actions(element)
        },
        subrole,
        role,
    };
    (element_out, children)
}

/// Depth-first walk from `roots`: the described elements, the handles that
/// back their indices, and whether the walk stopped at the limit.
pub fn walk(roots: Vec<Cf>) -> (Vec<Element>, Vec<Cf>, bool) {
    let attrs = Attrs::new();
    let mut elements = Vec::new();
    let mut handles = Vec::new();
    let mut truncated = false;
    // Explicit stack, children pushed in reverse to keep document order.
    let mut stack: Vec<(Cf, usize)> = roots.into_iter().rev().map(|root| (root, 0)).collect();
    while let Some((element, depth)) = stack.pop() {
        if elements.len() >= MAX_ELEMENTS {
            truncated = true;
            break;
        }
        let (described, mut kids) = describe(element.raw(), depth, &attrs);
        elements.push(described);
        if depth < MAX_DEPTH {
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
