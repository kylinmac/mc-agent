//! The tools the model sees, their schemas and argument parsing. Platform-free:
//! every call goes through [`Backend`].
//!
//! Cheap by default (docs/mc-agent/computer-use-codex-analysis.md): a state is
//! element text only, and after the first one of a window only what changed;
//! screenshots come on request; `run` does several actions in one call and
//! reads the state once at the end.

use std::collections::HashMap;
use std::time::{Duration, Instant};

use anyhow::{anyhow, Result};
use base64::Engine;
use serde_json::{json, Value};

use crate::backend::{
    AppState, Backend, Direction, MouseButton, PermissionItem, PermissionRequest, Point, Target,
};
use crate::keys::parse_chord;
use crate::render::{self, Line};

/// What a call returns: MCP content blocks and whether it failed.
pub struct ToolOutput {
    pub content: Vec<Value>,
    pub is_error: bool,
}

impl ToolOutput {
    fn text(text: impl Into<String>) -> Self {
        Self {
            content: vec![json!({ "type": "text", "text": text.into() })],
            is_error: false,
        }
    }

    pub fn error(text: impl Into<String>) -> Self {
        Self {
            content: vec![json!({ "type": "text", "text": text.into() })],
            is_error: true,
        }
    }
}

/// Least time between the last action and reading the state.
const SETTLE_MS: u64 = 300;
/// Gap between two reads when waiting for the UI to stop changing.
const STABLE_POLL_MS: u64 = 250;
/// Longest wait for a stable UI after an action.
const MAX_WAIT_MS: u64 = 5_000;
/// Pause between the steps of one `run`, so each lands before the next.
const STEP_GAP_MS: u64 = 60;
const MAX_STEPS: usize = 40;
/// A diff is relative to what the model saw; after this long, start over.
const BASELINE_TTL: Duration = Duration::from_secs(15 * 60);

/// The tree the model last saw of one app's window.
struct Baseline {
    header: String,
    lines: Vec<Line>,
    at: Instant,
}

/// Tool state that outlives one call: the last tree per app (for diffs) and
/// when the last action happened (for waiting before a read).
#[derive(Default)]
pub struct Tools {
    baselines: HashMap<i64, Baseline>,
    last_action: Option<Instant>,
}

fn app_param() -> Value {
    json!({
        "type": "string",
        "description": "The app: its name as list_apps shows it (e.g. \"Calculator\", \"计算器\"), its bundle id, its .app path, or its pid."
    })
}

fn state_params() -> Value {
    json!({
        "screenshot": { "type": "boolean", "description": "Also return a screenshot of the window. Default false; ask only when the element tree is not enough (canvas, images, layout)." },
        "full": { "type": "boolean", "description": "Return the whole element tree instead of only what changed since the previous state. Default false." }
    })
}

fn target_params() -> Value {
    json!({
        "element_index": { "type": "integer", "minimum": 0, "description": "Element ID from the app's latest state. Preferred over coordinates." },
        "x": { "type": "number", "description": "Screenshot pixel x (origin at the window's top-left), when no element fits. Needs a screenshot first." },
        "y": { "type": "number", "description": "Screenshot pixel y." }
    })
}

fn merge(parts: &[Value]) -> serde_json::Map<String, Value> {
    let mut out = serde_json::Map::new();
    for part in parts {
        if let Value::Object(map) = part {
            out.extend(map.clone());
        }
    }
    out
}

