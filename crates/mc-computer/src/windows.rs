//! Windows backend — reserved (docs/mc-agent/computer-use.md).
//!
//! To implement, fill in [`Backend`] with:
//! - apps: `EnumWindows` + `GetWindowThreadProcessId`, `QueryFullProcessImageNameW`;
//!   foreground via `GetForegroundWindow`; launch with `ShellExecuteW`.
//! - elements: UI Automation (`IUIAutomation::ElementFromHandle`, a
//!   `TreeWalker` over the control view); map `ControlType` to the role,
//!   `Name` to the title, the Value / Toggle / SelectionItem patterns to value
//!   and state, and the supported patterns to actions (Invoke, Toggle,
//!   ExpandCollapse, …). Keep the last walk's elements so indices resolve.
//! - screenshots: `Windows.Graphics.Capture` (or `PrintWindow` as a fallback)
//!   of the window, encoded as PNG, with its size for coordinate scaling.
//! - input: `SendInput` (mouse in absolute coordinates, keys as virtual-key
//!   codes; text as `KEYEVENTF_UNICODE`), after `SetForegroundWindow`.
//! - values / actions: `ValuePattern::SetValue`, `InvokePattern::Invoke`, …
//! - permissions: none at the OS level for the same integrity level; report
//!   when the target runs elevated and input would be refused (UIPI).
//!
//! Until then every tool reports that this platform is not supported yet.

use anyhow::{anyhow, Result};

use crate::backend::{
    AppInfo, AppState, Backend, Direction, MouseButton, PermissionRequest, Permissions, Point,
    Screenshot, Target,
};
use crate::keys::KeyChord;

pub struct WindowsBackend;

impl WindowsBackend {
    pub fn new() -> Self {
        Self
    }
}

fn not_yet<T>() -> Result<T> {
    Err(anyhow!("Computer Use is not available on Windows yet."))
}

impl Backend for WindowsBackend {
    fn permissions(&mut self, _request: &PermissionRequest) -> Result<Permissions> {
        not_yet()
    }
    fn list_apps(&mut self) -> Result<Vec<AppInfo>> {
        not_yet()
    }
    fn app_state(&mut self, _app: &str) -> Result<AppState> {
        not_yet()
    }
    fn screenshot(&mut self, _app: &str) -> Result<Screenshot> {
        not_yet()
    }
    fn click(
        &mut self,
        _app: &str,
        _target: Target,
        _button: MouseButton,
        _count: u32,
    ) -> Result<()> {
        not_yet()
    }
    fn drag(&mut self, _app: &str, _from: Point, _to: Point) -> Result<()> {
        not_yet()
    }
    fn type_text(&mut self, _app: &str, _text: &str) -> Result<()> {
        not_yet()
    }
    fn press_key(&mut self, _app: &str, _chord: &KeyChord) -> Result<()> {
        not_yet()
    }
    fn scroll(
        &mut self,
        _app: &str,
        _target: Option<Target>,
        _direction: Direction,
        _pages: f64,
    ) -> Result<()> {
        not_yet()
    }
    fn set_value(&mut self, _app: &str, _element: usize, _value: &str) -> Result<()> {
        not_yet()
    }
    fn perform_action(&mut self, _app: &str, _element: usize, _action: &str) -> Result<()> {
        not_yet()
    }
}
