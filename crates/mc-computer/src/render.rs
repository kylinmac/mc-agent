//! The element tree as text for the model: one line per element, indented by
//! depth, `[index]` first so the model can refer to it.

use crate::backend::{AppState, Element};

const MAX_TEXT: usize = 160;

fn clip(text: &str) -> String {
    let single = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if single.chars().count() <= MAX_TEXT {
        single
    } else {
        let head: String = single.chars().take(MAX_TEXT).collect();
        format!("{head}…")
    }
}

fn role_name(role: &str) -> &str {
    role.strip_prefix("AX").unwrap_or(role)
}

/// One element's line, without indentation.
pub fn element_line(index: usize, element: &Element) -> String {
    let mut line = format!("[{index}] {}", role_name(&element.role));
    if let Some(subrole) = element.subrole.as_deref().filter(|s| !s.is_empty()) {
        line.push_str(&format!("({})", role_name(subrole)));
    }
    let mut seen: Vec<String> = Vec::new();
    for (label, text) in [
        ("", element.title.as_deref()),
        ("value=", element.value.as_deref()),
        ("desc=", element.description.as_deref()),
        ("placeholder=", element.placeholder.as_deref()),
    ] {
        let Some(text) = text.map(clip).filter(|text| !text.is_empty()) else {
            continue;
        };
        // The same words under two attributes say nothing new.
        if seen.contains(&text) {
            continue;
        }
        line.push_str(&format!(" {label}\"{}\"", text.replace('"', "'")));
        seen.push(text);
    }
    let mut flags = Vec::new();
    if !element.enabled {
        flags.push("disabled");
    }
    if element.focused {
        flags.push("focused");
    }
    if element.selected {
        flags.push("selected");
    }
    if !flags.is_empty() {
        line.push_str(&format!(" ({})", flags.join(", ")));
    }
    let extra: Vec<&str> = element
        .actions
        .iter()
        .map(|action| role_name(action))
        .filter(|action| *action != "Press" && *action != "ScrollToVisible")
        .collect();
    if !extra.is_empty() {
        line.push_str(&format!(" actions: {}", extra.join(", ")));
    }
    line
}

/// The whole state as text: a header, then the tree.
pub fn state_text(state: &AppState) -> String {
    let mut out = String::new();
    out.push_str(&format!("App: {} (pid {})", state.app.name, state.app.pid));
    if let Some(title) = state.window_title.as_deref().filter(|t| !t.is_empty()) {
        out.push_str(&format!("\nWindow: {}", clip(title)));
    }
    if let Some(shot) = &state.screenshot {
        out.push_str(&format!(
            "\nScreenshot: {}×{} px; x/y coordinates are pixels in it, origin at the window's top-left.",
            shot.width, shot.height
        ));
    }
    for note in &state.notes {
        out.push_str(&format!("\nNote: {note}"));
    }
    out.push_str(&format!(
        "\nElements ({}{}):",
        state.elements.len(),
        if state.truncated { ", truncated" } else { "" }
    ));
    for (index, element) in state.elements.iter().enumerate() {
        out.push('\n');
        out.push_str(&"  ".repeat(element.depth));
        out.push_str(&element_line(index, element));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::backend::AppInfo;

    fn element(depth: usize, role: &str, title: Option<&str>) -> Element {
        Element {
            depth,
            role: role.into(),
            title: title.map(Into::into),
            enabled: true,
            ..Default::default()
        }
    }

    #[test]
    fn lines_carry_index_role_text_flags_and_actions() {
        let mut button = element(1, "AXButton", Some("Save"));
        button.description = Some("Save".into());
        button.enabled = false;
        button.actions = vec!["AXPress".into(), "AXShowMenu".into()];
        assert_eq!(
            element_line(3, &button),
            "[3] Button \"Save\" (disabled) actions: ShowMenu"
        );
        let mut field = element(2, "AXTextField", None);
        field.value = Some("hello \"world\"\nagain".into());
        field.focused = true;
        assert_eq!(
            element_line(4, &field),
            "[4] TextField value=\"hello 'world' again\" (focused)"
        );
    }

    #[test]
    fn state_text_indents_by_depth_and_reports_truncation() {
        let state = AppState {
            app: AppInfo {
                name: "Calculator".into(),
                pid: 42,
                path: None,
                frontmost: true,
            },
            window_title: Some("Calculator".into()),
            elements: vec![
                element(0, "AXWindow", Some("Calculator")),
                element(1, "AXButton", Some("7")),
            ],
            truncated: true,
            screenshot: None,
            notes: vec!["no screenshot".into()],
        };
        let text = state_text(&state);
        assert!(text.contains("App: Calculator (pid 42)"));
        assert!(text.contains("Note: no screenshot"));
        assert!(text.contains("Elements (2, truncated):"));
        assert!(text.ends_with("[0] Window \"Calculator\"\n  [1] Button \"7\""));
    }

    #[test]
    fn long_text_is_clipped() {
        let long = "x".repeat(400);
        let line = element_line(0, &element(0, "AXStaticText", Some(&long)));
        assert!(line.chars().count() < 200);
        assert!(line.ends_with("…\""));
    }
}
