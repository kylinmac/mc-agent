//! The element tree as text for the model, and what changed between two
//! trees.
//!
//! A line is `<id> <role> (<states>) <text>, Label: value, …`, indented by
//! depth with tabs; `id` is the element's depth-first position, which the
//! tools take as `element_index`. After the first state of a window the model
//! gets a diff: changed (`~`) and added (`+`) lines with their new ids,
//! removed ids as ranges, and the focused element. A line that is not listed
//! kept its id.

use crate::backend::{AppState, Element};

const MAX_TEXT: usize = 200;

fn clip(text: &str) -> String {
    let single = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if single.chars().count() <= MAX_TEXT {
        single
    } else {
        let head: String = single.chars().take(MAX_TEXT).collect();
        format!("{head}…")
    }
}

/// `AXFooBar` → `foo bar`.
fn words(name: &str) -> String {
    let name = name.strip_prefix("AX").unwrap_or(name);
    let mut out = String::new();
    for (i, c) in name.chars().enumerate() {
        if c.is_uppercase() && i > 0 {
            out.push(' ');
        }
        out.extend(c.to_lowercase());
    }
    out
}

/// A short English name for the element's kind.
pub fn role_label(role: &str, subrole: Option<&str>) -> String {
    let named = match (role, subrole.unwrap_or("")) {
        ("AXWindow", "AXStandardWindow") => "standard window",
        ("AXWindow", "AXDialog") => "dialog",
        ("AXWindow", "AXSystemDialog") => "system dialog",
        ("AXWindow", "AXFloatingWindow") => "floating window",
        ("AXButton", "AXCloseButton") => "close button",
        ("AXButton", "AXMinimizeButton") => "minimize button",
        ("AXButton", "AXZoomButton") => "zoom button",
        ("AXButton", "AXFullScreenButton") => "full screen button",
        ("AXCheckBox", "AXSwitch") => "switch",
        ("AXCheckBox", "AXToggle") => "toggle button",
        ("AXCheckBox", _) => "checkbox",
        ("AXRadioButton", "AXTabButton") => "tab",
        ("AXTextField", "AXSearchField") => "search field",
        ("AXTextField", "AXSecureTextField") | ("AXSecureTextField", _) => "secure text field",
        ("AXTextArea", _) => "text entry area",
        ("AXStaticText", _) => "text",
        ("AXWebArea", _) => "HTML content",
        ("AXPopUpButton", _) => "pop up button",
        ("AXIncrementor", _) => "stepper",
        ("AXRow", "AXOutlineRow") => "outline row",
        ("AXList", "AXSectionList") => "section list",
        _ => "",
    };
    if named.is_empty() {
        words(role)
    } else {
        named.into()
    }
}

fn is_toggle(role: &str) -> bool {
    matches!(role, "AXCheckBox" | "AXRadioButton" | "AXSwitch")
}

/// Roles whose value is their text, shown bare like a title.
fn value_is_text(role: &str) -> bool {
    matches!(
        role,
        "AXStaticText" | "AXTextField" | "AXTextArea" | "AXComboBox" | "AXSecureTextField"
    )
}

/// An action as the model passes it to `perform_action`: `AXRaise` → `Raise`;
/// an app's own action keeps only its name.
pub fn action_name(action: &str) -> String {
    if let Some(rest) = action.split_once("Name:").map(|(_, rest)| rest) {
        return rest.lines().next().unwrap_or("").trim().to_string();
    }
    action.strip_prefix("AX").unwrap_or(action).to_string()
}

/// The actions worth listing: not plain press (that is `click`), not the
/// scrolling and menu actions every element repeats.
pub fn secondary_actions(element: &Element) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for action in &element.actions {
        let name = action_name(action);
        let keep = match name.as_str() {
            "" | "Press" | "ScrollToVisible" | "ShowDefaultUI" | "ShowAlternateUI" | "ShowMenu"
            | "Delete" | "ScrollLeftByPage" | "ScrollRightByPage" | "ScrollUpByPage"
            | "ScrollDownByPage" => false,
            "Increment" | "Decrement" => matches!(
                element.role.as_str(),
                "AXSlider" | "AXIncrementor" | "AXValueIndicator" | "AXLevelIndicator"
            ),
            "Confirm" | "Cancel" => matches!(
                element.role.as_str(),
                "AXTextField" | "AXComboBox" | "AXSheet" | "AXWindow" | "AXTextArea"
            ),
            _ => true,
        };
        if keep && !out.contains(&name) {
            out.push(name);
        }
    }
    out
}

