//! Menu bar reading and invocation over Accessibility (`AXMenuBar`).

use std::thread::sleep;
use std::time::Duration;

use anyhow::{anyhow, bail, Result};
use core_foundation_sys::base::CFTypeRef;

use super::ax;
use super::cf::Cf;

fn normalize_menu_title(title: &str) -> &str {
    let trimmed = title.trim();
    trimmed
        .strip_suffix('…')
        .or_else(|| trimmed.strip_suffix("..."))
        .unwrap_or(trimmed)
        .trim_end()
}

/// Exact or case-insensitive match, tolerating trailing ellipses (`Save As` -> `Save As…`).
pub fn menu_title_matches(actual: &str, wanted: &str) -> bool {
    let a = actual.trim();
    let w = wanted.trim();
    if a.is_empty() || w.is_empty() {
        return false;
    }
    if a == w || a.eq_ignore_ascii_case(w) {
        return true;
    }
    let a_norm = normalize_menu_title(a);
    let w_norm = normalize_menu_title(w);
    a_norm == w_norm || a_norm.eq_ignore_ascii_case(w_norm)
}

fn menu_item_title(element: CFTypeRef) -> Option<String> {
    ax::text(element, "AXTitle").or_else(|| ax::text(element, "AXDescription"))
}

fn is_apple_menu(title: &str) -> bool {
    let trimmed = title.trim();
    trimmed.eq_ignore_ascii_case("Apple") || trimmed == "苹果"
}

/// Top-level app menu bar item names (excluding the system Apple menu).
pub fn top_bar_titles(app: CFTypeRef) -> Vec<String> {
    let Some(bar) = ax::attribute(app, "AXMenuBar") else {
        return Vec::new();
    };
    ax::children(bar.raw())
        .into_iter()
        .enumerate()
        .filter_map(|(index, item)| {
            let title = menu_item_title(item.raw())?;
            if index == 0 && is_apple_menu(&title) {
                return None;
            }
            Some(title)
        })
        .collect()
}

fn submenu_items(container: CFTypeRef) -> Vec<Cf> {
    let children = ax::children(container);
    if let Some(menu) = children
        .iter()
        .find(|child| ax::text(child.raw(), "AXRole").as_deref() == Some("AXMenu"))
    {
        return ax::children(menu.raw());
    }
    children
}

/// Trigger a menu item along `path` (e.g. `["File", "Save"]`).
pub fn press_menu_path(app: CFTypeRef, path: &[String]) -> Result<()> {
    if path.is_empty() {
        bail!("menu path cannot be empty");
    }
    let bar = ax::attribute(app, "AXMenuBar")
        .ok_or_else(|| anyhow!("this app exposes no menu bar right now"))?;
    let mut candidates = ax::children(bar.raw());

    for (depth, wanted) in path.iter().enumerate() {
        let mut available = Vec::new();
        let mut matched: Option<Cf> = None;
        for candidate in candidates {
            let Some(title) = menu_item_title(candidate.raw()) else {
                continue;
            };
            if title.trim().is_empty() {
                continue;
            }
            if matched.is_none() && menu_title_matches(&title, wanted) {
                matched = Some(candidate);
                break;
            }
            available.push(title);
        }
        let Some(chosen) = matched else {
            let level = path[..=depth].join(" > ");
            let list = if available.is_empty() {
                "none".to_string()
            } else {
                available.join(", ")
            };
            bail!("menu item \"{level}\" was not found (available: {list})");
        };

        if depth + 1 == path.len() {
            if !ax::is_enabled(chosen.raw()) {
                bail!("menu item \"{}\" is disabled", path.join(" > "));
            }
            return ax::perform(chosen.raw(), "AXPress");
        }

        let mut next = submenu_items(chosen.raw());
        if next.is_empty() {
            // Dynamic NSMenu/Electron submenus may populate lazily when opened.
            if ax::perform(chosen.raw(), "AXPress").is_ok() {
                sleep(Duration::from_millis(100));
                next = submenu_items(chosen.raw());
            }
        }
        if next.is_empty() {
            bail!(
                "menu item \"{}\" has no submenu items",
                path[..=depth].join(" > ")
            );
        }
        candidates = next;
    }

    Err(anyhow!("menu path ended without an action"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn menu_titles_match_case_and_trailing_ellipses() {
        assert!(menu_title_matches("File", "file"));
        assert!(menu_title_matches("Save As…", "Save As"));
        assert!(menu_title_matches("Save As...", "save as"));
        assert!(menu_title_matches("新建窗口…", "新建窗口"));
        assert!(menu_title_matches("  Export  ", "export"));
        assert!(!menu_title_matches("Save", "Save As"));
        assert!(!menu_title_matches("", "File"));
        assert!(!menu_title_matches("File", ""));
    }
}