/// Properties of one action, without `app`.
fn action_properties(name: &str) -> serde_json::Map<String, Value> {
    match name {
        "click" => merge(&[
            target_params(),
            json!({
                "mouse_button": { "type": "string", "enum": ["left", "right"] },
                "click_count": { "type": "integer", "minimum": 1, "maximum": 3 }
            }),
        ]),
        "drag" => merge(&[json!({
            "from_x": { "type": "number" }, "from_y": { "type": "number" },
            "to_x": { "type": "number" }, "to_y": { "type": "number" }
        })]),
        "type_text" => merge(&[json!({
            "text": { "type": "string", "minLength": 1, "maxLength": 20000 }
        })]),
        "press_key" => merge(&[json!({
            "key": { "type": "string", "minLength": 1, "maxLength": 64 }
        })]),
        "scroll" => merge(&[
            target_params(),
            json!({
                "direction": { "type": "string", "enum": ["up", "down", "left", "right"] },
                "pages": { "type": "number", "minimum": 0.1, "maximum": 20, "description": "Default 1." }
            }),
        ]),
        "set_value" => merge(&[json!({
            "element_index": { "type": "integer", "minimum": 0 },
            "value": { "type": "string", "maxLength": 100000 }
        })]),
        "perform_action" => merge(&[json!({
            "element_index": { "type": "integer", "minimum": 0 },
            "action": { "type": "string", "minLength": 1, "maxLength": 128 }
        })]),
        _ => serde_json::Map::new(),
    }
}

fn action_required(name: &str) -> Vec<&'static str> {
    match name {
        "drag" => vec!["from_x", "from_y", "to_x", "to_y"],
        "type_text" => vec!["text"],
        "press_key" => vec!["key"],
        "scroll" => vec!["direction"],
        "set_value" => vec!["element_index", "value"],
        "perform_action" => vec!["element_index", "action"],
        _ => vec![],
    }
}

const ACTIONS: [(&str, &str); 7] = [
    ("click", "Click an element (element_index) or a point (x, y in the latest screenshot). Left or right button; click_count 2 double-clicks."),
    ("drag", "Press at (from_x, from_y) and release at (to_x, to_y), screenshot pixels."),
    ("type_text", "Type text into the app's focused element. \\n presses Return. Focus the field first (click it), or use set_value."),
    ("press_key", "Press a key or chord in the app, e.g. \"Return\", \"Tab\", \"Escape\", \"cmd+c\", \"cmd+shift+t\", \"ctrl+a\", \"Left\", \"F5\"."),
    ("scroll", "Scroll at an element or point (or the window's centre) by pages."),
    ("set_value", "Set an element's value directly (a text field, switch or slider marked settable), replacing what is there. Does not press Return."),
    ("perform_action", "Run one of the element's Secondary Actions as its state line lists them (e.g. Raise, Expand, Increment, Pick)."),
];