/// One element's line, without id or indentation.
pub fn element_body(element: &Element) -> String {
    let mut line = role_label(&element.role, element.subrole.as_deref());
    let mut states = Vec::new();
    if !element.enabled {
        states.push("disabled");
    }
    if element.selected {
        states.push("selected");
    }
    match element.expanded {
        Some(true) => states.push("expanded"),
        Some(false) => states.push("collapsed"),
        None => {}
    }
    if element.settable {
        states.push("settable");
    }
    if !states.is_empty() {
        line.push_str(&format!(" ({})", states.join(", ")));
    }

    let text = |value: Option<&str>| value.map(clip).filter(|text| !text.is_empty());
    let title = text(element.title.as_deref());
    let mut value = text(element.value.as_deref());
    if is_toggle(&element.role) {
        value = value.map(|value| match value.as_str() {
            "1" | "true" => "on".into(),
            "0" | "false" => "off".into(),
            _ => value,
        });
    }
    let description = text(element.description.as_deref());

    let mut bare: Option<String> = None;
    let mut fields: Vec<String> = Vec::new();
    let mut seen: Vec<String> = Vec::new();
    if let Some(title) = title {
        seen.push(title.clone());
        bare = Some(title);
    }
    if let Some(value) = value.filter(|value| !seen.contains(value)) {
        seen.push(value.clone());
        if bare.is_none() && (value_is_text(&element.role) || is_toggle(&element.role)) {
            bare = Some(value);
        } else {
            fields.push(format!("Value: {value}"));
        }
    }
    if let Some(description) = description.filter(|text| !seen.contains(text)) {
        seen.push(description.clone());
        if bare.is_none() && fields.is_empty() {
            bare = Some(description);
        } else {
            fields.push(format!("Description: {description}"));
        }
    }
    if let Some(placeholder) = text(element.placeholder.as_deref()).filter(|t| !seen.contains(t)) {
        fields.push(format!("Placeholder: {placeholder}"));
    }
    if let Some(url) = text(element.url.as_deref()) {
        fields.push(format!("URL: {url}"));
    }
    let actions = secondary_actions(element);
    if !actions.is_empty() {
        fields.push(format!("Secondary Actions: {}", actions.join(", ")));
    }
    match (bare, fields.is_empty()) {
        (Some(bare), true) => line.push_str(&format!(" {bare}")),
        (Some(bare), false) => line.push_str(&format!(" {bare}, {}", fields.join(", "))),
        (None, false) => line.push_str(&format!(" {}", fields.join(", "))),
        (None, true) => {}
    }
    line
}

/// One rendered element: depth and body, without id.
#[derive(Debug, Clone, PartialEq)]
pub struct Line {
    pub depth: usize,
    pub body: String,
}

pub fn lines(state: &AppState) -> Vec<Line> {
    state
        .elements
        .iter()
        .map(|element| Line {
            depth: element.depth,
            body: element_body(element),
        })
        .collect()
}

/// `Window: "Title", App: Name.`
pub fn window_header(state: &AppState) -> String {
    let title = state
        .window_title
        .as_deref()
        .map(clip)
        .filter(|title| !title.is_empty())
        .unwrap_or_default();
    format!(
        "Window: \"{}\", App: {}.",
        title.replace('"', "'"),
        state.app.name
    )
}

fn numbered(marker: &str, id: usize, line: &Line) -> String {
    format!("{marker}{}{id} {}", "\t".repeat(line.depth), line.body)
}

/// The element that has keyboard focus, as a sentence.
fn focus_line(state: &AppState, lines: &[Line]) -> Option<String> {
    let index = state.elements.iter().rposition(|element| element.focused)?;
    Some(format!(
        "The focused UI element is {index} {}",
        lines[index].body
    ))
}

