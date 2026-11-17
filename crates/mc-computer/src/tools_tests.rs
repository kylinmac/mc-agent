use super::*;
use crate::backend::{AppInfo, CheckedBy, Element, OcrLine, Permissions, Screenshot};
use crate::keys::KeyChord;

/// Records calls; its window gains a line per action.
#[derive(Default)]
pub struct Fake {
    pub calls: Vec<String>,
    pub actions: usize,
    pub menu_bar: Vec<String>,
    pub ocr_lines: Vec<OcrLine>,
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
            menu_bar: self.menu_bar.clone(),
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
    fn ocr(&mut self, app: &str) -> Result<(u32, u32, Vec<OcrLine>)> {
        self.calls.push(format!("ocr {app}"));
        Ok((200, 100, self.ocr_lines.clone()))
    }
    fn click(
        &mut self,
        app: &str,
        target: Target,
        button: MouseButton,
        count: u32,
        background: bool,
    ) -> Result<()> {
        self.actions += 1;
        let bg = if background { " bg" } else { "" };
        self.calls
            .push(format!("click {app} {target:?} {button:?} {count}{bg}"));
        Ok(())
    }
    fn drag(&mut self, app: &str, from: Point, to: Point) -> Result<()> {
        self.calls.push(format!(
            "drag {app} {},{} {},{}",
            from.x, from.y, to.x, to.y
        ));
        Ok(())
    }
    fn type_text(&mut self, app: &str, text: &str, background: bool) -> Result<()> {
        self.actions += 1;
        let bg = if background { " bg" } else { "" };
        self.calls.push(format!("type {app} {text}{bg}"));
        Ok(())
    }
    fn press_key(&mut self, app: &str, chord: &KeyChord, background: bool) -> Result<()> {
        self.actions += 1;
        let bg = if background { " bg" } else { "" };
        self.calls.push(format!(
            "key {app} {:?} {:?}{bg}",
            chord.modifiers, chord.key
        ));
        Ok(())
    }
    fn scroll(
        &mut self,
        app: &str,
        target: Option<Target>,
        direction: Direction,
        pages: f64,
        background: bool,
    ) -> Result<()> {
        let bg = if background { " bg" } else { "" };
        self.calls
            .push(format!("scroll {app} {target:?} {direction:?} {pages}{bg}"));
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
    fn press_menu(&mut self, app: &str, menu: &[String]) -> Result<()> {
        self.actions += 1;
        self.calls.push(format!("menu {app} {}", menu.join(" > ")));
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
    assert_eq!(defs.len(), 12);
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
fn state_can_include_ocr_coordinates_and_menu_bar() {
    let mut tools = Tools::new();
    let mut fake = Fake {
        menu_bar: vec!["File".into(), "Edit".into()],
        ocr_lines: vec![OcrLine {
            text: "Submit".into(),
            x: 20,
            y: 40,
            width: 60,
            height: 20,
        }],
        ..Default::default()
    };
    let out = tools.call(
        &mut fake,
        "get_app_state",
        &json!({ "app": "Notes", "ocr": true }),
    );
    assert!(!out.is_error, "{}", text(&out));
    assert!(text(&out).contains("Menu bar: File | Edit"));
    assert!(text(&out).contains("OCR (1 regions in 200×100 px window capture"));
    assert!(text(&out).contains("[ocr 0] (50, 50) \"Submit\""));
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
fn background_flag_and_press_menu_route_to_backend() {
    let mut tools = Tools::new();
    let mut fake = Fake::default();
    let out = tools.call(
        &mut fake,
        "run",
        &json!({
            "app": "Notes",
            "background": true,
            "steps": [
                { "do": "click", "element_index": 2 },
                { "do": "type_text", "text": "abc", "background": false },
                { "do": "press_menu", "menu": ["File", "Save"] }
            ]
        }),
    );
    assert!(!out.is_error, "{}", text(&out));
    assert!(fake
        .calls
        .contains(&"click Notes Element(2) Left 1 bg".to_string()));
    assert!(fake.calls.contains(&"type Notes abc".to_string()));
    assert!(fake.calls.contains(&"menu Notes File > Save".to_string()));

    let bad_drag = tools.call(
        &mut fake,
        "drag",
        &json!({ "app": "Notes", "from_x": 1, "from_y": 2, "to_x": 3, "to_y": 4, "background": true }),
    );
    assert!(bad_drag.is_error);
    assert!(text(&bad_drag).contains("drag requires foreground mode"));
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
    let out = tools.call(
        &mut fake,
        "press_menu",
        &json!({ "app": "Notes", "menu": ["File", ""] }),
    );
    assert!(out.is_error);
    let out = tools.call(&mut fake, "nope", &json!({}));
    assert!(out.is_error);
    assert!(fake.calls.is_empty());
}
