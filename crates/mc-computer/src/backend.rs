//! The platform boundary. Everything above it (tools, MCP, rendering) is
//! shared; a platform implements [`Backend`] and nothing else.
//!
//! Coordinates the model sees are screenshot pixels with the origin at the
//! window's top-left corner. A backend converts them to screen coordinates
//! with the scale of the last screenshot it took of that app.

use anyhow::Result;
use serde::Serialize;

use crate::keys::KeyChord;

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AppInfo {
    pub name: String,
    pub pid: i64,
    /// Bundle or executable path, when the platform reports one.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    pub frontmost: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Permissions {
    /// Reading the UI and sending input (macOS: Accessibility).
    pub accessibility: bool,
    /// Taking screenshots (macOS: Screen Recording).
    pub screen_recording: bool,
    /// What to do about a missing grant, in plain words.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub guidance: Vec<String>,
}

/// One UI element as the platform reports it, before rendering.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Element {
    pub depth: usize,
    pub role: String,
    pub subrole: Option<String>,
    pub title: Option<String>,
    pub value: Option<String>,
    pub description: Option<String>,
    pub placeholder: Option<String>,
    pub enabled: bool,
    pub focused: bool,
    pub selected: bool,
    pub actions: Vec<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Screenshot {
    pub png: Vec<u8>,
    pub width: u32,
    pub height: u32,
}

#[derive(Debug, Clone)]
pub struct AppState {
    pub app: AppInfo,
    pub window_title: Option<String>,
    /// Depth-first; an element's index is its position here.
    pub elements: Vec<Element>,
    /// Stopped early because the tree was larger than the limit.
    pub truncated: bool,
    pub screenshot: Option<Screenshot>,
    /// Things the model should know (missing permission, no window…).
    pub notes: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Point {
    pub x: f64,
    pub y: f64,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Target {
    /// Index from the app's latest state.
    Element(usize),
    /// Screenshot pixels, origin at the window's top-left.
    Point(Point),
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum MouseButton {
    Left,
    Right,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Direction {
    Up,
    Down,
    Left,
    Right,
}

pub trait Backend {
    fn permissions(&mut self, request: bool) -> Result<Permissions>;
    fn list_apps(&mut self) -> Result<Vec<AppInfo>>;
    /// The app's front window: element tree and screenshot. Launches the app
    /// when it is not running.
    fn app_state(&mut self, app: &str, screenshot: bool) -> Result<AppState>;
    fn click(&mut self, app: &str, target: Target, button: MouseButton, count: u32) -> Result<()>;
    fn drag(&mut self, app: &str, from: Point, to: Point) -> Result<()>;
    fn type_text(&mut self, app: &str, text: &str) -> Result<()>;
    fn press_key(&mut self, app: &str, chord: &KeyChord) -> Result<()>;
    fn scroll(
        &mut self,
        app: &str,
        target: Option<Target>,
        direction: Direction,
        pages: f64,
    ) -> Result<()>;
    fn set_value(&mut self, app: &str, element: usize, value: &str) -> Result<()>;
    fn perform_action(&mut self, app: &str, element: usize, action: &str) -> Result<()>;
    /// Let the UI settle after an action.
    fn settle(&mut self, millis: u64) {
        std::thread::sleep(std::time::Duration::from_millis(millis));
    }
}
