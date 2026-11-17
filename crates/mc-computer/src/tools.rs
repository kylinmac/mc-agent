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
        "description": "The app: its name or pid from list_apps. macOS also accepts a bundle id or .app path. Windows accepts an executable name or an absolute local .exe path (no arguments) to launch it; use pid for ambiguous names."
    })
}

fn state_params() -> Value {
    json!({
        "screenshot": { "type": "boolean", "description": "Also return a screenshot of the window. Default false; ask only when the element tree is not enough (canvas, images, layout)." },
        "ocr": { "type": "boolean", "description": "macOS: run on-device Vision OCR on the window and return recognized text with (x, y) coordinates ready for click/scroll, even without screenshot: true. Default false." },
        "full": { "type": "boolean", "description": "Return the whole element tree instead of only what changed since the previous state. Default false." }
    })
}

fn background_param() -> Value {
    json!({
        "background": {
            "type": "boolean",
            "description": "macOS: send the action directly to the app in the background (AX action / CGEventPostToPid) without bringing it to the front or moving the mouse cursor. Default false; unsupported by drag and Windows."
        }
    })
}

fn supports_background(name: &str) -> bool {
    matches!(
        name,
        "click" | "drag" | "type_text" | "press_key" | "scroll"
    )
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
        "press_menu" => merge(&[json!({
            "menu": {
                "type": "array",
                "minItems": 1,
                "maxItems": 8,
                "items": { "type": "string", "minLength": 1, "maxLength": 128 },
                "description": "Menu bar path from top-level menu item to target item, e.g. [\"File\", \"Save\"] or [\"文件\", \"新建窗口\"]."
            }
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
        "press_menu" => vec!["menu"],
        _ => vec![],
    }
}

const ACTIONS: [(&str, &str); 8] = [
    ("click", "Click an element (element_index) or a point (x, y in the latest screenshot). Left or right button; click_count 2 double-clicks."),
    ("drag", "Press at (from_x, from_y) and release at (to_x, to_y), screenshot pixels."),
    ("type_text", "Type text into the app's focused element. \\n presses Return. Focus the field first (click it), or use set_value."),
    ("press_key", "Press a key or chord in the app, e.g. \"Return\", \"Tab\", \"Escape\", \"cmd+c\", \"cmd+shift+t\", \"ctrl+a\", \"Left\", \"F5\"."),
    ("scroll", "Scroll at an element or point (or the window's centre) by pages."),
    ("set_value", "Set an element's value directly (a text field, switch or slider marked settable), replacing what is there. Does not press Return."),
    ("perform_action", "Run one of the element's Secondary Actions as its state line lists them (e.g. Raise, Expand, Increment, Pick)."),
    ("press_menu", "macOS: trigger an item in the app's top menu bar by path, e.g. [\"File\", \"Save\"] or [\"文件\", \"新建窗口\"]."),
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
        if supports_background(name) {
            properties.extend(merge(&[background_param()]));
        }
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
    step_properties.extend(merge(&[background_param()]));
    step_properties.insert(
        "do".into(),
        json!({ "type": "string", "enum": ["click", "drag", "type_text", "press_key", "scroll", "set_value", "perform_action", "press_menu", "wait"] }),
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
                background_param(),
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
fn act(
    backend: &mut dyn Backend,
    app: &str,
    name: &str,
    args: &Value,
    background: bool,
) -> Result<String> {
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
            backend.click(app, target, button, count, background)?;
            Ok("Clicked.".into())
        }
        "drag" => {
            if background {
                return Err(anyhow!(
                    "drag requires foreground mode (omit background or set background: false)"
                ));
            }
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
            backend.type_text(app, text, background)?;
            Ok("Typed.".into())
        }
        "press_key" => {
            let chord = parse_chord(&string(args, "key")?)?;
            backend.press_key(app, &chord, background)?;
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
            backend.scroll(app, target(args)?, direction, pages, background)?;
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
        "press_menu" => {
            let items = args
                .get("menu")
                .and_then(Value::as_array)
                .filter(|items| !items.is_empty())
                .ok_or_else(|| anyhow!("`menu` must be a non-empty array of menu item names"))?;
            let path: Vec<String> = items
                .iter()
                .filter_map(Value::as_str)
                .map(str::trim)
                .filter(|item| !item.is_empty())
                .map(str::to_string)
                .collect();
            if path.len() != items.len() {
                return Err(anyhow!("every entry in `menu` must be a non-empty string"));
            }
            backend.press_menu(app, &path)?;
            Ok(format!("Triggered menu {}.", path.join(" > ")))
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
        if flag(args, "ocr", false) {
            match backend.ocr(app) {
                Ok((width, height, lines)) => {
                    if lines.is_empty() {
                        text.push_str(&format!(
                            "\nOCR: no text recognized in {width}×{height} px window capture."
                        ));
                    } else {
                        text.push_str(&format!(
                            "\nOCR ({} regions in {width}×{height} px window capture; (x, y) are centre coordinates):",
                            lines.len()
                        ));
                        for (i, item) in lines.iter().enumerate() {
                            let cx = item.x + item.width / 2;
                            let cy = item.y + item.height / 2;
                            let clean = item.text.replace('\n', " ").trim().to_string();
                            text.push_str(&format!("\n\t[ocr {i}] ({cx}, {cy}) \"{clean}\""));
                        }
                    }
                }
                Err(error) => text.push_str(&format!("\nNo OCR: {error:#}")),
            }
        }
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
        let default_background = flag(args, "background", false);
        let mut failure = None;
        for (number, step) in steps.iter().enumerate() {
            if number > 0 {
                backend.sleep(STEP_GAP_MS);
            }
            let name = step.get("do").and_then(Value::as_str).unwrap_or("");
            let background = step
                .get("background")
                .and_then(Value::as_bool)
                .unwrap_or(default_background);
            let result = act(backend, app, name, step, background);
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
                let background = flag(args, "background", false);
                let done = act(backend, &app, name, args, background)?;
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
#[path = "tools_tests.rs"]
pub(crate) mod tests;
