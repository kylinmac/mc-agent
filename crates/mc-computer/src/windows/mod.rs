//! Windows desktop backend. All privileged work stays in this MCP process.
mod capture;
mod input;
mod native;
mod uia;

use crate::{backend::*, keys::KeyChord};
use anyhow::{anyhow, bail, Result};
use std::collections::HashMap;
use std::time::{Duration, Instant};
use windows::Win32::{
    Foundation::RECT,
    UI::{
        Accessibility::IUIAutomationElement,
        HiDpi::{SetThreadDpiAwarenessContext, DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2},
    },
};

struct Session {
    window: native::Window,
    handles: Vec<IUIAutomationElement>,
    elements: Vec<Element>,
    shot: Option<(RECT, (u32, u32))>,
    read_at: Instant,
}

pub struct WindowsBackend {
    sessions: HashMap<String, Session>,
    // Drop sessions' COM elements before uninitializing the apartment.
    automation: Option<uia::Automation>,
}

impl WindowsBackend {
    pub fn new() -> Self {
        Self {
            sessions: HashMap::new(),
            automation: None,
        }
    }

    fn initialize(&mut self) -> Result<()> {
        if self.automation.is_none() {
            // UIA rectangles and GDI/Input all use physical pixels, including
            // mixed-DPI monitors. This affects only this dedicated MCP thread.
            let old =
                unsafe { SetThreadDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2) };
            if old.0.is_null() {
                bail!("Cannot enable physical-pixel coordinates on this Windows version");
            }
            self.automation = Some(uia::Automation::new()?);
        }
        Ok(())
    }

    fn automation(&self) -> Result<&uia::Automation> {
        self.automation
            .as_ref()
            .ok_or_else(|| anyhow!("Read get_app_state before sending input"))
    }

    fn session(&self, app: &str) -> Result<&Session> {
        let session = self
            .sessions
            .get(app)
            .ok_or_else(|| anyhow!("Read get_app_state for this app before acting"))?;
        native::check_window(&session.window)?;
        // The old root COM object must still identify the saved window.
        if let Some(root) = session.handles.first() {
            if unsafe { root.CurrentNativeWindowHandle()? } != session.window.hwnd {
                bail!("Window identity changed. Read a fresh state.");
            }
        }
        Ok(session)
    }

    fn element<'a>(&self, session: &'a Session, index: usize) -> Result<&'a IUIAutomationElement> {
        let node = session
            .handles
            .get(index)
            .ok_or_else(|| anyhow!("Invalid element_index; read a fresh state"))?;
        if i64::from(unsafe { node.CurrentProcessId()? }) != session.window.app.pid {
            bail!("Element belongs to another process");
        }
        Ok(node)
    }

    fn activate(&self, session: &Session) -> Result<()> {
        native::check_window(&session.window)?;
        if unsafe { windows::Win32::UI::WindowsAndMessaging::GetForegroundWindow() }
            != session.window.hwnd
        {
            if let Some(root) = session.handles.first() {
                unsafe {
                    root.SetFocus()?;
                }
            }
        }
        native::foreground(&session.window)
    }

    fn point(&self, session: &Session, target: Target) -> Result<Point> {
        let current = native::frame(session.window.hwnd)?;
        match target {
            Target::Point(point) => {
                let (rect, size) = session
                    .shot
                    .ok_or_else(|| anyhow!("Request a screenshot before using coordinates"))?;
                if rect != current {
                    bail!(
                        "Window moved or resized since the screenshot. Request a new screenshot."
                    );
                }
                capture::screenshot_point(rect, size, point)
            }
            Target::Element(index) => {
                let node = self.element(session, index)?;
                uia::require_editable_target(node)?;
                if unsafe { node.CurrentIsOffscreen()? }.as_bool() {
                    bail!("Element is offscreen; scroll it into view first");
                }
                let rect = unsafe { node.CurrentBoundingRectangle()? };
                if rect.right <= rect.left || rect.bottom <= rect.top {
                    bail!("Element has no clickable bounds");
                }
                Ok(Point {
                    x: (f64::from(rect.left) + f64::from(rect.right)) / 2.0,
                    y: (f64::from(rect.top) + f64::from(rect.bottom)) / 2.0,
                })
            }
        }
    }
}

impl Backend for WindowsBackend {
    fn permissions(&mut self, request: &PermissionRequest) -> Result<Permissions> {
        let desktop = native::desktop_ready();
        let available = desktop.is_ok();
        let mut guidance = vec!["Windows has no macOS-style Accessibility/Screen Recording grant. Only the unlocked interactive desktop and apps at the same or lower integrity level are supported; no elevation or secure-desktop bypass is attempted.".into()];
        if let Err(error) = desktop {
            guidance.push(error.to_string());
        }
        if !request.request.is_empty() || request.open_settings.is_some() {
            guidance.push("No system permission prompt/settings page applies on Windows. Unlock the desktop and use a non-elevated target app.".into());
        }
        Ok(Permissions {
            accessibility: available,
            screen_recording: available,
            checked_by: CheckedBy::this_process(),
            guidance,
            items: [
                PermissionItem::Accessibility,
                PermissionItem::ScreenRecording,
            ]
            .into_iter()
            .map(|item| PermissionCheck {
                item,
                granted: available,
                settings_opened: (request.open_settings == Some(item)).then_some(false),
                settings_path:
                    "Windows interactive desktop; target integrity is checked per operation".into(),
            })
            .collect(),
        })
    }

