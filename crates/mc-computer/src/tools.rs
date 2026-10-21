//! The tools the model sees, their schemas and argument parsing. Platform-free:
//! every call goes through [`Backend`].

use anyhow::{anyhow, Result};
use base64::Engine;
use serde_json::{json, Value};

use crate::backend::{Backend, Direction, MouseButton, Point, Target};
use crate::keys::parse_chord;
use crate::render::state_text;

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

const SETTLE_MS: u64 = 600;
const MAX_SETTLE_MS: u64 = 5_000;

fn app_param() -> Value {
    json!({
        "type": "string",
        "description": "The app: its name as list_apps shows it (e.g. \"Calculator\", \"计算器\"), its .app path, or its pid."
    })
}

fn return_state_param() -> Value {
    json!({
        "type": "boolean",
        "description": "Return the app's new state (elements and screenshot) after the action. Default true."
    })
}

/// Tool definitions for `tools/list`.
pub fn definitions() -> Vec<Value> {
    let target = json!({
        "element_index": { "type": "integer", "minimum": 0, "description": "Element index from the app's latest state. Preferred over coordinates." },
        "x": { "type": "number", "description": "Screenshot pixel x (origin at the window's top-left), when there is no element to use." },
        "y": { "type": "number", "description": "Screenshot pixel y." }
    });
    let with = |extra: Value| -> Value {
        let mut properties = target.as_object().cloned().unwrap_or_default();
        if let Value::Object(more) = extra {
            properties.extend(more);
        }
        properties.insert("app".into(), app_param());
        properties.insert("return_state".into(), return_state_param());
        Value::Object(properties)
    };
    vec![
        json!({
            "name": "permissions",
            "description": "Check whether this computer allows reading app UIs and sending input (Accessibility) and taking screenshots (Screen Recording). With request=true, ask the system for the missing permissions and open the settings page; the user must approve there.",
            "inputSchema": { "type": "object", "properties": { "request": { "type": "boolean" } }, "additionalProperties": false }
        }),
        json!({
            "name": "list_apps",
            "description": "List running apps that have windows: name, pid, path, and which one is in front.",
            "inputSchema": { "type": "object", "properties": {}, "additionalProperties": false }
        }),
        json!({
            "name": "get_app_state",
            "description": "See an app's front window: a numbered tree of its UI elements (role, text, value, state) and a screenshot. Launches the app if it is not running. Call this before acting, and use the element indices it returns. Indices are only valid until the next state of that app.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "app": app_param(),
                    "screenshot": { "type": "boolean", "description": "Include a screenshot. Default true." }
                },
                "required": ["app"],
                "additionalProperties": false
            }
        }),
        json!({
            "name": "click",
            "description": "Click an element (by element_index) or a point (x, y in the screenshot). Left or right button; click_count 2 double-clicks.",
            "inputSchema": {
                "type": "object",
                "properties": with(json!({
                    "mouse_button": { "type": "string", "enum": ["left", "right"] },
                    "click_count": { "type": "integer", "minimum": 1, "maximum": 3 }
                })),
                "required": ["app"],
                "additionalProperties": false
            }
        }),
        json!({
            "name": "drag",
            "description": "Press at (from_x, from_y) and release at (to_x, to_y), screenshot pixels.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "app": app_param(),
                    "from_x": { "type": "number" }, "from_y": { "type": "number" },
                    "to_x": { "type": "number" }, "to_y": { "type": "number" },
                    "return_state": return_state_param()
                },
                "required": ["app", "from_x", "from_y", "to_x", "to_y"],
                "additionalProperties": false
            }
        }),
        json!({
            "name": "type_text",
            "description": "Type text into the app's focused element, as key presses. \\n presses Return. Click or focus the field first.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "app": app_param(),
                    "text": { "type": "string", "minLength": 1, "maxLength": 20000 },
                    "return_state": return_state_param()
                },
                "required": ["app", "text"],
                "additionalProperties": false
            }
        }),
        json!({
            "name": "press_key",
            "description": "Press a key or chord in the app, e.g. \"Return\", \"Tab\", \"Escape\", \"cmd+c\", \"cmd+shift+t\", \"ctrl+a\", \"Left\", \"F5\".",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "app": app_param(),
                    "key": { "type": "string", "minLength": 1, "maxLength": 64 },
                    "return_state": return_state_param()
                },
                "required": ["app", "key"],
                "additionalProperties": false
            }
        }),
        json!({
            "name": "scroll",
            "description": "Scroll at an element or point (or the window's centre) by pages.",
            "inputSchema": {
                "type": "object",
                "properties": with(json!({
                    "direction": { "type": "string", "enum": ["up", "down", "left", "right"] },
                    "pages": { "type": "number", "minimum": 0.1, "maximum": 20, "description": "Default 1." }
                })),
                "required": ["app", "direction"],
                "additionalProperties": false
            }
        }),
        json!({
            "name": "set_value",
            "description": "Set an element's value directly (e.g. a text field), replacing what is there. Does not press Return.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "app": app_param(),
                    "element_index": { "type": "integer", "minimum": 0 },
                    "value": { "type": "string", "maxLength": 100000 },
                    "return_state": return_state_param()
                },
                "required": ["app", "element_index", "value"],
                "additionalProperties": false
            }
        }),
        json!({
            "name": "perform_action",
            "description": "Run one of an element's own actions as listed after \"actions:\" in its state line (e.g. ShowMenu, Increment, Decrement, Confirm, Cancel, Raise, Pick).",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "app": app_param(),
                    "element_index": { "type": "integer", "minimum": 0 },
                    "action": { "type": "string", "minLength": 1, "maxLength": 64 },
                    "return_state": return_state_param()
                },
                "required": ["app", "element_index", "action"],
                "additionalProperties": false
            }
        }),
    ]
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