fn tail(state: &AppState, lines: &[Line], out: &mut String) {
    if let Some(focus) = focus_line(state, lines) {
        out.push('\n');
        out.push_str(&focus);
    }
    for note in &state.notes {
        out.push_str(&format!("\nNote: {note}"));
    }
}

/// The whole tree.
pub fn full_text(state: &AppState, lines: &[Line]) -> String {
    let mut out = window_header(state);
    for (id, line) in lines.iter().enumerate() {
        out.push('\n');
        out.push_str(&numbered("", id, line));
    }
    if lines.is_empty() {
        out.push_str("\n(no elements)");
    }
    tail(state, lines, &mut out);
    out
}

/// `1, 3-5, 9`.
fn ranges(ids: &[usize]) -> String {
    let mut parts = Vec::new();
    let mut i = 0;
    while i < ids.len() {
        let start = ids[i];
        let mut end = start;
        while i + 1 < ids.len() && ids[i + 1] == end + 1 {
            i += 1;
            end = ids[i];
        }
        parts.push(if start == end {
            start.to_string()
        } else {
            format!("{start}-{end}")
        });
        i += 1;
    }
    parts.join(", ")
}

#[derive(Debug, Clone, Copy, PartialEq)]
enum Op {
    /// Same line in both trees: (old, new).
    Same(usize, usize),
    Removed(usize),
    Added(usize),
}

/// Longest common subsequence alignment of two line lists.
fn align(old: &[Line], new: &[Line]) -> Vec<Op> {
    let prefix = old.iter().zip(new).take_while(|(a, b)| a == b).count();
    let suffix = old[prefix..]
        .iter()
        .rev()
        .zip(new[prefix..].iter().rev())
        .take_while(|(a, b)| a == b)
        .count();
    let a = &old[prefix..old.len() - suffix];
    let b = &new[prefix..new.len() - suffix];
    let mut ops: Vec<Op> = (0..prefix).map(|i| Op::Same(i, i)).collect();
    let (n, m) = (a.len(), b.len());
    // table[i][j]: LCS length of a[i..] and b[j..].
    let mut table = vec![0u16; (n + 1) * (m + 1)];
    let at = |i: usize, j: usize| i * (m + 1) + j;
    for i in (0..n).rev() {
        for j in (0..m).rev() {
            table[at(i, j)] = if a[i] == b[j] {
                table[at(i + 1, j + 1)] + 1
            } else {
                table[at(i + 1, j)].max(table[at(i, j + 1)])
            };
        }
    }
    let (mut i, mut j) = (0, 0);
    while i < n || j < m {
        if i < n && j < m && a[i] == b[j] {
            ops.push(Op::Same(prefix + i, prefix + j));
            i += 1;
            j += 1;
        } else if j < m && (i == n || table[at(i, j + 1)] >= table[at(i + 1, j)]) {
            ops.push(Op::Added(prefix + j));
            j += 1;
        } else {
            ops.push(Op::Removed(prefix + i));
            i += 1;
        }
    }
    let (old_end, new_end) = (old.len() - suffix, new.len() - suffix);
    ops.extend((0..suffix).map(|k| Op::Same(old_end + k, new_end + k)));
    ops
}

/// The role part of a body, to pair a changed line with its old self.
fn kind(body: &str) -> &str {
    body.split([' ', '(']).next().unwrap_or(body)
}

