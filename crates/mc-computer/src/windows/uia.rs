//! UI Automation on this thread's MTA. Cache a node's properties in one call.
use crate::backend::Element;
use anyhow::{bail, Result};
use std::time::{Duration, Instant};
use windows::{
    core::{Interface, BSTR},
    Win32::{
        Foundation::{E_POINTER, HWND},
        System::Com::*,
        UI::Accessibility::*,
    },
};

pub struct Automation {
    // Interfaces must be released before CoUninitialize.
    api: Option<IUIAutomation>,
}

impl Automation {
    pub fn new() -> Result<Self> {
        unsafe {
            CoInitializeEx(None, COINIT_MULTITHREADED).ok()?;
        }
        let mut owner = Self { api: None };
        unsafe {
            let api: IUIAutomation = CoCreateInstance(&CUIAutomation8, None, CLSCTX_INPROC_SERVER)?;
            let timeouts: IUIAutomation2 = api.cast()?;
            timeouts.SetConnectionTimeout(1000)?;
            timeouts.SetTransactionTimeout(1000)?;
            owner.api = Some(api);
        }
        Ok(owner)
    }

    pub fn tree(
        &self,
        hwnd: HWND,
    ) -> Result<(Vec<Element>, Vec<IUIAutomationElement>, Vec<String>)> {
        let api = self
            .api
            .as_ref()
            .ok_or_else(|| anyhow::anyhow!("UI Automation is closed"))?;
        unsafe {
            let cache = api.CreateCacheRequest()?;
            for property in [
                UIA_ToggleToggleStatePropertyId,
                UIA_ControlTypePropertyId,
                UIA_NamePropertyId,
                UIA_IsEnabledPropertyId,
                UIA_HasKeyboardFocusPropertyId,
                UIA_IsPasswordPropertyId,
                UIA_HelpTextPropertyId,
                UIA_IsOffscreenPropertyId,
                UIA_ValueValuePropertyId,
                UIA_ValueIsReadOnlyPropertyId,
                UIA_SelectionItemIsSelectedPropertyId,
                UIA_ExpandCollapseExpandCollapseStatePropertyId,
            ] {
                cache.AddProperty(property)?;
            }
            for pattern in [
                UIA_ValuePatternId,
                UIA_InvokePatternId,
                UIA_TogglePatternId,
                UIA_ExpandCollapsePatternId,
                UIA_SelectionItemPatternId,
                UIA_ScrollItemPatternId,
            ] {
                cache.AddPattern(pattern)?;
            }
            let root = api.ElementFromHandleBuildCache(hwnd, &cache)?;
            let walker = api.ControlViewWalker()?;
            let mut stack = vec![(root, 0)];
            let mut elements = Vec::new();
            let mut handles = Vec::new();
            let mut notes = Vec::new();
            let deadline = Instant::now() + Duration::from_secs(4);
            while let Some((node, depth)) = stack.pop() {
                if elements.len() >= 1200 || Instant::now() > deadline {
                    notes.push("UI tree truncated at its size/time limit; narrow the view or scroll and read again.".into());
                    break;
                }
                let password = node.CachedIsPassword()?.as_bool();
                let mut element = Element {
                    depth,
                    role: role(node.CachedControlType()?.0).into(),
                    title: nonempty(node.CachedName()?.to_string()),
                    enabled: node.CachedIsEnabled()?.as_bool(),
                    focused: node.CachedHasKeyboardFocus()?.as_bool(),
                    description: nonempty(node.CachedHelpText()?.to_string()),
                    ..Element::default()
                };
                if password {
                    element.description =
                        Some("Password field (contents hidden; user input only)".into());
                } else if let Ok(value) =
                    node.GetCachedPatternAs::<IUIAutomationValuePattern>(UIA_ValuePatternId)
                {
                    element.value = nonempty(value.CachedValue()?.to_string());
                    element.settable = !value.CachedIsReadOnly()?.as_bool();
                }
                if !password && element.enabled {
                    if node
                        .GetCachedPatternAs::<IUIAutomationInvokePattern>(UIA_InvokePatternId)
                        .is_ok()
                    {
                        element.actions.push("Invoke".into());
                    }
                    if let Ok(toggle) =
                        node.GetCachedPatternAs::<IUIAutomationTogglePattern>(UIA_TogglePatternId)
                    {
                        let state = toggle.CachedToggleState()?;
                        element.value = Some(
                            if state == ToggleState_On {
                                "on"
                            } else if state == ToggleState_Off {
                                "off"
                            } else {
                                "mixed"
                            }
                            .into(),
                        );
                        element.actions.push("Toggle".into());
                    }
                    if let Ok(pattern) = node
                        .GetCachedPatternAs::<IUIAutomationSelectionItemPattern>(
                            UIA_SelectionItemPatternId,
                        )
                    {
                        element.selected = pattern.CachedIsSelected()?.as_bool();
                        element.actions.push("Select".into());
                    }
                    if let Ok(pattern) = node
                        .GetCachedPatternAs::<IUIAutomationExpandCollapsePattern>(
                            UIA_ExpandCollapsePatternId,
                        )
                    {
                        let state = pattern.CachedExpandCollapseState()?;
                        if state != ExpandCollapseState_LeafNode {
                            element.expanded = Some(state == ExpandCollapseState_Expanded);
                            element.actions.extend(["Expand".into(), "Collapse".into()]);
                        }
                    }
                    if node
                        .GetCachedPatternAs::<IUIAutomationScrollItemPattern>(
                            UIA_ScrollItemPatternId,
                        )
                        .is_ok()
                    {
                        element.actions.push("ScrollIntoView".into());
                    }
                }
                elements.push(element);
                handles.push(node.clone());
                // Do not query siblings of the target root: that could request
                // cached properties from an unrelated application's window.
                if depth > 0 {
                    if let Some(sibling) =
                        optional(walker.GetNextSiblingElementBuildCache(&node, &cache))?
                    {
                        stack.push((sibling, depth));
                    }
                }
                if password {
                    continue;
                }
                if depth < 40 {
                    if let Some(child) =
                        optional(walker.GetFirstChildElementBuildCache(&node, &cache))?
                    {
                        stack.push((child, depth + 1));
                    }
                } else {
                    notes.push("UI tree depth limit reached.".into());
                }
            }
            Ok((elements, handles, notes))
        }
    }