fn state_output(
    backend: &mut dyn Backend,
    app: &str,
    screenshot: bool,
    lead: Option<&str>,
) -> Result<ToolOutput> {
    let state = backend.app_state(app, screenshot)?;
    let mut text = state_text(&state);
    if let Some(lead) = lead {
        text = format!("{lead}\n\n{text}");
    }
    let mut content = vec![json!({ "type": "text", "text": text })];
    if let Some(shot) = state.screenshot {
        content.push(json!({
            "type": "image",
            "data": base64::engine::general_purpose::STANDARD.encode(&shot.png),
            "mimeType": "image/png"
        }));
    }
    Ok(ToolOutput {
        content,
        is_error: false,
    })
}

/// After an action: settle, then the new state unless the caller declined it.
fn after_action(
    backend: &mut dyn Backend,
    args: &Value,
    app: &str,
    done: &str,
) -> Result<ToolOutput> {
    let settle = args
        .get("settle_ms")
        .and_then(Value::as_u64)
        .unwrap_or(SETTLE_MS)
        .min(MAX_SETTLE_MS);
    backend.settle(settle);
    if flag(args, "return_state", true) {
        state_output(backend, app, true, Some(done))
    } else {
        Ok(ToolOutput::text(done))
    }
}

fn run(backend: &mut dyn Backend, name: &str, args: &Value) -> Result<ToolOutput> {
    match name {
        "permissions" => {
            let permissions = backend.permissions(flag(args, "request", false))?;
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
            state_output(backend, &app, flag(args, "screenshot", true), None)
        }
        "click" => {
            let app = string(args, "app")?;
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
            backend.click(&app, target, button, count)?;
            after_action(backend, args, &app, "Clicked.")
        }
        "drag" => {
            let app = string(args, "app")?;
            let from = Point {
                x: required_number(args, "from_x")?,
                y: required_number(args, "from_y")?,
            };
            let to = Point {
                x: required_number(args, "to_x")?,
                y: required_number(args, "to_y")?,
            };
            backend.drag(&app, from, to)?;
            after_action(backend, args, &app, "Dragged.")
        }
        "type_text" => {
            let app = string(args, "app")?;
            let text = args
                .get("text")
                .and_then(Value::as_str)
                .filter(|text| !text.is_empty())
                .ok_or_else(|| anyhow!("`text` is required"))?;
            backend.type_text(&app, text)?;
            after_action(backend, args, &app, "Typed.")
        }
        "press_key" => {
            let app = string(args, "app")?;
            let chord = parse_chord(&string(args, "key")?)?;
            backend.press_key(&app, &chord)?;
            after_action(backend, args, &app, "Pressed.")
        }
        "scroll" => {
            let app = string(args, "app")?;
            let direction = match string(args, "direction")?.as_str() {
                "up" => Direction::Up,
                "down" => Direction::Down,
                "left" => Direction::Left,
                "right" => Direction::Right,
                other => return Err(anyhow!("unknown direction \"{other}\"")),
            };
            let pages = number(args, "pages").unwrap_or(1.0).clamp(0.1, 20.0);
            backend.scroll(&app, target(args)?, direction, pages)?;
            after_action(backend, args, &app, "Scrolled.")
        }
        "set_value" => {
            let app = string(args, "app")?;
            let element = index(args, "element_index")?;
            let value = args
                .get("value")
                .and_then(Value::as_str)
                .ok_or_else(|| anyhow!("`value` is required"))?;
            backend.set_value(&app, element, value)?;
            after_action(backend, args, &app, "Value set.")
        }
        "perform_action" => {
            let app = string(args, "app")?;
            let element = index(args, "element_index")?;
            let action = string(args, "action")?;
            backend.perform_action(&app, element, &action)?;
            after_action(backend, args, &app, &format!("Performed {action}."))
        }
        other => Err(anyhow!("unknown tool \"{other}\"")),
    }
}