/// Tool definitions for `tools/list`.
pub fn definitions() -> Vec<Value> {
    let mut defs = vec![
        json!({
            "name": "permissions",
            "description": "Check whether this computer allows reading app UIs and sending input (Accessibility) and taking screenshots (Screen Recording). Checking never prompts. To help the user grant one, pass request_item (shows the system prompt if it is missing) and open_settings (opens that settings page); ask for one permission at a time and do not repeat a request the user declined. The user approves in System Settings.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "request_item": { "type": "string", "enum": ["accessibility", "screenRecording"] },
                    "open_settings": { "type": "string", "enum": ["accessibility", "screenRecording"] },
                    "request": { "type": "boolean", "description": "Older form: request every missing permission." }
                },
                "additionalProperties": false
            }
        }),
        json!({
            "name": "list_apps",
            "description": "List running apps that have windows: name, pid, path, and which one is in front.",
            "inputSchema": { "type": "object", "properties": {}, "additionalProperties": false }
        }),
        json!({
            "name": "get_app_state",
            "description": "Read an app's front window as a tree of UI elements, one per line: ID, role, states, text, Secondary Actions. Launches the app if needed. The first state of a window is the whole tree; later ones list only what changed (~ changed, + added, removed IDs), and elements not listed keep their IDs. Use the IDs as element_index.",
            "inputSchema": {
                "type": "object",
                "properties": merge(&[json!({ "app": app_param() }), state_params()]),
                "required": ["app"],
                "additionalProperties": false
            }
        }),
    ];
    for (name, description) in ACTIONS {
        let mut properties = action_properties(name);
        properties.insert("app".into(), app_param());
        properties.extend(merge(&[
            state_params(),
            json!({ "return_state": { "type": "boolean", "description": "Return what changed in the app after the action. Default true." } }),
        ]));
        let mut required = vec!["app"];
        required.extend(action_required(name));
        defs.push(json!({
            "name": name,
            "description": description,
            "inputSchema": { "type": "object", "properties": properties, "required": required, "additionalProperties": false }
        }));
    }
    let mut step_properties = serde_json::Map::new();
    for (name, _) in ACTIONS {
        step_properties.extend(action_properties(name));
    }
    step_properties.insert(
        "do".into(),
        json!({ "type": "string", "enum": ["click", "drag", "type_text", "press_key", "scroll", "set_value", "perform_action", "wait"] }),
    );
    step_properties.insert(
        "ms".into(),
        json!({ "type": "integer", "minimum": 0, "maximum": 5000, "description": "wait only: milliseconds." }),
    );
    defs.push(json!({
        "name": "run",
        "description": "Do several actions in one app in order, then return what changed once. Each step is {\"do\": <action>, …that action's arguments without app}, e.g. [{\"do\":\"click\",\"element_index\":12},{\"do\":\"type_text\",\"text\":\"hello\"},{\"do\":\"press_key\",\"key\":\"Return\"}]; \"wait\" pauses for ms. Element IDs refer to the state before the run, so batch steps whose targets are already in it; stop at a step that changes the screen and read the result. Stops at the first failing step.",
        "inputSchema": {
            "type": "object",
            "properties": merge(&[
                json!({
                    "app": app_param(),
                    "steps": {
                        "type": "array",
                        "minItems": 1,
                        "maxItems": MAX_STEPS,
                        "items": { "type": "object", "properties": step_properties, "required": ["do"], "additionalProperties": false }
                    }
                }),
                state_params(),
            ]),
            "required": ["app", "steps"],
            "additionalProperties": false
        }
    }));
    defs
}

fn string(args: &Value, key: &str) -> Result<String> {
    args.get(key)
        .and_then(Value::as_str)
        .map(str::to_string)
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| anyhow!("`{key}` is required"))
}

fn number(args: &Value, key: &str) -> Option<f64> {
    args.get(key)
        .and_then(Value::as_f64)
        .filter(|value| value.is_finite())
}

fn required_number(args: &Value, key: &str) -> Result<f64> {
    number(args, key).ok_or_else(|| anyhow!("`{key}` is required"))
}

fn index(args: &Value, key: &str) -> Result<usize> {
    args.get(key)
        .and_then(Value::as_u64)
        .map(|value| value as usize)
        .ok_or_else(|| anyhow!("`{key}` must be a non-negative integer"))
}

fn flag(args: &Value, key: &str, default: bool) -> bool {
    args.get(key).and_then(Value::as_bool).unwrap_or(default)
}

/// `element_index`, else `x`/`y`; `None` when neither is given.
pub fn target(args: &Value) -> Result<Option<Target>> {
    if args
        .get("element_index")
        .is_some_and(|value| !value.is_null())
    {
        return Ok(Some(Target::Element(index(args, "element_index")?)));
    }
    match (number(args, "x"), number(args, "y")) {
        (Some(x), Some(y)) if x >= 0.0 && y >= 0.0 => Ok(Some(Target::Point(Point { x, y }))),
        (Some(_), Some(_)) => Err(anyhow!("x and y must not be negative")),
        (None, None) => Ok(None),
        _ => Err(anyhow!("give both x and y")),
    }
}

fn permission_item(args: &Value, key: &str) -> Result<Option<PermissionItem>> {
    match args.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(value) => serde_json::from_value(value.clone())
            .map(Some)
            .map_err(|_| anyhow!("`{key}` is accessibility or screenRecording")),
    }
}

/// What a `permissions` call asks for; the older `request: true` means both.
fn permission_request(args: &Value) -> Result<PermissionRequest> {
    let mut request = PermissionRequest {
        request: permission_item(args, "request_item")?.into_iter().collect(),
        open_settings: permission_item(args, "open_settings")?,
    };
    if flag(args, "request", false) && request.request.is_empty() {
        request.request = vec![
            PermissionItem::Accessibility,
            PermissionItem::ScreenRecording,
        ];
    }
    Ok(request)
}

