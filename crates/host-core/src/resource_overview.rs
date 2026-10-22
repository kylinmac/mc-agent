//! The resource folder's overview: `RESOURCES.md` at its root (mc-agent).
//!
//! One file that tells a person or an agent what the project's documents are
//! and where: every category with its description from the project's
//! template, then every resource (files in the folder and entries registered
//! in the per-category `INDEX.md` files) with a one-line summary and its
//! status. Agents are pointed at it in the project-folders note instead of
//! being given the list in the system prompt.
//!
//! The file has two parts. Everything above [`MARKER`] belongs to the user
//! and is kept as written; everything below it is rewritten from the listing
//! whenever it would change, so nobody (and no agent) has to maintain it.

use std::collections::BTreeMap;
use std::fs;
use std::io::Read;
use std::path::Path;

use anyhow::Result;

use crate::resource_catalog::{ResourceItem, ResourceListing, ResourceSource, ResourceStatus};

pub const OVERVIEW_FILE: &str = "RESOURCES.md";
pub const MARKER: &str =
    "<!-- mc-agent: the list below is generated from the resource folder; edit above this line -->";

const DEFAULT_HEAD: &str = "# Resource index

What this project's resource folder holds. Notes for people and agents go
here, above the line; mc-agent keeps the list below it current.

";

/// How much of a text file is read for its summary.
const SUMMARY_BYTES: usize = 4 * 1024;
const SUMMARY_CHARS: usize = 120;

/// The overview as it should read now, keeping the user's part of `current`.
pub fn render(
    current: Option<&str>,
    listing: &ResourceListing,
    descriptions: &BTreeMap<String, String>,
) -> String {
    let head = current
        .and_then(|text| text.split_once(MARKER).map(|(head, _)| head.to_string()))
        .unwrap_or_else(|| DEFAULT_HEAD.to_string());
    let mut out = head;
    if !out.ends_with('\n') {
        out.push('\n');
    }
    out.push_str(MARKER);
    out.push('\n');

    let mut by_category: BTreeMap<&str, Vec<&ResourceItem>> = BTreeMap::new();
    for item in &listing.items {
        by_category
            .entry(item.category.as_str())
            .or_default()
            .push(item);
    }
    let mut order: Vec<&str> = listing.categories.iter().map(String::as_str).collect();
    for category in by_category.keys() {
        if !category.is_empty() && !order.contains(category) {
            order.push(category);
        }
    }
    for category in order {
        out.push_str(&format!("\n## {category}\n"));
        if let Some(description) = descriptions.get(category).filter(|text| !text.is_empty()) {
            out.push_str(&format!("\n{description}\n"));
        }
        out.push('\n');
        match by_category.get(category) {
            Some(items) => {
                for item in items {
                    out.push_str(&line(item));
                }
            }
            None => out.push_str("- (empty)\n"),
        }
    }
    if let Some(items) = by_category.get("") {
        out.push_str("\n## (uncategorized)\n\n");
        for item in items {
            out.push_str(&line(item));
        }
    }
    if listing.truncated {
        out.push_str("\n_The folder has more files than are listed here._\n");
    }
    out
}

fn line(item: &ResourceItem) -> String {
    let target = match (&item.url, &item.path) {
        (Some(url), _) => url.clone(),
        (None, Some(path)) => path.clone(),
        (None, None) => item.key.clone(),
    };
    let summary = item
        .path
        .as_deref()
        .filter(|_| item.status != ResourceStatus::Missing)
        .and_then(|path| summary_of(Path::new(path)))
        .map(|text| format!(" — {text}"))
        .unwrap_or_default();
    let linked = match item.source {
        ResourceSource::Folder => "",
        ResourceSource::Workspace => " · linked",
        ResourceSource::Url => " · link",
    };
    format!(
        "- [{}](<{}>){summary} · {}{linked}\n",
        item.title.replace(['[', ']'], ""),
        target,
        status_word(item.status)
    )
}

fn status_word(status: ResourceStatus) -> &'static str {
    match status {
        ResourceStatus::Draft => "draft",
        ResourceStatus::Confirmed => "confirmed",
        ResourceStatus::Changed => "changed since confirmed",
        ResourceStatus::Deprecated => "deprecated",
        ResourceStatus::Missing => "missing",
    }
}

/// A Markdown or text file's first heading, else its first non-empty line.
fn summary_of(path: &Path) -> Option<String> {
    let extension = path.extension()?.to_string_lossy().to_lowercase();
    if !matches!(extension.as_str(), "md" | "markdown" | "txt") {
        return None;
    }
    let mut buffer = vec![0u8; SUMMARY_BYTES];
    let read = fs::File::open(path).ok()?.read(&mut buffer).ok()?;
    let text = String::from_utf8_lossy(&buffer[..read]);
    let mut lines = text
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty() && !line.starts_with("<!--") && *line != "---");
    let first = lines.next()?;
    let summary = first.trim_start_matches('#').trim();
    if summary.is_empty() {
        return None;
    }
    let clipped: String = summary.chars().take(SUMMARY_CHARS).collect();
    Some(if summary.chars().count() > SUMMARY_CHARS {
        format!("{clipped}…")
    } else {
        clipped
    })
}

