//! macOS backend: Accessibility for the UI tree and actions, CGEvent for
//! input, `screencapture` for window screenshots. All local.

mod ax;
mod cf;
mod ffi;
mod input;
mod menu;
mod ocr;
mod windows;

use std::collections::{HashMap, HashSet};
use std::process::Command;
use std::thread::sleep;
use std::time::{Duration, Instant};

use anyhow::{anyhow, bail, Result};
use core_foundation_sys::base::{kCFAllocatorDefault, CFTypeRef};
use core_foundation_sys::dictionary::{
    kCFTypeDictionaryKeyCallBacks, kCFTypeDictionaryValueCallBacks, CFDictionaryCreate,
};
use core_foundation_sys::number::{kCFBooleanFalse, kCFBooleanTrue};

use self::ax::Frame;
use self::cf::Cf;
use self::ffi::*;
use crate::backend::{
    AppInfo, AppState, Backend, CheckedBy, Direction, MouseButton, OcrLine, PermissionCheck,
    PermissionItem, PermissionRequest, Permissions, Point, Screenshot, Target,
};
use crate::keys::KeyChord;

/// Lines scrolled per "page".
const LINES_PER_PAGE: f64 = 8.0;
const LAUNCH_TIMEOUT: Duration = Duration::from_secs(8);
const SESSION_TTL: Duration = Duration::from_secs(900);
const MAX_SESSIONS: usize = 32;

const ACCESSIBILITY_GUIDE: &str = "Accessibility is off: open System Settings → Privacy & Security → Accessibility and turn on mc-agent (a development build shows as mc-agent Dev), then try again. mc-agent → Settings → System permissions opens the right page.";
const SCREEN_GUIDE: &str = "Screen Recording is off, so there is no screenshot: open System Settings → Privacy & Security → Screen & System Audio Recording and turn on mc-agent (mc-agent Dev for a development build). The element tree still works.";
const ACCESSIBILITY_PATH: &str = "System Settings → Privacy & Security → Accessibility";
const SCREEN_PATH: &str = "System Settings → Privacy & Security → Screen & System Audio Recording";

/// Open one permission's settings page; false when `open` failed.
fn open_settings(item: PermissionItem) -> bool {
    let url = match item {
        PermissionItem::Accessibility => {
            "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility"
        }
        PermissionItem::ScreenRecording => {
            "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture"
        }
    };
    Command::new("/usr/bin/open")
        .arg(url)
        .status()
        .is_ok_and(|status| status.success())
}

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
    /// Window bounds at capture time and pixel size of the last screenshot/OCR.
    shot: Option<(Frame, (u32, u32))>,
    read_at: Instant,
}

pub struct MacBackend {
    sessions: HashMap<i32, Session>,
    unlocked_pids: HashSet<i32>,
}

impl MacBackend {
    pub fn new() -> Self {
        Self {
            sessions: HashMap::new(),
            unlocked_pids: HashSet::new(),
        }
    }
}

fn process_alive(pid: i32) -> bool {
    if pid <= 0 {
        return false;
    }
    // SAFETY: `kill(pid, 0)` probes process existence without sending a signal.
    if unsafe { libc::kill(pid, 0) } == 0 {
        return true;
    }
    std::io::Error::last_os_error().raw_os_error() != Some(libc::ESRCH)
}

fn same_frame(a: &Frame, b: &Frame) -> bool {
    (a.x - b.x).abs() <= 1.5
        && (a.y - b.y).abs() <= 1.5
        && (a.width - b.width).abs() <= 1.5
        && (a.height - b.height).abs() <= 1.5
}

fn verify_shot_bounds(
    shot: Option<(Frame, (u32, u32))>,
    live_window: Option<&Frame>,
) -> Result<(Frame, (u32, u32))> {
    let (captured, size) = shot.ok_or_else(|| {
        anyhow!("Request a screenshot (screenshot: true) or ocr: true before using x/y coordinates")
    })?;
    let live = live_window
        .ok_or_else(|| anyhow!("The target window is no longer on screen; read a fresh state."))?;
    if !same_frame(&captured, live) {
        bail!("Window moved or resized since the screenshot; request a fresh screenshot or ocr: true.");
    }
    Ok((*live, size))
}

fn require_safe_element(handle: CFTypeRef) -> Result<()> {
    if ax::is_secure_element(handle) {
        bail!("Password fields require the user; automated actions are refused.");
    }
    if !ax::is_enabled(handle) {
        bail!("The element is disabled.");
    }
    Ok(())
}