/// One action; returns what was done, in a few words.
fn act(backend: &mut dyn Backend, app: &str, name: &str, args: &Value) -> Result<String> {
    match name {
        "click" => {
            let target = target(args)?.ok_or_else(|| anyhow!("give element_index, or x and y"))?;
            let button = match args.get("mouse_button").and_then(Value::as_str) {
                None | Some("left") => MouseButton::Left,
                Some("right") => MouseButton::Right,
                Some(other) => return Err(anyhow!("unknown mouse_button \"{other}\"")),
            };
            let count = args
                .get("click_count")
                .and_then(Value::as_u64)
                .unwrap_or(1)
                .clamp(1, 3) as u32;
            backend.click(app, target, button, count)?;
            Ok("Clicked.".into())
        }
        "drag" => {
            let from = Point {
                x: required_number(args, "from_x")?,
                y: required_number(args, "from_y")?,
            };
            let to = Point {
                x: required_number(args, "to_x")?,
                y: required_number(args, "to_y")?,
            };
            backend.drag(app, from, to)?;
            Ok("Dragged.".into())
        }
        "type_text" => {
            let text = args
                .get("text")
                .and_then(Value::as_str)
                .filter(|text| !text.is_empty())
                .ok_or_else(|| anyhow!("`text` is required"))?;
            backend.type_text(app, text)?;
            Ok("Typed.".into())
        }
        "press_key" => {
            let chord = parse_chord(&string(args, "key")?)?;
            backend.press_key(app, &chord)?;
            Ok("Pressed.".into())
        }
        "scroll" => {
            let direction = match string(args, "direction")?.as_str() {
                "up" => Direction::Up,
                "down" => Direction::Down,
                "left" => Direction::Left,
                "right" => Direction::Right,
                other => return Err(anyhow!("unknown direction \"{other}\"")),
            };
            let pages = number(args, "pages").unwrap_or(1.0).clamp(0.1, 20.0);
            backend.scroll(app, target(args)?, direction, pages)?;
            Ok("Scrolled.".into())
        }
        "set_value" => {
            let element = index(args, "element_index")?;
            let value = args
                .get("value")
                .and_then(Value::as_str)
                .ok_or_else(|| anyhow!("`value` is required"))?;
            backend.set_value(app, element, value)?;
            Ok("Value set.".into())
        }
        "perform_action" => {
            let element = index(args, "element_index")?;
            let action = string(args, "action")?;
            backend.perform_action(app, element, &action)?;
            Ok(format!("Performed {action}."))
        }
        "wait" => {
            let ms = args.get("ms").and_then(Value::as_u64).unwrap_or(500);
            backend.sleep(ms.min(MAX_WAIT_MS));
            Ok("Waited.".into())
        }
        other => Err(anyhow!("unknown action \"{other}\"")),
    }
}

fn is_action(name: &str) -> bool {
    ACTIONS.iter().any(|(action, _)| *action == name)
}

/// Busy spinners mean the app is still working.
fn busy(state: &AppState) -> bool {
    state
        .elements
        .iter()
        .any(|element| element.role == "AXBusyIndicator")
}

impl Tools {
    pub fn new() -> Self {
        Self::default()
    }

    /// Read the app; right after an action, wait until two reads agree.
    fn settled_state(&mut self, backend: &mut dyn Backend, app: &str) -> Result<AppState> {
        let Some(acted) = self.last_action.take() else {
            return backend.app_state(app);
        };
        let since = acted.elapsed().as_millis() as u64;
        if since < SETTLE_MS {
            backend.sleep(SETTLE_MS - since);
        }
        let mut state = backend.app_state(app)?;
        let mut waited = SETTLE_MS;
        while waited < MAX_WAIT_MS {
            backend.sleep(STABLE_POLL_MS);
            waited += STABLE_POLL_MS;
            let next = backend.app_state(app)?;
            let stable = render::lines(&next) == render::lines(&state) && !busy(&next);
            state = next;
            if stable {
                break;
            }
        }
        Ok(state)
    }