/// Run one tool call; failures become an error result the model can read.
pub fn call(backend: &mut dyn Backend, name: &str, args: &Value) -> ToolOutput {
    match run(backend, name, args) {
        Ok(output) => output,
        Err(error) => ToolOutput::error(format!("{name}: {error:#}")),
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::backend::{AppInfo, AppState, Element, Permissions, Screenshot};
    use crate::keys::KeyChord;

    /// Records calls; returns a two-element state with a tiny screenshot.
    #[derive(Default)]
    pub struct Fake {
        pub calls: Vec<String>,
    }

    impl Backend for Fake {
        fn permissions(&mut self, request: bool) -> Result<Permissions> {
            self.calls.push(format!("permissions {request}"));
            Ok(Permissions {
                accessibility: true,
                screen_recording: false,
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
        fn app_state(&mut self, app: &str, screenshot: bool) -> Result<AppState> {
            self.calls.push(format!("state {app} {screenshot}"));
            Ok(AppState {
                app: AppInfo {
                    name: app.into(),
                    pid: 7,
                    path: None,
                    frontmost: true,
                },
                window_title: Some("Untitled".into()),
                elements: vec![Element {
                    role: "AXWindow".into(),
                    enabled: true,
                    ..Default::default()
                }],
                truncated: false,
                screenshot: screenshot.then(|| Screenshot {
                    png: vec![1, 2, 3],
                    width: 10,
                    height: 20,
                }),
                notes: vec![],
            })
        }
        fn click(
            &mut self,
            app: &str,
            target: Target,
            button: MouseButton,
            count: u32,
        ) -> Result<()> {
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
            self.calls.push(format!("type {app} {text}"));
            Ok(())
        }
        fn press_key(&mut self, app: &str, chord: &KeyChord) -> Result<()> {
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
            self.calls.push(format!("action {app} {element} {action}"));
            Ok(())
        }
        fn settle(&mut self, millis: u64) {
            self.calls.push(format!("settle {millis}"));
        }
    }

    #[test]
    fn every_definition_has_a_name_description_and_object_schema() {
        let defs = definitions();
        assert_eq!(defs.len(), 10);
        for def in &defs {
            assert!(def["name"].as_str().is_some_and(|name| !name.is_empty()));
            assert!(def["description"]
                .as_str()
                .is_some_and(|text| text.len() > 20));
            assert_eq!(def["inputSchema"]["type"], "object");
        }
    }

    #[test]
    fn state_returns_text_and_a_png_image() {
        let mut fake = Fake::default();
        let out = call(&mut fake, "get_app_state", &json!({ "app": "Notes" }));
        assert!(!out.is_error);
        assert_eq!(out.content.len(), 2);
        assert!(out.content[0]["text"]
            .as_str()
            .unwrap()
            .contains("Screenshot: 10×20 px"));
        assert_eq!(out.content[1]["type"], "image");
        assert_eq!(out.content[1]["data"], "AQID");
        assert_eq!(out.content[1]["mimeType"], "image/png");
    }

    #[test]
    fn actions_settle_then_return_the_new_state_unless_declined() {
        let mut fake = Fake::default();
        let out = call(
            &mut fake,
            "click",
            &json!({ "app": "Notes", "element_index": 3, "click_count": 2 }),
        );
        assert!(!out.is_error);
        assert!(out.content[0]["text"]
            .as_str()
            .unwrap()
            .starts_with("Clicked."));
        assert_eq!(
            fake.calls,
            vec![
                "click Notes Element(3) Left 2",
                "settle 600",
                "state Notes true"
            ]
        );

        let mut fake = Fake::default();
        let out = call(
            &mut fake,
            "press_key",
            &json!({ "app": "Notes", "key": "cmd+s", "return_state": false }),
        );
        assert_eq!(out.content.len(), 1);
        assert_eq!(out.content[0]["text"], "Pressed.");
        assert_eq!(fake.calls.len(), 2);
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
        let mut fake = Fake::default();
        let out = call(&mut fake, "click", &json!({ "app": "Notes" }));
        assert!(out.is_error);
        assert!(out.content[0]["text"]
            .as_str()
            .unwrap()
            .contains("give element_index, or x and y"));
        let out = call(
            &mut fake,
            "press_key",
            &json!({ "app": "Notes", "key": "cmd+banana" }),
        );
        assert!(out.is_error);
        let out = call(&mut fake, "nope", &json!({}));
        assert!(out.is_error);
        assert!(fake.calls.is_empty());
    }
}