    pub fn check_focus(&self, pid: i64) -> Result<()> {
        let api = self
            .api
            .as_ref()
            .ok_or_else(|| anyhow::anyhow!("UI Automation is closed"))?;
        unsafe {
            let focused = api.GetFocusedElement()?;
            if i64::from(focused.CurrentProcessId()?) != pid {
                bail!("Keyboard focus belongs to another process; input cancelled");
            }
            require_editable_target(&focused)?;
        }
        Ok(())
    }
}

impl Drop for Automation {
    fn drop(&mut self) {
        self.api.take();
        unsafe {
            CoUninitialize();
        }
    }
}

fn optional<T>(value: windows::core::Result<T>) -> Result<Option<T>> {
    // windows-rs represents the successful null COM pointer at the end of a
    // traversal as Error::empty (S_OK), as well as E_POINTER on older bindings.
    match value {
        Ok(value) => Ok(Some(value)),
        Err(e) if e.code() == E_POINTER || e.code().is_ok() => Ok(None),
        Err(e) => Err(e.into()),
    }
}
fn nonempty(value: String) -> Option<String> {
    if value.is_empty() {
        None
    } else {
        Some(value.chars().take(4000).collect())
    }
}

pub fn require_editable_target(node: &IUIAutomationElement) -> Result<()> {
    unsafe {
        if node.CurrentIsPassword()?.as_bool() {
            bail!("Password fields require the user; no automated input is sent");
        }
        if !node.CurrentIsEnabled()?.as_bool() {
            bail!("The element is disabled");
        }
    }
    Ok(())
}

pub fn set_value(node: &IUIAutomationElement, value: &str) -> Result<()> {
    require_editable_target(node)?;
    unsafe {
        let pattern: IUIAutomationValuePattern = node.GetCurrentPatternAs(UIA_ValuePatternId)?;
        if pattern.CurrentIsReadOnly()?.as_bool() {
            bail!("The element is read-only");
        }
        pattern.SetValue(&BSTR::from(value))?;
    }
    Ok(())
}

pub fn action(node: &IUIAutomationElement, action: &str) -> Result<()> {
    require_editable_target(node)?;
    unsafe {
        match action {
            "Invoke" => node
                .GetCurrentPatternAs::<IUIAutomationInvokePattern>(UIA_InvokePatternId)?
                .Invoke()?,
            "Toggle" => node
                .GetCurrentPatternAs::<IUIAutomationTogglePattern>(UIA_TogglePatternId)?
                .Toggle()?,
            "Select" => node
                .GetCurrentPatternAs::<IUIAutomationSelectionItemPattern>(
                    UIA_SelectionItemPatternId,
                )?
                .Select()?,
            "Expand" => node
                .GetCurrentPatternAs::<IUIAutomationExpandCollapsePattern>(
                    UIA_ExpandCollapsePatternId,
                )?
                .Expand()?,
            "Collapse" => node
                .GetCurrentPatternAs::<IUIAutomationExpandCollapsePattern>(
                    UIA_ExpandCollapsePatternId,
                )?
                .Collapse()?,
            "ScrollIntoView" => node
                .GetCurrentPatternAs::<IUIAutomationScrollItemPattern>(UIA_ScrollItemPatternId)?
                .ScrollIntoView()?,
            _ => bail!("Unsupported action; use an action listed in the latest state"),
        }
    }
    Ok(())
}

fn role(id: i32) -> &'static str {
    match id {
        50000 => "button",
        50001 => "calendar",
        50002 => "checkbox",
        50003 => "combo box",
        50004 => "text field",
        50005 => "link",
        50006 => "image",
        50007 => "list item",
        50008 => "list",
        50009 => "menu",
        50010 => "menu bar",
        50011 => "menu item",
        50012 => "progress indicator",
        50013 => "radio button",
        50014 => "scroll bar",
        50015 => "slider",
        50016 => "spinner",
        50017 => "status bar",
        50018 => "tab group",
        50019 => "tab",
        50020 => "text",
        50021 => "toolbar",
        50022 => "tooltip",
        50023 => "tree",
        50024 => "tree item",
        50028 => "data grid",
        50029 => "data item",
        50030 => "document",
        50032 => "window",
        50033 => "pane",
        50034 => "header",
        50035 => "header item",
        50036 => "table",
        50037 => "title bar",
        50038 => "separator",
        _ => "group",
    }
}
