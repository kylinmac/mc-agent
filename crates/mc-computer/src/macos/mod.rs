//! macOS backend: Accessibility for the UI tree and actions, CGEvent for
//! input, `screencapture` for window screenshots. All local.

mod ax;
mod cf;
mod ffi;
mod input;
mod windows;

use std::collections::HashMap;
use std::process::Command;
use std::thread::sleep;
use std::time::{Duration, Instant};

use anyhow::{anyhow, Result};
use core_foundation_sys::base::{kCFAllocatorDefault, CFTypeRef};
use core_foundation_sys::dictionary::{
    kCFTypeDictionaryKeyCallBacks, kCFTypeDictionaryValueCallBacks, CFDictionaryCreate,
};
use core_foundation_sys::number::{kCFBooleanFalse, kCFBooleanTrue};

use self::ax::Frame;
use self::cf::Cf;
use self::ffi::*;
use crate::backend::{
    AppInfo, AppState, Backend, Direction, MouseButton, Permissions, Point, Screenshot, Target,
};
use crate::keys::KeyChord;

/// Lines scrolled per "page".
const LINES_PER_PAGE: f64 = 8.0;
const LAUNCH_TIMEOUT: Duration = Duration::from_secs(8);

const ACCESSIBILITY_GUIDE: &str = "Accessibility is off: open System Settings → Privacy & Security → Accessibility and turn on mc-agent (a development build shows as PI-Desktop or Electron), then try again.";
const SCREEN_GUIDE: &str = "Screen Recording is off, so there is no screenshot: open System Settings → Privacy & Security → Screen & System Audio Recording and turn on mc-agent (PI-Desktop or Electron for a development build). The element tree still works.";
const LOCKED: &str = "The screen is locked, so app windows cannot be read or used. Ask the user to unlock the Mac, then try again.";

#[derive(Debug, Clone)]
struct RunningApp {
    pid: i32,
    name: String,
    path: Option<String>,
}

/// What the last state of an app left behind, so indices and pixels resolve.
struct Session {
    handles: Vec<Cf>,
    /// The window in screen points.
    window: Option<Frame>,
    /// The window server's id for it, for screenshots.
    window_id: Option<u32>,
    /// Pixel size of the screenshot the model saw, if any.
    shot: Option<(u32, u32)>,
}

pub struct MacBackend {
    sessions: HashMap<i32, Session>,
}

impl MacBackend {
    pub fn new() -> Self {
        Self {
            sessions: HashMap::new(),
        }
    }
}

fn accessibility_trusted(prompt: bool) -> bool {
    // SAFETY: a one-entry dictionary built from static CF constants.
    unsafe {
        let keys = [kAXTrustedCheckOptionPrompt as CFTypeRef];
        let values = [if prompt {
            kCFBooleanTrue
        } else {
            kCFBooleanFalse
        } as CFTypeRef];
        let options = CFDictionaryCreate(
            kCFAllocatorDefault,
            keys.as_ptr(),
            values.as_ptr(),
            1,
            &kCFTypeDictionaryKeyCallBacks,
            &kCFTypeDictionaryValueCallBacks,
        );
        let trusted = AXIsProcessTrustedWithOptions(options) != 0;
        if !options.is_null() {
            core_foundation_sys::base::CFRelease(options as CFTypeRef);
        }
        trusted
    }
}

fn screen_locked() -> bool {
    // SAFETY: returns a +1 dictionary (or null); read, then released.
    let session = unsafe { CGSessionCopyCurrentDictionary() };
    let Some(session) = Cf::owned(session as CFTypeRef) else {
        return false;
    };
    cf::to_bool(cf::dict_get(session.raw(), "CGSSessionScreenIsLocked")).unwrap_or(false)
}

/// Accessibility is on and the screen can be used.
fn require_accessibility() -> Result<()> {
    if !accessibility_trusted(false) {
        return Err(anyhow!(ACCESSIBILITY_GUIDE));
    }
    if screen_locked() {
        return Err(anyhow!(LOCKED));
    }
    Ok(())
}

