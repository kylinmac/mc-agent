//! Platforms without a backend: every tool says so.

use anyhow::{anyhow, Result};

use crate::backend::{
    AppInfo, AppState, Backend, Direction, MouseButton, Permissions, Point, Screenshot, Target,
};
use crate::keys::KeyChord;

pub struct Unsupported;

fn not_yet<T>() -> Result<T> {
    Err(anyhow!("Computer Use is not available on this platform."))
}

impl Backend for Unsupported {
    fn permissions(&mut self, _request: bool) -> Result<Permissions> {
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