    fn list_apps(&mut self) -> Result<Vec<AppInfo>> {
        let mut seen = std::collections::HashSet::new();
        Ok(native::windows()?
            .into_iter()
            .filter(|w| seen.insert(w.app.pid))
            .map(|w| w.app)
            .collect())
    }

    fn app_state(&mut self, app: &str) -> Result<AppState> {
        self.initialize()?;
        // A failed refresh invalidates old IDs. Bound the native COM cache and
        // release references to closed windows instead of retaining them forever.
        let previous = self.sessions.remove(app);
        self.sessions.retain(|_, s| {
            s.read_at.elapsed() < Duration::from_secs(900)
                && unsafe { windows::Win32::UI::WindowsAndMessaging::IsWindow(Some(s.window.hwnd)) }
                    .as_bool()
        });
        if self.sessions.len() >= 32 {
            if let Some(oldest) = self
                .sessions
                .iter()
                .min_by_key(|(_, s)| s.read_at)
                .map(|(key, _)| key.clone())
            {
                self.sessions.remove(&oldest);
            }
        }
        let window = native::resolve(app)?;
        native::check_window(&window)?;
        let (elements, handles, mut notes) = self.automation()?.tree(window.hwnd)?;
        notes.push("Windows: screenshots show the visible foreground window (including occlusion). Coordinates need a screenshot and expire when the window moves/resizes. App names are executable names; use pid to disambiguate.".into());
        let current = native::frame(window.hwnd).ok();
        let shot = previous
            .as_ref()
            .filter(|s| s.window.hwnd == window.hwnd && s.window.app.pid == window.app.pid)
            .and_then(|s| s.shot)
            .filter(|(rect, _)| Some(*rect) == current);
        let result = AppState {
            app: window.app.clone(),
            window_title: Some(window.title.clone()),
            elements: elements.clone(),
            notes,
        };
        self.sessions.insert(
            app.into(),
            Session {
                window,
                handles,
                elements,
                shot,
                read_at: Instant::now(),
            },
        );
        Ok(result)
    }

    fn screenshot(&mut self, app: &str) -> Result<Screenshot> {
        let session = self.session(app)?;
        self.activate(session)?;
        let rect = native::frame(session.window.hwnd)?;
        let shot = capture::capture(rect)?;
        native::require_foreground(&session.window)?;
        if native::frame(session.window.hwnd)? != rect {
            bail!("Window moved during capture; retry");
        }
        self.sessions
            .get_mut(app)
            .ok_or_else(|| anyhow!("Session disappeared"))?
            .shot = Some((rect, (shot.width, shot.height)));
        Ok(shot)
    }

    fn click(&mut self, app: &str, target: Target, button: MouseButton, count: u32) -> Result<()> {
        let session = self.session(app)?;
        self.point(session, target)?;
        self.activate(session)?;
        input::click(&session.window, self.point(session, target)?, button, count)
    }
    fn drag(&mut self, app: &str, from: Point, to: Point) -> Result<()> {
        let session = self.session(app)?;
        self.point(session, Target::Point(from))?;
        self.point(session, Target::Point(to))?;
        self.activate(session)?;
        input::drag(
            &session.window,
            self.point(session, Target::Point(from))?,
            self.point(session, Target::Point(to))?,
        )
    }
    fn type_text(&mut self, app: &str, text: &str) -> Result<()> {
        let session = self.session(app)?;
        self.activate(session)?;
        input::text(&session.window, text, || {
            self.automation()?.check_focus(session.window.app.pid)
        })
    }
    fn press_key(&mut self, app: &str, chord: &KeyChord) -> Result<()> {
        let session = self.session(app)?;
        self.activate(session)?;
        self.automation()?.check_focus(session.window.app.pid)?;
        input::chord(&session.window, chord)
    }
    fn scroll(
        &mut self,
        app: &str,
        target: Option<Target>,
        direction: Direction,
        pages: f64,
    ) -> Result<()> {
        let session = self.session(app)?;
        self.activate(session)?;
        let point = if let Some(target) = target {
            self.point(session, target)?
        } else {
            let rect = native::frame(session.window.hwnd)?;
            Point {
                x: (f64::from(rect.left) + f64::from(rect.right)) / 2.0,
                y: (f64::from(rect.top) + f64::from(rect.bottom)) / 2.0,
            }
        };
        input::scroll(&session.window, point, direction, pages)
    }
    fn set_value(&mut self, app: &str, element: usize, value: &str) -> Result<()> {
        let session = self.session(app)?;
        self.activate(session)?;
        uia::set_value(self.element(session, element)?, value)
    }
    fn perform_action(&mut self, app: &str, element: usize, action: &str) -> Result<()> {
        let session = self.session(app)?;
        if !session
            .elements
            .get(element)
            .is_some_and(|e| e.actions.iter().any(|a| a == action))
        {
            bail!("Action was not offered for this element; read a fresh state");
        }
        self.activate(session)?;
        uia::action(self.element(session, element)?, action)
    }
}