fn require_no_secure_input(app_pid: i32) -> Result<()> {
    // SAFETY: plain Carbon query across active HID session.
    if unsafe { IsSecureEventInputEnabled() } != 0 {
        bail!("Secure input is active (password field or security prompt); automated keyboard input is refused.");
    }
    if let Some(app_el) = ax::application(app_pid) {
        if let Some(focused) = ax::focused_element(app_el.raw()) {
            if ax::is_secure_element(focused.raw()) {
                bail!("Focused field is a password field; automated keyboard input is refused.");
            }
        }
    }
    Ok(())
}

fn focusable_input_role(handle: CFTypeRef) -> bool {
    matches!(
        ax::text(handle, "AXRole").as_deref(),
        Some("AXTextField" | "AXTextArea" | "AXComboBox" | "AXSearchField")
    )
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

fn scale_point(window: &Frame, shot: Option<(u32, u32)>, point: Point) -> CGPoint {
    let (sx, sy) = match shot {
        Some((width, height)) if width > 0 && height > 0 => {
            (window.width / width as f64, window.height / height as f64)
        }
        _ => (1.0, 1.0),
    };
    CGPoint {
        x: window.x + point.x * sx,
        y: window.y + point.y * sy,
    }
}

fn collect_roots(app_el: CFTypeRef, window: Cf) -> Vec<Cf> {
    let mut roots = vec![window];
    roots.extend(
        ax::children(app_el)
            .into_iter()
            .filter(|child| ax::text(child.raw(), "AXRole").as_deref() == Some("AXMenu")),
    );
    roots
}

impl MacBackend {
    fn prune_sessions(&mut self, incoming_pid: i32) {
        self.sessions
            .retain(|&pid, session| session.read_at.elapsed() < SESSION_TTL && process_alive(pid));
        self.unlocked_pids.retain(|&pid| process_alive(pid));
        if !self.sessions.contains_key(&incoming_pid) && self.sessions.len() >= MAX_SESSIONS {
            if let Some(oldest) = self
                .sessions
                .iter()
                .min_by_key(|(_, session)| session.read_at)
                .map(|(&pid, _)| pid)
            {
                self.sessions.remove(&oldest);
            }
        }
    }

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

    fn live_window_frame(&self, pid: i32, session: &Session) -> Option<Frame> {
        let live = windows::on_screen();
        if let Some(id) = session.window_id {
            if let Some(found) = live.iter().find(|w| w.pid == pid && w.id == id) {
                return Some(found.bounds);
            }
        }
        let reference = session.shot.map(|(frame, _)| frame).or(session.window);
        windows::matching(&live, pid, reference).map(|w| w.bounds)
    }

    fn checked_point(&self, app: &RunningApp, point: Point) -> Result<CGPoint> {
        let session = self.session(app)?;
        let live = self.live_window_frame(app.pid, session);
        let (bounds, size) = verify_shot_bounds(session.shot, live.as_ref())?;
        Ok(scale_point(&bounds, Some(size), point))
    }

    fn point_of(&self, app: &RunningApp, target: Target) -> Result<CGPoint> {
        match target {
            Target::Point(point) => self.checked_point(app, point),
            Target::Element(index) => {
                let handle = self.handle(app, index)?;
                require_safe_element(handle)?;
                ax::frame(handle)
                    .filter(|frame| frame.width > 0.0 && frame.height > 0.0)
                    .map(|frame| frame.center())
                    .ok_or_else(|| anyhow!("element {index} has no position on screen"))
            }
        }
    }

    fn prepare(&self, app: &str, background: bool) -> Result<RunningApp> {
        require_accessibility()?;
        let app = resolve(app)?;
        if !background {
            activate(&app);
        }
        Ok(app)
    }
}

impl Backend for MacBackend {
    fn permissions(&mut self, request: &PermissionRequest) -> Result<Permissions> {
        let wants = |item| request.request.contains(&item);
        // Each prompt only for what was asked, and only while missing.
        let accessibility = accessibility_trusted(wants(PermissionItem::Accessibility));
        // SAFETY: plain query.
        let mut screen_recording = unsafe { CGPreflightScreenCaptureAccess() };
        if wants(PermissionItem::ScreenRecording) && !screen_recording {
            // SAFETY: shows the system prompt at most once per app.
            screen_recording = unsafe { CGRequestScreenCaptureAccess() };
        }
        let mut items = vec![
            PermissionCheck {
                item: PermissionItem::Accessibility,
                granted: accessibility,
                settings_opened: None,
                settings_path: ACCESSIBILITY_PATH.into(),
            },
            PermissionCheck {
                item: PermissionItem::ScreenRecording,
                granted: screen_recording,
                settings_opened: None,
                settings_path: SCREEN_PATH.into(),
            },
        ];
        if let Some(item) = request.open_settings {
            let opened = open_settings(item);
            if let Some(check) = items.iter_mut().find(|check| check.item == item) {
                check.settings_opened = Some(opened);
            }
        }
        let mut guidance = Vec::new();
        if !accessibility {
            guidance.push(ACCESSIBILITY_GUIDE.to_string());
        }
        if !screen_recording {
            guidance.push(SCREEN_GUIDE.to_string());
        }
        if !guidance.is_empty() {
            guidance.push("Settings → System permissions in mc-agent shows both and opens the right page. A permission turned on while mc-agent is running may only take effect after restarting it.".into());
        }
        Ok(Permissions {
            accessibility,
            screen_recording,
            items,
            checked_by: CheckedBy::this_process(),
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
        self.prune_sessions(app.pid);
        let element = ax::application(app.pid)
            .ok_or_else(|| anyhow!("cannot reach {} through accessibility", app.name))?;
        let first_unlock = self.unlocked_pids.insert(app.pid);
        if first_unlock {
            ax::enable_manual_accessibility(element.raw());
        }
        let mut window = ax::front_window(element.raw());
        if window.is_none() {
            activate(&app);
            sleep(Duration::from_millis(300));
            window = ax::front_window(element.raw());
        }
        let mut notes = Vec::new();
        let menu_bar = menu::top_bar_titles(element.raw());
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
                menu_bar,
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
        let mut title = ax::text(window.raw(), "AXTitle");
        let mut ax_frame = ax::frame(window.raw());
        let (mut elements, mut handles, mut truncated) =
            ax::walk(collect_roots(element.raw(), window));
        // Newly unlocked Chromium/Electron apps may populate their renderer AX tree asynchronously.
        if first_unlock && elements.len() <= 5 {
            sleep(Duration::from_millis(150));
            if let Some(refreshed) = ax::front_window(element.raw()) {
                title = ax::text(refreshed.raw(), "AXTitle");
                ax_frame = ax::frame(refreshed.raw());
                (elements, handles, truncated) = ax::walk(collect_roots(element.raw(), refreshed));
            }
        }
        let cg_window = windows::matching(&windows::on_screen(), app.pid, ax_frame);
        if truncated {
            notes.push(format!(
                "The window has more than {} elements; only the first ones are listed. Scroll or narrow the view to reach the rest.",
                ax::MAX_ELEMENTS
            ));
        }
        let bounds = cg_window.as_ref().map(|window| window.bounds).or(ax_frame);
        let previous_shot = self
            .sessions
            .get(&app.pid)
            .and_then(|session| session.shot)
            .filter(|(old_bounds, _)| bounds.is_some_and(|now| same_frame(&now, old_bounds)));
        self.sessions.insert(
            app.pid,
            Session {
                handles,
                window: bounds,
                window_id: cg_window.map(|window| window.id),
                // Coordinates keep meaning pixels of the last screenshot while the window stays in place.
                shot: previous_shot,
                read_at: Instant::now(),
            },
        );
        Ok(AppState {
            app: info,
            window_title: title,
            menu_bar,
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
        let (id, bounds) = {
            let session = self.session(&app)?;
            let id = session
                .window_id
                .ok_or_else(|| anyhow!("the window is not on screen"))?;
            let bounds = self
                .live_window_frame(app.pid, session)
                .or(session.window)
                .ok_or_else(|| anyhow!("the window's position is unknown; take a new state"))?;
            (id, bounds)
        };
        let shot = windows::capture(id)?;
        if let Some(session) = self.sessions.get_mut(&app.pid) {
            session.window = Some(bounds);
            session.shot = Some((bounds, (shot.width, shot.height)));
        }
        Ok(shot)
    }

    fn ocr(&mut self, app: &str) -> Result<(u32, u32, Vec<OcrLine>)> {
        let shot = self.screenshot(app)?;
        let lines = ocr::recognize(&shot.data, shot.width, shot.height)?;
        Ok((shot.width, shot.height, lines))
    }

    fn click(
        &mut self,
        app: &str,
        target: Target,
        button: MouseButton,
        count: u32,
        background: bool,
    ) -> Result<()> {
        let app = self.prepare(app, background)?;
        if let Target::Element(index) = target {
            let handle = self.handle(&app, index)?;
            require_safe_element(handle)?;
            if background && button == MouseButton::Left && focusable_input_role(handle) {
                let _ = ax::set_focused(handle);
            }
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
        let sink = if background {
            input::TargetSink::Background(app.pid)
        } else {
            input::TargetSink::Foreground
        };
        input::click(at, button == MouseButton::Right, count, sink)
    }

    fn drag(&mut self, app: &str, from: Point, to: Point) -> Result<()> {
        let app = self.prepare(app, false)?;
        let start = self.checked_point(&app, from)?;
        let end = self.checked_point(&app, to)?;
        input::drag(start, end)
    }

    fn type_text(&mut self, app: &str, text: &str, background: bool) -> Result<()> {
        let app = self.prepare(app, background)?;
        require_no_secure_input(app.pid)?;
        let sink = if background {
            input::TargetSink::Background(app.pid)
        } else {
            input::TargetSink::Foreground
        };
        input::type_text(text, sink)
    }

    fn press_key(&mut self, app: &str, chord: &KeyChord, background: bool) -> Result<()> {
        let app = self.prepare(app, background)?;
        require_no_secure_input(app.pid)?;
        let sink = if background {
            input::TargetSink::Background(app.pid)
        } else {
            input::TargetSink::Foreground
        };
        input::press(chord, sink)
    }

    fn scroll(
        &mut self,
        app: &str,
        target: Option<Target>,
        direction: Direction,
        pages: f64,
        background: bool,
    ) -> Result<()> {
        let app = self.prepare(app, background)?;
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
        let sink = if background {
            input::TargetSink::Background(app.pid)
        } else {
            input::TargetSink::Foreground
        };
        input::scroll(at, lines, columns, sink)
    }

    fn set_value(&mut self, app: &str, element: usize, value: &str) -> Result<()> {
        require_accessibility()?;
        let app = resolve(app)?;
        let handle = self.handle(&app, element)?;
        require_safe_element(handle)?;
        ax::set_string(handle, "AXValue", value)
    }

    fn perform_action(&mut self, app: &str, element: usize, action: &str) -> Result<()> {
        require_accessibility()?;
        let app = resolve(app)?;
        let handle = self.handle(&app, element)?;
        require_safe_element(handle)?;
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

    fn press_menu(&mut self, app: &str, path: &[String]) -> Result<()> {
        require_accessibility()?;
        let app = resolve(app)?;
        let element = ax::application(app.pid)
            .ok_or_else(|| anyhow!("cannot reach {} through accessibility", app.name))?;
        menu::press_menu_path(element.raw(), path)
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
        let bounds = Frame {
            x: 100.0,
            y: 50.0,
            width: 800.0,
            height: 600.0,
        };
        assert_eq!(
            scale_point(&bounds, Some((1600, 1200)), Point { x: 400.0, y: 300.0 }),
            CGPoint { x: 300.0, y: 200.0 }
        );
        assert_eq!(
            scale_point(&bounds, None, Point { x: 10.0, y: 10.0 }),
            CGPoint { x: 110.0, y: 60.0 }
        );
    }

    #[test]
    fn stale_or_missing_screenshots_are_rejected() {
        let bounds = Frame {
            x: 100.0,
            y: 50.0,
            width: 800.0,
            height: 600.0,
        };
        assert!(verify_shot_bounds(None, Some(&bounds)).is_err());
        let moved = Frame { x: 140.0, ..bounds };
        let err = verify_shot_bounds(Some((bounds, (800, 600))), Some(&moved))
            .unwrap_err()
            .to_string();
        assert!(err.contains("moved or resized"));
        let tiny_jitter = Frame { x: 101.0, ..bounds };
        assert!(verify_shot_bounds(Some((bounds, (800, 600))), Some(&tiny_jitter)).is_ok());
    }

    #[test]
    fn prune_sessions_evicts_expired_and_caps_total() {
        let mut backend = MacBackend::new();
        let pid = std::process::id() as i32;
        backend.sessions.insert(
            -999,
            Session {
                handles: vec![],
                window: None,
                window_id: None,
                shot: None,
                read_at: Instant::now() - SESSION_TTL - Duration::from_secs(1),
            },
        );
        backend.sessions.insert(
            pid,
            Session {
                handles: vec![],
                window: None,
                window_id: None,
                shot: None,
                read_at: Instant::now(),
            },
        );
        backend.prune_sessions(pid);
        assert!(!backend.sessions.contains_key(&-999));
        assert!(backend.sessions.contains_key(&pid));
    }
}