/// What changed from `old` to the current tree.
pub fn diff_text(old: &[Line], state: &AppState, new: &[Line]) -> String {
    let ops = align(old, new);
    // Pair a removed and an added line of the same depth and kind inside one
    // gap between unchanged lines: that is one element whose text changed.
    let mut marks: Vec<Option<&str>> = vec![None; new.len()];
    let mut removed: Vec<usize> = Vec::new();
    let mut gap_removed: Vec<usize> = Vec::new();
    let mut gap_added: Vec<usize> = Vec::new();
    let flush = |gap_removed: &mut Vec<usize>,
                 gap_added: &mut Vec<usize>,
                 marks: &mut Vec<Option<&str>>,
                 removed: &mut Vec<usize>| {
        let mut from = 0;
        for &j in gap_added.iter() {
            let pair = gap_removed[from..].iter().position(|&i| {
                old[i].depth == new[j].depth && kind(&old[i].body) == kind(&new[j].body)
            });
            match pair {
                Some(offset) => {
                    removed.extend(gap_removed[from..from + offset].iter().copied());
                    from += offset + 1;
                    marks[j] = Some("~");
                }
                None => marks[j] = Some("+"),
            }
        }
        removed.extend(gap_removed[from..].iter().copied());
        gap_removed.clear();
        gap_added.clear();
    };
    for op in &ops {
        match *op {
            Op::Same(i, j) => {
                flush(&mut gap_removed, &mut gap_added, &mut marks, &mut removed);
                if i != j {
                    marks[j] = Some("~");
                }
            }
            Op::Removed(i) => gap_removed.push(i),
            Op::Added(j) => gap_added.push(j),
        }
    }
    flush(&mut gap_removed, &mut gap_added, &mut marks, &mut removed);
    removed.sort_unstable();

    let header = window_header(state);
    let mut out;
    if removed.is_empty() && marks.iter().all(Option::is_none) {
        out = format!(
            "No changes in {} since the previous state ({} elements).",
            header.trim_end_matches('.'),
            new.len()
        );
    } else {
        out = format!(
            "Changes in {} since the previous state ({} elements; ~ changed, + added, others keep their IDs):",
            header.trim_end_matches('.'),
            new.len()
        );
        if !removed.is_empty() {
            out.push_str(&format!("\nRemoved element IDs: {}", ranges(&removed)));
        }
        for (j, mark) in marks.iter().enumerate() {
            if let Some(mark) = mark {
                out.push('\n');
                out.push_str(&numbered(mark, j, &new[j]));
            }
        }
    }
    tail(state, new, &mut out);
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

    fn state(elements: Vec<Element>) -> AppState {
        AppState {
            app: AppInfo {
                name: "Calculator".into(),
                pid: 42,
                path: None,
                frontmost: true,
            },
            window_title: Some("Calculator".into()),
            elements,
            notes: vec![],
        }
    }

    #[test]
    fn lines_read_like_a_short_description() {
        let mut window = element(0, "AXWindow", Some("Calculator"));
        window.subrole = Some("AXStandardWindow".into());
        window.actions = vec!["AXRaise".into(), "AXPress".into()];
        assert_eq!(
            element_body(&window),
            "standard window Calculator, Secondary Actions: Raise"
        );

        let mut switch = element(3, "AXCheckBox", None);
        switch.subrole = Some("AXSwitch".into());
        switch.value = Some("1".into());
        switch.settable = true;
        assert_eq!(element_body(&switch), "switch (settable) on");

        let mut combo = element(3, "AXPopUpButton", None);
        combo.value = Some("Info".into());
        combo.expanded = Some(false);
        combo.actions = vec!["AXShowMenu".into(), "AXPress".into()];
        assert_eq!(
            element_body(&combo),
            "pop up button (collapsed) Value: Info"
        );

        let mut field = element(2, "AXTextField", None);
        field.value = Some("hello \"world\"\nagain".into());
        field.placeholder = Some("Name".into());
        field.settable = true;
        assert_eq!(
            element_body(&field),
            "text field (settable) hello \"world\" again, Placeholder: Name"
        );

        let mut button = element(1, "AXButton", None);
        button.description = Some("7".into());
        button.enabled = false;
        assert_eq!(element_body(&button), "button (disabled) 7");

        let mut web = element(2, "AXWebArea", None);
        web.description = Some("Clash".into());
        web.url = Some("tauri://localhost/settings".into());
        assert_eq!(
            element_body(&web),
            "HTML content Clash, URL: tauri://localhost/settings"
        );
    }

    #[test]
    fn noisy_and_custom_actions_are_cleaned_up() {
        let mut item = element(1, "AXButton", Some("Mode"));
        item.actions = vec![
            "AXPress".into(),
            "AXIncrement".into(),
            "AXShowMenu".into(),
            "AXCancel".into(),
            "Name:Move left\nTarget:0x0\nSelector:(null)".into(),
        ];
        assert_eq!(secondary_actions(&item), vec!["Move left"]);
        let mut slider = element(1, "AXSlider", None);
        slider.actions = vec!["AXIncrement".into(), "AXDecrement".into()];
        assert_eq!(secondary_actions(&slider), vec!["Increment", "Decrement"]);
        assert_eq!(action_name("AXRaise"), "Raise");
    }

    #[test]
    fn the_full_tree_is_tab_indented_with_a_focus_line() {
        let mut field = element(1, "AXTextField", None);
        field.focused = true;
        let mut state = state(vec![element(0, "AXWindow", Some("Calculator")), field]);
        state.notes.push("partial".into());
        let text = full_text(&state, &lines(&state));
        assert_eq!(
            text,
            "Window: \"Calculator\", App: Calculator.\n0 window Calculator\n\t1 text field\nThe focused UI element is 1 text field\nNote: partial"
        );
    }

    #[test]
    fn long_text_is_clipped() {
        let long = "x".repeat(400);
        let body = element_body(&element(0, "AXStaticText", Some(&long)));
        assert!(body.chars().count() < 220);
        assert!(body.ends_with('…'));
    }

    fn tree(spec: &[(usize, &str, &str)]) -> AppState {
        state(
            spec.iter()
                .map(|(depth, role, title)| element(*depth, role, Some(title)))
                .collect(),
        )
    }

    #[test]
    fn a_diff_lists_changed_added_and_removed_elements() {
        let before = tree(&[
            (0, "AXWindow", "Calc"),
            (1, "AXStaticText", "0"),
            (1, "AXButton", "1"),
            (1, "AXButton", "2"),
            (1, "AXButton", "3"),
            (1, "AXButton", "4"),
            (1, "AXButton", "5"),
            (1, "AXButton", "6"),
            (1, "AXButton", "7"),
        ]);
        let after = tree(&[
            (0, "AXWindow", "Calc"),
            (1, "AXStaticText", "12"),
            (1, "AXButton", "1"),
            (1, "AXButton", "2"),
            (1, "AXButton", "4"),
            (1, "AXButton", "5"),
            (1, "AXButton", "6"),
            (1, "AXButton", "7"),
            (1, "AXButton", "new"),
        ]);
        let text = diff_text(&lines(&before), &after, &lines(&after));
        let body: Vec<&str> = text.lines().skip(1).collect();
        assert_eq!(
            body,
            vec![
                "Removed element IDs: 4",
                "~\t1 text 12",
                "~\t4 button 4",
                "~\t5 button 5",
                "~\t6 button 6",
                "~\t7 button 7",
                "+\t8 button new",
            ]
        );
    }

    #[test]
    fn an_unchanged_tree_says_so_and_a_renumbered_one_lists_every_line() {
        let before = tree(&[(0, "AXWindow", "Calc"), (1, "AXButton", "1")]);
        let text = diff_text(&lines(&before), &before, &lines(&before));
        assert!(text.starts_with("No changes in Window: \"Calculator\", App: Calculator since"));

        let many: Vec<(usize, &str, &str)> = (0..20).map(|_| (1, "AXButton", "b")).collect();
        let old = tree(&many);
        let mut shifted = vec![(1, "AXGroup", "top")];
        shifted.extend(many.iter().copied());
        let new = tree(&shifted);
        // One insertion at the top renumbers everything below it.
        let text = diff_text(&lines(&old), &new, &lines(&new));
        assert_eq!(
            text.lines().filter(|line| line.starts_with('~')).count(),
            20
        );
        assert!(text.contains("+\t0 group top"));
    }

    #[test]
    fn removed_ids_collapse_into_ranges() {
        assert_eq!(ranges(&[1, 3, 4, 5, 9, 10]), "1, 3-5, 9-10");
        assert_eq!(ranges(&[]), "");
    }
}