    /// The state as text (diff when the model has seen this window before),
    /// plus a screenshot when asked.
    fn state_output(
        &mut self,
        backend: &mut dyn Backend,
        app: &str,
        args: &Value,
        lead: Option<&str>,
    ) -> Result<ToolOutput> {
        let state = self.settled_state(backend, app)?;
        let lines = render::lines(&state);
        let header = render::window_header(&state);
        let full = render::full_text(&state, &lines);
        let mut text = full.clone();
        if !flag(args, "full", false) {
            if let Some(base) = self.baselines.get(&state.app.pid) {
                if base.header == header && base.at.elapsed() < BASELINE_TTL {
                    let diff = render::diff_text(&base.lines, &state, &lines);
                    // A diff that renumbers most lines is worse than the tree.
                    if diff.len() * 4 < full.len() * 3 {
                        text = diff;
                    }
                }
            }
        }
        self.baselines.insert(
            state.app.pid,
            Baseline {
                header,
                lines,
                at: Instant::now(),
            },
        );
        let mut content = Vec::new();
        let mut image = None;
        if flag(args, "screenshot", false) {
            match backend.screenshot(app) {
                Ok(shot) => {
                    text.push_str(&format!(
                        "\nScreenshot: {}×{} px; x/y coordinates are pixels in it, origin at the window's top-left.",
                        shot.width, shot.height
                    ));
                    image = Some(json!({
                        "type": "image",
                        "data": base64::engine::general_purpose::STANDARD.encode(&shot.data),
                        "mimeType": shot.mime
                    }));
                }
                Err(error) => text.push_str(&format!("\nNo screenshot: {error:#}")),
            }
        }
        if let Some(lead) = lead {
            text = format!("{lead}\n{text}");
        }
        content.push(json!({ "type": "text", "text": text }));
        content.extend(image);
        Ok(ToolOutput {
            content,
            is_error: false,
        })
    }

    fn run_steps(
        &mut self,
        backend: &mut dyn Backend,
        app: &str,
        args: &Value,
    ) -> Result<ToolOutput> {
        let steps = args
            .get("steps")
            .and_then(Value::as_array)
            .filter(|steps| !steps.is_empty())
            .ok_or_else(|| anyhow!("`steps` must be a non-empty array"))?;
        if steps.len() > MAX_STEPS {
            return Err(anyhow!("at most {MAX_STEPS} steps per run"));
        }
        let mut failure = None;
        for (number, step) in steps.iter().enumerate() {
            if number > 0 {
                backend.sleep(STEP_GAP_MS);
            }
            let name = step.get("do").and_then(Value::as_str).unwrap_or("");
            let result = act(backend, app, name, step);
            if name != "wait" {
                self.last_action = Some(Instant::now());
            }
            if let Err(error) = result {
                failure = Some(format!(
                    "Step {} ({}) failed: {error:#}. The steps before it ran; the rest did not.",
                    number + 1,
                    if name.is_empty() { "?" } else { name }
                ));
                break;
            }
        }
        let lead = match &failure {
            Some(failure) => failure.clone(),
            None => format!("Ran {} steps.", steps.len()),
        };
        let mut output = self.state_output(backend, app, args, Some(&lead))?;
        output.is_error = failure.is_some();
        Ok(output)
    }

    fn run(&mut self, backend: &mut dyn Backend, name: &str, args: &Value) -> Result<ToolOutput> {
        match name {
            "permissions" => {
                let permissions = backend.permissions(&permission_request(args)?)?;
                Ok(ToolOutput::text(serde_json::to_string_pretty(
                    &permissions,
                )?))
            }
            "list_apps" => {
                let apps = backend.list_apps()?;
                Ok(ToolOutput::text(serde_json::to_string_pretty(&apps)?))
            }
            "get_app_state" => {
                let app = string(args, "app")?;
                self.state_output(backend, &app, args, None)
            }
            "run" => {
                let app = string(args, "app")?;
                self.run_steps(backend, &app, args)
            }
            name if is_action(name) => {
                let app = string(args, "app")?;
                let done = act(backend, &app, name, args)?;
                self.last_action = Some(Instant::now());
                if flag(args, "return_state", true) {
                    self.state_output(backend, &app, args, Some(&done))
                } else {
                    Ok(ToolOutput::text(done))
                }
            }
            other => Err(anyhow!("unknown tool \"{other}\"")),
        }
    }

