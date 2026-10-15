//! Per-category resource indexes (mc-agent R3).
//!
//! Documents that already live in a workspace are not copied into the
//! resource folder; the category folder keeps an `INDEX.md` listing them as
//! Markdown links, so the original stays the single copy to maintain:
//!
//! ```text
//! # Index
//!
//! - [Login page](<../../../code/web/docs/login-page.md>)
//! - [Design board](<https://example.com/board>)
//! ```
//!
//! Relative paths are resolved from the index file's folder. `INDEX.md` at the
//! resource folder root holds uncategorized entries. Lines that are not list
//! links are kept untouched when entries are added or removed.

use std::fs;
use std::path::{Component, Path, PathBuf};

use anyhow::{anyhow, Context, Result};

pub const INDEX_FILE: &str = "INDEX.md";
const NEW_INDEX: &str = "# Index\n\n";

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum IndexTarget {
    /// Lexically resolved absolute path; not checked for existence.
    Path(PathBuf),
    Url(String),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IndexEntry {
    /// `index:<category>/<raw target>`; stable while the line is unchanged.
    pub key: String,
    pub category: String,
    pub title: String,
    pub raw: String,
    pub target: IndexTarget,
}

/// Every entry of the root index and of each first-level category index.
pub fn read_all(resource_root: &Path) -> Result<Vec<IndexEntry>> {
    let mut entries = read_index(resource_root, "")?;
    let mut categories = Vec::new();
    for entry in fs::read_dir(resource_root)? {
        let entry = entry?;
        let name = entry.file_name().to_string_lossy().into_owned();
        if entry.file_type()?.is_dir() && !name.starts_with('.') {
            categories.push(name);
        }
    }
    categories.sort();
    for category in categories {
        entries.extend(read_index(resource_root, &category)?);
    }
    Ok(entries)
}

/// Append a link to `category`'s index, creating the file when needed.
/// `target` is either an http(s) URL or an absolute file path, which is
/// written relative to the index file.
pub fn add(
    resource_root: &Path,
    category: &str,
    title: &str,
    target: &IndexTarget,
) -> Result<String> {
    let folder = category_folder(resource_root, category)?;
    fs::create_dir_all(&folder)?;
    let raw = match target {
        IndexTarget::Url(url) => url.clone(),
        IndexTarget::Path(path) => relative_path(&folder, path)
            .ok_or_else(|| anyhow!("cannot express {} relative to the index", path.display()))?,
    };
    if raw.contains(['<', '>', '\n']) {
        return Err(anyhow!("resource target cannot contain < > or line breaks"));
    }
    let existing = read_index(resource_root, category)?;
    if existing
        .iter()
        .any(|entry| entry.raw == raw || entry.target == *target)
    {
        return Err(anyhow!(
            "resource is already in the {} index",
            display_category(category)
        ));
    }
    let title = title.replace(['[', ']', '\n'], " ");
    let file = folder.join(INDEX_FILE);
    let mut text = match fs::read_to_string(&file) {
        Ok(text) => text,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => NEW_INDEX.to_string(),
        Err(error) => return Err(error).context("read INDEX.md"),
    };
    if !text.is_empty() && !text.ends_with('\n') {
        text.push('\n');
    }
    text.push_str(&format!("- [{}](<{raw}>)\n", title.trim()));
    write_atomically(&file, &text)?;
    Ok(key(category, &raw))
}

/// Remove the line behind `key`. The linked file is never touched.
pub fn remove(resource_root: &Path, key_to_remove: &str) -> Result<()> {
    let (category, raw) = split_key(key_to_remove)?;
    let file = category_folder(resource_root, category)?.join(INDEX_FILE);
    let text = fs::read_to_string(&file).context("read INDEX.md")?;
    let mut removed = false;
    let kept: Vec<&str> = text
        .split_inclusive('\n')
        .filter(|line| {
            let matches = !removed && parse_line(line).is_some_and(|(_, target)| target == raw);
            removed |= matches;
            !matches
        })
        .collect();
    if !removed {
        return Err(anyhow!("resource not found: {key_to_remove}"));
    }
    write_atomically(&file, &kept.concat())
}

pub fn find(resource_root: &Path, wanted: &str) -> Result<IndexEntry> {
    let (category, _) = split_key(wanted)?;
    read_index(resource_root, category)?
        .into_iter()
        .find(|entry| entry.key == wanted)
        .ok_or_else(|| anyhow!("resource not found: {wanted}"))
}

pub fn key(category: &str, raw: &str) -> String {
    format!("index:{category}/{raw}")
}

fn split_key(key: &str) -> Result<(&str, &str)> {
    key.strip_prefix("index:")
        .and_then(|rest| rest.split_once('/'))
        .ok_or_else(|| anyhow!("unknown resource key: {key}"))
}

fn read_index(resource_root: &Path, category: &str) -> Result<Vec<IndexEntry>> {
    let folder = category_folder(resource_root, category)?;
    let text = match fs::read_to_string(folder.join(INDEX_FILE)) {
        Ok(text) => text,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(error).context("read INDEX.md"),
    };
    let mut entries = Vec::new();
    for line in text.lines() {
        let Some((title, raw)) = parse_line(line) else {
            continue;
        };
        let target = if raw.starts_with("https://") || raw.starts_with("http://") {
            IndexTarget::Url(raw.to_string())
        } else {
            IndexTarget::Path(normalize(&folder.join(raw)))
        };
        entries.push(IndexEntry {
            key: key(category, raw),
            category: category.to_string(),
            title: if title.is_empty() {
                raw.to_string()
            } else {
                title.to_string()
            },
            raw: raw.to_string(),
            target,
        });
    }
    Ok(entries)
}

/// `- [title](target)` or `- [title](<target>)`, with `-`, `*` or `+`.
fn parse_line(line: &str) -> Option<(&str, &str)> {
    let rest = line.trim().strip_prefix(['-', '*', '+'])?.trim_start();
    let rest = rest.strip_prefix('[')?;
    let (title, rest) = rest.split_once("](")?;
    let target = rest.trim_end().strip_suffix(')')?;
    let target = target
        .strip_prefix('<')
        .and_then(|inner| inner.strip_suffix('>'))
        .unwrap_or(target)
        .trim();
    (!target.is_empty()).then_some((title.trim(), target))
}

fn category_folder(resource_root: &Path, category: &str) -> Result<PathBuf> {
    if category.is_empty() {
        return Ok(resource_root.to_path_buf());
    }
    if category.contains(['/', '\\']) || category.starts_with('.') {
        return Err(anyhow!("invalid resource category: {category}"));
    }
    Ok(resource_root.join(category))
}

fn display_category(category: &str) -> &str {
    if category.is_empty() {
        "root"
    } else {
        category
    }
}

/// Resolve `.` and `..` without touching the disk.
fn normalize(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for component in path.components() {
        match component {
            Component::ParentDir => {
                out.pop();
            }
            Component::CurDir => {}
            other => out.push(other),
        }
    }
    out
}

/// `to` relative to the directory `from`, both absolute.
fn relative_path(from: &Path, to: &Path) -> Option<String> {
    let from = normalize(from);
    let to = normalize(to);
    let from: Vec<_> = from.components().collect();
    let to: Vec<_> = to.components().collect();
    if from.first() != to.first() {
        return None;
    }
    let common = from.iter().zip(&to).take_while(|(a, b)| a == b).count();
    let mut parts: Vec<String> =
        std::iter::repeat_n("..".to_string(), from.len() - common).collect();
    parts.extend(
        to[common..]
            .iter()
            .map(|part| part.as_os_str().to_string_lossy().into_owned()),
    );
    Some(parts.join("/"))
}

fn write_atomically(file: &Path, text: &str) -> Result<()> {
    let temp = file.with_extension(format!("md.{}.tmp", std::process::id()));
    fs::write(&temp, text)?;
    if let Err(error) = fs::rename(&temp, file) {
        let _ = fs::remove_file(&temp);
        return Err(error).context("replace INDEX.md");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn links_round_trip_relative_to_the_category_index() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("docs/App");
        let doc = dir.path().join("code/web/docs/login page.md");
        fs::create_dir_all(root.join("requirements")).unwrap();
        fs::create_dir_all(doc.parent().unwrap()).unwrap();
        fs::write(&doc, "x").unwrap();

        let key = add(
            &root,
            "requirements",
            "登录页",
            &IndexTarget::Path(doc.clone()),
        )
        .unwrap();
        assert_eq!(
            key,
            "index:requirements/../../../code/web/docs/login page.md"
        );
        let text = fs::read_to_string(root.join("requirements/INDEX.md")).unwrap();
        assert_eq!(
            text,
            "# Index\n\n- [登录页](<../../../code/web/docs/login page.md>)\n"
        );

        let url = add(
            &root,
            "",
            "Board",
            &IndexTarget::Url("https://example.com/b".into()),
        )
        .unwrap();
        let entries = read_all(&root).unwrap();
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].key, url);
        assert_eq!(entries[1].target, IndexTarget::Path(normalize(&doc)));
        assert!(add(&root, "requirements", "again", &IndexTarget::Path(doc)).is_err());
    }

    #[test]
    fn hand_written_indexes_are_read_and_other_lines_survive_removal() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("App");
        fs::create_dir_all(root.join("reference")).unwrap();
        fs::write(
            root.join("reference/INDEX.md"),
            "# 参考\n\n说明文字。\n\n* [API](../../server/api.md)\n- [Spec](<https://example.com/spec>)\n- not a link\n",
        )
        .unwrap();
        let entries = read_all(&root).unwrap();
        assert_eq!(
            entries.iter().map(|e| e.title.as_str()).collect::<Vec<_>>(),
            ["API", "Spec"]
        );
        assert_eq!(
            entries[0].target,
            IndexTarget::Path(dir.path().join("server/api.md"))
        );

        remove(&root, &entries[0].key).unwrap();
        assert_eq!(
            fs::read_to_string(root.join("reference/INDEX.md")).unwrap(),
            "# 参考\n\n说明文字。\n\n- [Spec](<https://example.com/spec>)\n- not a link\n"
        );
        assert!(remove(&root, &entries[0].key).is_err());
        assert!(find(&root, &entries[1].key).is_ok());
    }

    #[test]
    fn bad_categories_and_targets_are_refused() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("App");
        fs::create_dir_all(&root).unwrap();
        let url = IndexTarget::Url("https://example.com/x".into());
        assert!(add(&root, "../escape", "x", &url).is_err());
        assert!(add(&root, ".hidden", "x", &url).is_err());
        assert!(add(
            &root,
            "",
            "x",
            &IndexTarget::Url("https://e.com/<x>".into())
        )
        .is_err());
        assert!(split_key("folder:a").is_err());
    }
}