/// The `.app` bundle a process runs from, if any.
fn bundle_path(pid: i32) -> Option<String> {
    let mut buffer = vec![0u8; libc::PROC_PIDPATHINFO_MAXSIZE as usize];
    // SAFETY: the buffer is as large as the call allows.
    let length =
        unsafe { libc::proc_pidpath(pid, buffer.as_mut_ptr() as *mut _, buffer.len() as u32) };
    if length <= 0 {
        return None;
    }
    buffer.truncate(length as usize);
    let path = String::from_utf8(buffer).ok()?;
    match path.find(".app/") {
        Some(end) => Some(path[..end + 4].to_string()),
        None => Some(path),
    }
}

fn bundle_stem(path: &str) -> Option<&str> {
    let name = path.rsplit('/').next()?;
    Some(name.strip_suffix(".app").unwrap_or(name))
}

fn frontmost_pid() -> Option<i32> {
    let system = ax::system_wide()?;
    let app = ax::attribute(system.raw(), "AXFocusedApplication")?;
    ax::pid(app.raw())
}

/// Apps with a normal on-screen window, front to back.
fn running_apps() -> Vec<RunningApp> {
    let mut seen = Vec::new();
    let mut apps = Vec::new();
    for window in windows::on_screen() {
        if window.layer != 0 || seen.contains(&window.pid) {
            continue;
        }
        seen.push(window.pid);
        apps.push(RunningApp {
            pid: window.pid,
            name: window.owner.clone(),
            path: bundle_path(window.pid),
        });
    }
    apps
}

/// Does `query` name this app? Pid, bundle path, display name or bundle file name.
fn names(app: &RunningApp, query: &str) -> bool {
    let query = query.trim();
    if let Ok(pid) = query.parse::<i32>() {
        return app.pid == pid;
    }
    if query.contains('/') {
        return app
            .path
            .as_deref()
            .is_some_and(|path| path.trim_end_matches('/') == query.trim_end_matches('/'));
    }
    let wanted = query.strip_suffix(".app").unwrap_or(query);
    app.name.eq_ignore_ascii_case(wanted)
        || app
            .path
            .as_deref()
            .and_then(bundle_stem)
            .is_some_and(|stem| stem.eq_ignore_ascii_case(wanted))
}

fn looks_like_bundle_id(query: &str) -> bool {
    query.contains('.')
        && !query.contains('/')
        && !query.contains(' ')
        && !query.ends_with(".app")
        && query.parse::<f64>().is_err()
}