    /// Run one tool call; failures become an error result the model can read.
    pub fn call(&mut self, backend: &mut dyn Backend, name: &str, args: &Value) -> ToolOutput {
        match self.run(backend, name, args) {
            Ok(output) => output,
            Err(error) => ToolOutput::error(format!("{name}: {error:#}")),
        }
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::backend::{AppInfo, CheckedBy, Element, Permissions, Screenshot};
    use crate::keys::KeyChord;

    /// Records calls; its window gains a line per action.
    #[derive(Default)]
    pub struct Fake {
        pub calls: Vec<String>,
        pub actions: usize,
    }

    impl Backend for Fake {
        fn permissions(&mut self, request: &PermissionRequest) -> Result<Permissions> {
            self.calls.push(format!(
                "permissions {:?} {:?}",
                request.request, request.open_settings
            ));
            Ok(Permissions {
                accessibility: true,
                screen_recording: false,
                items: vec![],
                checked_by: CheckedBy {
                    pid: 1,
                    executable: "mc-computer".into(),
                },
                guidance: vec!["grant it".into()],
            })
        }
        fn list_apps(&mut self) -> Result<Vec<AppInfo>> {
            Ok(vec![AppInfo {
                name: "Notes".into(),
                pid: 7,
                path: None,
                frontmost: true,
            }])
        }
        fn app_state(&mut self, app: &str) -> Result<AppState> {
            self.calls.push(format!("state {app}"));
            let mut elements = vec![Element {
                role: "AXWindow".into(),
                title: Some("Untitled".into()),
                enabled: true,
                ..Default::default()
            }];
            for n in 0..30 {
                elements.push(Element {
                    depth: 1,
                    role: "AXButton".into(),
                    title: Some(format!("b{n}")),
                    enabled: true,
                    ..Default::default()
                });
            }
            for n in 0..self.actions {
                elements.push(Element {
                    depth: 1,
                    role: "AXStaticText".into(),
                    value: Some(format!("line {n}")),
                    enabled: true,
                    ..Default::default()
                });
            }
            Ok(AppState {
                app: AppInfo {
                    name: app.into(),
                    pid: 7,
                    path: None,
                    frontmost: true,
                },
                window_title: Some("Untitled".into()),
                elements,
                notes: vec![],
            })
        }
        fn screenshot(&mut self, app: &str) -> Result<Screenshot> {
            self.calls.push(format!("shot {app}"));
            Ok(Screenshot {
                data: vec![1, 2, 3],
                mime: "image/jpeg",
                width: 10,
                height: 20,
            })
        }
        fn click(
            &mut self,
            app: &str,
            target: Target,
            button: MouseButton,
            count: u32,
        ) -> Result<()> {
            self.actions += 1;
            self.calls
                .push(format!("click {app} {target:?} {button:?} {count}"));
            Ok(())
        }
        fn drag(&mut self, app: &str, from: Point, to: Point) -> Result<()> {
            self.calls.push(format!(
                "drag {app} {},{} {},{}",
                from.x, from.y, to.x, to.y
            ));
            Ok(())
        }
        fn type_text(&mut self, app: &str, text: &str) -> Result<()> {
            self.actions += 1;
            self.calls.push(format!("type {app} {text}"));
            Ok(())
        }
        fn press_key(&mut self, app: &str, chord: &KeyChord) -> Result<()> {
            self.actions += 1;
            self.calls
                .push(format!("key {app} {:?} {:?}", chord.modifiers, chord.key));
            Ok(())
        }
        fn scroll(
            &mut self,
            app: &str,
            target: Option<Target>,
            direction: Direction,
            pages: f64,
        ) -> Result<()> {
            self.calls
                .push(format!("scroll {app} {target:?} {direction:?} {pages}"));
            Ok(())
        }
        fn set_value(&mut self, app: &str, element: usize, value: &str) -> Result<()> {
            self.calls.push(format!("set {app} {element} {value}"));
            Ok(())
        }
        fn perform_action(&mut self, app: &str, element: usize, action: &str) -> Result<()> {
            if action == "Boom" {
                return Err(anyhow!("no such action"));
            }
            self.calls.push(format!("action {app} {element} {action}"));
            Ok(())
        }
        fn sleep(&mut self, millis: u64) {
            self.calls.push(format!("sleep {millis}"));
        }
    }

    fn text(out: &ToolOutput) -> &str {
        out.content[0]["text"].as_str().unwrap()
    }

    #[test]
    fn every_definition_has_a_name_description_and_object_schema() {
        let defs = definitions();
        assert_eq!(defs.len(), 11);
        for def in &defs {
            assert!(def["name"].as_str().is_some_and(|name| !name.is_empty()));
            assert!(def["description"]
                .as_str()
                .is_some_and(|text| text.len() > 20));
            assert_eq!(def["inputSchema"]["type"], "object");
        }
    }

    #[test]
    fn the_first_state_is_the_whole_tree_then_only_changes() {
        let mut tools = Tools::new();
        let mut fake = Fake::default();
        let out = tools.call(&mut fake, "get_app_state", &json!({ "app": "Notes" }));
        assert!(!out.is_error);
        assert_eq!(out.content.len(), 1, "no screenshot unless asked");
        assert!(text(&out).starts_with("Window: \"Untitled\", App: Notes.\n0 window Untitled"));

        let out = tools.call(&mut fake, "get_app_state", &json!({ "app": "Notes" }));
        assert!(text(&out).starts_with("No changes in Window"));

        let out = tools.call(
            &mut fake,
            "get_app_state",
            &json!({ "app": "Notes", "full": true, "screenshot": true }),
        );
        assert!(text(&out).starts_with("Window:"));
        assert!(text(&out).contains("Screenshot: 10×20 px"));
        assert_eq!(out.content[1]["type"], "image");
        assert_eq!(out.content[1]["data"], "AQID");
        assert_eq!(out.content[1]["mimeType"], "image/jpeg");
    }

    #[test]
    fn actions_wait_for_a_stable_ui_then_return_the_diff() {
        let mut tools = Tools::new();
        let mut fake = Fake::default();
        tools.call(&mut fake, "get_app_state", &json!({ "app": "Notes" }));
        fake.calls.clear();
        let out = tools.call(
            &mut fake,
            "click",
            &json!({ "app": "Notes", "element_index": 3, "click_count": 2 }),
        );
        assert!(!out.is_error);
        assert_eq!(
            text(&out),
            "Clicked.\nChanges in Window: \"Untitled\", App: Notes since the previous state (32 elements; ~ changed, + added, others keep their IDs):\n+\t31 text line 0"
        );
        assert_eq!(fake.calls[0], "click Notes Element(3) Left 2");
        assert!(fake.calls[1].starts_with("sleep "));
        assert_eq!(
            fake.calls
                .iter()
                .filter(|call| call.starts_with("state"))
                .count(),
            2,
            "read until two reads agree"
        );

        let mut fake = Fake::default();
        let out = tools.call(
            &mut fake,
            "press_key",
            &json!({ "app": "Notes", "key": "cmd+s", "return_state": false }),
        );
        assert_eq!(out.content.len(), 1);
        assert_eq!(text(&out), "Pressed.");
        assert_eq!(fake.calls.len(), 1);
    }

    #[test]
    fn run_does_every_step_then_reads_once() {
        let mut tools = Tools::new();
        let mut fake = Fake::default();
        tools.call(&mut fake, "get_app_state", &json!({ "app": "Notes" }));
        fake.calls.clear();
        let out = tools.call(
            &mut fake,
            "run",
            &json!({ "app": "Notes", "steps": [
                { "do": "click", "element_index": 4 },
                { "do": "type_text", "text": "12" },
                { "do": "wait", "ms": 100 },
                { "do": "press_key", "key": "Return" }
            ] }),
        );
        assert!(!out.is_error, "{}", text(&out));
        assert!(text(&out).starts_with("Ran 4 steps.\nChanges in"));
        assert!(text(&out).contains("+\t33 text line 2"));
        let acts: Vec<&String> = fake
            .calls
            .iter()
            .filter(|call| !call.starts_with("sleep") && !call.starts_with("state"))
            .collect();
        assert_eq!(acts.len(), 3);
        assert!(fake.calls.contains(&"sleep 100".to_string()));
        assert!(fake.calls.last().unwrap().starts_with("state"));
    }

    #[test]
    fn run_stops_at_a_failing_step_and_still_shows_the_state() {
        let mut tools = Tools::new();
        let mut fake = Fake::default();
        let out = tools.call(
            &mut fake,
            "run",
            &json!({ "app": "Notes", "steps": [
                { "do": "click", "element_index": 1 },
                { "do": "perform_action", "element_index": 2, "action": "Boom" },
                { "do": "type_text", "text": "never" }
            ] }),
        );
        assert!(out.is_error);
        assert!(text(&out).starts_with("Step 2 (perform_action) failed: no such action."));
        assert!(text(&out).contains("Window: \"Untitled\""));
        assert!(!fake.calls.iter().any(|call| call.contains("never")));

        let out = tools.call(
            &mut fake,
            "run",
            &json!({ "app": "Notes", "steps": [{ "do": "fly" }] }),
        );
        assert!(text(&out).contains("unknown action \"fly\""));
    }

    #[test]
    fn permissions_are_asked_one_at_a_time_and_the_old_form_still_works() {
        let mut tools = Tools::new();
        let mut fake = Fake::default();
        let out = tools.call(&mut fake, "permissions", &json!({}));
        assert!(text(&out).contains("\"checkedBy\""));
        tools.call(
            &mut fake,
            "permissions",
            &json!({ "request_item": "screenRecording", "open_settings": "screenRecording" }),
        );
        tools.call(&mut fake, "permissions", &json!({ "request": true }));
        assert_eq!(
            fake.calls,
            vec![
                "permissions [] None",
                "permissions [ScreenRecording] Some(ScreenRecording)",
                "permissions [Accessibility, ScreenRecording] None",
            ]
        );
        let out = tools.call(
            &mut fake,
            "permissions",
            &json!({ "request_item": "camera" }),
        );
        assert!(out.is_error);
    }

    #[test]
    fn targets_prefer_elements_and_need_both_coordinates() {
        assert_eq!(
            target(&json!({ "element_index": 2, "x": 1, "y": 1 })).unwrap(),
            Some(Target::Element(2))
        );
        assert_eq!(
            target(&json!({ "x": 5.5, "y": 6 })).unwrap(),
            Some(Target::Point(Point { x: 5.5, y: 6.0 }))
        );
        assert_eq!(target(&json!({})).unwrap(), None);
        assert!(target(&json!({ "x": 5 })).is_err());
        assert!(target(&json!({ "x": -1, "y": 2 })).is_err());
    }

    #[test]
    fn bad_arguments_come_back_as_readable_errors() {
        let mut tools = Tools::new();
        let mut fake = Fake::default();
        let out = tools.call(&mut fake, "click", &json!({ "app": "Notes" }));
        assert!(out.is_error);
        assert!(text(&out).contains("give element_index, or x and y"));
        let out = tools.call(
            &mut fake,
            "press_key",
            &json!({ "app": "Notes", "key": "cmd+banana" }),
        );
        assert!(out.is_error);
        let out = tools.call(&mut fake, "nope", &json!({}));
        assert!(out.is_error);
        assert!(fake.calls.is_empty());
    }
}