/// The category descriptions of the template the project recorded, if any.
pub fn template_descriptions(resource_root: &Path) -> BTreeMap<String, String> {
    let Ok(Some(meta)) = crate::resource_templates::read_project_meta(resource_root) else {
        return BTreeMap::new();
    };
    let Ok(home) = crate::resource_dirs::home_dir() else {
        return BTreeMap::new();
    };
    let template = home
        .join(crate::resource_dirs::TEMPLATES_DIR)
        .join(&meta.template);
    crate::resource_templates::read_template_meta(&template)
        .map(|meta| meta.categories)
        .unwrap_or_default()
}

/// Rewrite `RESOURCES.md` when the listing changed it; true when written.
pub fn write_if_changed(
    resource_root: &Path,
    listing: &ResourceListing,
    descriptions: &BTreeMap<String, String>,
) -> Result<bool> {
    let file = resource_root.join(OVERVIEW_FILE);
    let current = fs::read_to_string(&file).ok();
    let next = render(current.as_deref(), listing, descriptions);
    if current.as_deref() == Some(next.as_str()) {
        return Ok(false);
    }
    fs::write(&file, next)?;
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::resource_catalog::ResourceSummary;

    fn item(
        key: &str,
        category: &str,
        title: &str,
        path: Option<&str>,
        status: ResourceStatus,
    ) -> ResourceItem {
        ResourceItem {
            key: key.into(),
            source: if key.starts_with("folder:") {
                ResourceSource::Folder
            } else {
                ResourceSource::Url
            },
            category: category.into(),
            title: title.into(),
            path: path.map(Into::into),
            url: (!key.starts_with("folder:")).then(|| "https://example.com/board".into()),
            status,
            confirmed_at: None,
        }
    }

    #[test]
    fn the_list_is_generated_and_the_users_part_kept() {
        let dir = tempfile::tempdir().unwrap();
        let spec = dir.path().join("requirements/login.md");
        fs::create_dir_all(spec.parent().unwrap()).unwrap();
        fs::write(&spec, "\n# Login flow\n\nDetails…").unwrap();
        let listing = ResourceListing {
            items: vec![
                item(
                    "folder:requirements/login.md",
                    "requirements",
                    "login.md",
                    spec.to_str(),
                    ResourceStatus::Confirmed,
                ),
                item(
                    "index:design/x",
                    "design",
                    "Board",
                    None,
                    ResourceStatus::Draft,
                ),
                item(
                    "folder:notes.md",
                    "",
                    "notes.md",
                    None,
                    ResourceStatus::Missing,
                ),
            ],
            summary: ResourceSummary::default(),
            categories: vec!["architecture".into(), "requirements".into()],
            truncated: false,
        };
        let descriptions =
            BTreeMap::from([("requirements".to_string(), "User stories".to_string())]);

        assert!(write_if_changed(dir.path(), &listing, &descriptions).unwrap());
        let text = fs::read_to_string(dir.path().join(OVERVIEW_FILE)).unwrap();
        assert!(text.starts_with("# Resource index"));
        assert!(text.contains("## architecture\n\n- (empty)"));
        assert!(text.contains("## requirements\n\nUser stories\n"));
        assert!(text.contains("— Login flow · confirmed"));
        assert!(
            text.contains("## design"),
            "categories only known from INDEX.md still appear"
        );
        assert!(text.contains("[Board](<https://example.com/board>) · draft · link"));
        assert!(text.contains("## (uncategorized)\n\n- [notes.md](<folder:notes.md>) · missing"));
        // Unchanged: not written again.
        assert!(!write_if_changed(dir.path(), &listing, &descriptions).unwrap());

        // The user's notes above the line survive a rewrite.
        let edited = text.replacen("# Resource index", "# 资料索引\n\n先读需求，再看架构。", 1);
        fs::write(dir.path().join(OVERVIEW_FILE), &edited).unwrap();
        let fewer = ResourceListing {
            items: listing.items[..1].to_vec(),
            ..listing
        };
        assert!(write_if_changed(dir.path(), &fewer, &descriptions).unwrap());
        let text = fs::read_to_string(dir.path().join(OVERVIEW_FILE)).unwrap();
        assert!(text.starts_with("# 资料索引\n\n先读需求，再看架构。"));
        assert!(!text.contains("Board"));
    }
}