/// Find the app, launching it when nothing running matches.
fn resolve(query: &str) -> Result<RunningApp> {
    let query = query.trim();
    if query.is_empty() {
        return Err(anyhow!("name the app"));
    }
    let before = running_apps();
    if let Some(app) = before.iter().find(|app| names(app, query)) {
        return Ok(app.clone());
    }
    if query.parse::<i32>().is_ok() {
        return Err(anyhow!("no app with a window has pid {query}"));
    }
    // Not visible: open it (this also unhides a hidden app or shows its window).
    let mut open = Command::new("/usr/bin/open");
    if query.contains('/') || query.ends_with(".app") && query.starts_with('/') {
        open.arg(query);
    } else if looks_like_bundle_id(query) {
        open.args(["-b", query]);
    } else {
        open.args(["-a", query]);
    }
    let output = open
        .output()
        .map_err(|error| anyhow!("could not open \"{query}\": {error}"))?;
    if !output.status.success() {
        return Err(anyhow!(
            "could not find or open the app \"{query}\": {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    let deadline = Instant::now() + LAUNCH_TIMEOUT;
    while Instant::now() < deadline {
        sleep(Duration::from_millis(250));
        let now = running_apps();
        if let Some(app) = now.iter().find(|app| names(app, query)) {
            return Ok(app.clone());
        }
        // A bundle id names nothing on screen; take the app that just came to the front.
        if let Some(front) = frontmost_pid() {
            if let Some(app) = now
                .iter()
                .find(|app| app.pid == front && !before.iter().any(|old| old.pid == front))
            {
                return Ok(app.clone());
            }
        }
    }
    Err(anyhow!(
        "\"{query}\" was opened but no window appeared within {} seconds",
        LAUNCH_TIMEOUT.as_secs()
    ))
}

fn activate(app: &RunningApp) {
    if frontmost_pid() == Some(app.pid) {
        return;
    }
    if let Some(element) = ax::application(app.pid) {
        if ax::set_frontmost(element.raw()).is_ok() {
            sleep(Duration::from_millis(150));
        }
    }
}

/// Screenshot pixels (or window points when no screenshot was taken) to screen points.
fn to_screen(session: &Session, point: Point) -> Result<CGPoint> {
    let window = session
        .window
        .ok_or_else(|| anyhow!("the window's position is unknown; take a new state"))?;
    let (sx, sy) = match session.shot {
        Some((width, height)) if width > 0 && height > 0 => {
            (window.width / width as f64, window.height / height as f64)
        }
        _ => (1.0, 1.0),
    };
    Ok(CGPoint {
        x: window.x + point.x * sx,
        y: window.y + point.y * sy,
    })
}

impl MacBackend {
    fn session(&self, app: &RunningApp) -> Result<&Session> {
        self.sessions
            .get(&app.pid)
            .ok_or_else(|| anyhow!("no state for {} yet: call get_app_state first", app.name))
    }

    fn handle(&self, app: &RunningApp, index: usize) -> Result<CFTypeRef> {
        let session = self.session(app)?;
        session.handles.get(index).map(Cf::raw).ok_or_else(|| {
            anyhow!(
                "element {index} is not in the latest state of {} (it has {})",
                app.name,
                session.handles.len()
            )
        })
    }

    fn point_of(&self, app: &RunningApp, target: Target) -> Result<CGPoint> {
        match target {
            Target::Point(point) => to_screen(self.session(app)?, point),
            Target::Element(index) => ax::frame(self.handle(app, index)?)
                .filter(|frame| frame.width > 0.0 && frame.height > 0.0)
                .map(|frame| frame.center())
                .ok_or_else(|| anyhow!("element {index} has no position on screen")),
        }
    }

    fn prepare(&self, app: &str) -> Result<RunningApp> {
        require_accessibility()?;
        let app = resolve(app)?;
        activate(&app);
        Ok(app)
    }
}

impl Backend for MacBackend {
    fn permissions(&mut self, request: bool) -> Result<Permissions> {
        let accessibility = accessibility_trusted(request);
        // SAFETY: plain queries.
        let mut screen_recording = unsafe { CGPreflightScreenCaptureAccess() };
        if request && !screen_recording {
            // SAFETY: shows the system prompt at most once per app.
            screen_recording = unsafe { CGRequestScreenCaptureAccess() };
        }
        let mut guidance = Vec::new();
        if !accessibility {
            guidance.push(ACCESSIBILITY_GUIDE.to_string());
            if request {
                let _ = Command::new("/usr/bin/open")
                    .arg("x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility")
                    .status();
            }
        }
        if !screen_recording {
            guidance.push(SCREEN_GUIDE.to_string());
            if request && accessibility {
                let _ = Command::new("/usr/bin/open")
                    .arg("x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture")
                    .status();
            }
        }
        if !guidance.is_empty() {
            guidance.push("A permission turned on while mc-agent is running may only take effect after restarting it.".into());
        }
        Ok(Permissions {
            accessibility,
            screen_recording,
            guidance,
        })
    }

    fn list_apps(&mut self) -> Result<Vec<AppInfo>> {
        let front = frontmost_pid();
        Ok(running_apps()
            .into_iter()
            .map(|app| AppInfo {
                frontmost: Some(app.pid) == front,
                name: app.name,
                pid: app.pid as i64,
                path: app.path,
            })
            .collect())
    }

    fn app_state(&mut self, app: &str) -> Result<AppState> {
        require_accessibility()?;
        let app = resolve(app)?;
        let element = ax::application(app.pid)
            .ok_or_else(|| anyhow!("cannot reach {} through accessibility", app.name))?;
        let mut window = ax::front_window(element.raw());
        if window.is_none() {
            activate(&app);
            sleep(Duration::from_millis(300));
            window = ax::front_window(element.raw());
        }
        let mut notes = Vec::new();
        let info = AppInfo {
            name: app.name.clone(),
            pid: app.pid as i64,
            path: app.path.clone(),
            frontmost: frontmost_pid() == Some(app.pid),
        };
        let Some(window) = window else {
            self.sessions.remove(&app.pid);
            notes.push("The app has no open window. Open one (e.g. press_key cmd+n) or check that it is not minimized.".into());
            return Ok(AppState {
                app: info,
                window_title: None,
                elements: vec![],
                notes,
            });
        };
        // While the screen is locked (or the session is otherwise cut off)
        // macOS answers for every window with the app itself.
        if ax::text(window.raw(), "AXRole").as_deref() == Some("AXApplication") {
            self.sessions.remove(&app.pid);
            return Err(anyhow!(if screen_locked() {
                LOCKED
            } else {
                "macOS is not showing this app's windows to accessibility right now (the screen may be locked or asleep). Ask the user to check the screen, then try again."
            }));
        }
        let title = ax::text(window.raw(), "AXTitle");
        let ax_frame = ax::frame(window.raw());
        // An open context menu belongs to the app, not the window.
        let mut roots = vec![window];
        roots.extend(
            ax::children(element.raw())
                .into_iter()
                .filter(|child| ax::text(child.raw(), "AXRole").as_deref() == Some("AXMenu")),
        );
        let (elements, handles, truncated) = ax::walk(roots);
        let cg_window = windows::matching(&windows::on_screen(), app.pid, ax_frame);
        if truncated {
            notes.push(format!(
                "The window has more than {} elements; only the first ones are listed. Scroll or narrow the view to reach the rest.",
                ax::MAX_ELEMENTS
            ));
        }
        let previous_shot = self.sessions.get(&app.pid).and_then(|session| session.shot);
        self.sessions.insert(
            app.pid,
            Session {
                handles,
                window: cg_window.as_ref().map(|window| window.bounds).or(ax_frame),
                window_id: cg_window.map(|window| window.id),
                // Coordinates keep meaning pixels of the last screenshot.
                shot: previous_shot,
            },
        );
        Ok(AppState {
            app: info,
            window_title: title,
            elements,
            notes,
        })
    }

    fn screenshot(&mut self, app: &str) -> Result<Screenshot> {
        // SAFETY: plain query.
        if !unsafe { CGPreflightScreenCaptureAccess() } {
            return Err(anyhow!(SCREEN_GUIDE));
        }
        if screen_locked() {
            return Err(anyhow!(LOCKED));
        }
        let app = resolve(app)?;
        let id = self
            .session(&app)?
            .window_id
            .ok_or_else(|| anyhow!("the window is not on screen"))?;
        let shot = windows::capture(id)?;
        if let Some(session) = self.sessions.get_mut(&app.pid) {
            session.shot = Some((shot.width, shot.height));
        }
        Ok(shot)
    }

    fn click(&mut self, app: &str, target: Target, button: MouseButton, count: u32) -> Result<()> {
        let app = self.prepare(app)?;
        if let Target::Element(index) = target {
            let handle = self.handle(&app, index)?;
            let actions = ax::actions(handle);
            // An element's own action works even when it is covered or off screen.
            let action = match (button, count) {
                (MouseButton::Left, 1) if actions.iter().any(|a| a == "AXPress") => Some("AXPress"),
                (MouseButton::Right, 1) if actions.iter().any(|a| a == "AXShowMenu") => {
                    Some("AXShowMenu")
                }
                _ => None,
            };
            if let Some(action) = action {
                if ax::perform(handle, action).is_ok() {
                    return Ok(());
                }
            }
        }
        let at = self.point_of(&app, target)?;
        input::click(at, button == MouseButton::Right, count)
    }

    fn drag(&mut self, app: &str, from: Point, to: Point) -> Result<()> {
        let app = self.prepare(app)?;
        let session = self.session(&app)?;
        input::drag(to_screen(session, from)?, to_screen(session, to)?)
    }

    fn type_text(&mut self, app: &str, text: &str) -> Result<()> {
        self.prepare(app)?;
        input::type_text(text)
    }

    fn press_key(&mut self, app: &str, chord: &KeyChord) -> Result<()> {
        self.prepare(app)?;
        input::press(chord)
    }

    fn scroll(
        &mut self,
        app: &str,
        target: Option<Target>,
        direction: Direction,
        pages: f64,
    ) -> Result<()> {
        let app = self.prepare(app)?;
        let at = match target {
            Some(target) => self.point_of(&app, target)?,
            None => self
                .session(&app)?
                .window
                .map(|window| window.center())
                .ok_or_else(|| anyhow!("the window's position is unknown; take a new state"))?,
        };
        let amount = (pages * LINES_PER_PAGE).round().max(1.0) as i32;
        let (lines, columns) = match direction {
            Direction::Up => (amount, 0),
            Direction::Down => (-amount, 0),
            Direction::Left => (0, amount),
            Direction::Right => (0, -amount),
        };
        input::scroll(at, lines, columns)
    }

    fn set_value(&mut self, app: &str, element: usize, value: &str) -> Result<()> {
        require_accessibility()?;
        let app = resolve(app)?;
        ax::set_string(self.handle(&app, element)?, "AXValue", value)
    }

    fn perform_action(&mut self, app: &str, element: usize, action: &str) -> Result<()> {
        require_accessibility()?;
        let app = resolve(app)?;
        let handle = self.handle(&app, element)?;
        let available = ax::actions(handle);
        // The state lists `Raise` for `AXRaise`, and an app's own action by its name.
        let wanted = action.trim();
        let found = available.iter().find(|name| {
            name.as_str() == wanted
                || name.strip_prefix("AX") == Some(wanted)
                || crate::render::action_name(name) == wanted
        });
        match found {
            Some(name) => ax::perform(handle, name),
            None => Err(anyhow!(
                "element {element} has no action \"{wanted}\"; it has: {}",
                available
                    .iter()
                    .map(|name| crate::render::action_name(name))
                    .collect::<Vec<_>>()
                    .join(", ")
            )),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn app(pid: i32, name: &str, path: Option<&str>) -> RunningApp {
        RunningApp {
            pid,
            name: name.into(),
            path: path.map(Into::into),
        }
    }

    #[test]
    fn apps_match_by_pid_path_name_or_bundle_name() {
        let calc = app(42, "计算器", Some("/System/Applications/Calculator.app"));
        assert!(names(&calc, "42"));
        assert!(names(&calc, "计算器"));
        assert!(names(&calc, "calculator"));
        assert!(names(&calc, "Calculator.app"));
        assert!(names(&calc, "/System/Applications/Calculator.app/"));
        assert!(!names(&calc, "Notes"));
        assert!(!names(&calc, "43"));
        assert!(looks_like_bundle_id("com.apple.calculator"));
        assert!(!looks_like_bundle_id("Calculator"));
        assert!(!looks_like_bundle_id("/Applications/Foo.app"));
        assert_eq!(
            bundle_stem("/System/Applications/Calculator.app"),
            Some("Calculator")
        );
    }

    #[test]
    fn screenshot_pixels_scale_to_screen_points() {
        let session = Session {
            handles: vec![],
            window_id: None,
            window: Some(Frame {
                x: 100.0,
                y: 50.0,
                width: 800.0,
                height: 600.0,
            }),
            shot: Some((1600, 1200)),
        };
        assert_eq!(
            to_screen(&session, Point { x: 400.0, y: 300.0 }).unwrap(),
            CGPoint { x: 300.0, y: 200.0 }
        );
        let unscaled = Session {
            shot: None,
            ..session
        };
        assert_eq!(
            to_screen(&unscaled, Point { x: 10.0, y: 10.0 }).unwrap(),
            CGPoint { x: 110.0, y: 60.0 }
        );
    }
}
