//! In-app template editing (mc-agent R1.4).
//!
//! A template is a folder below `<home>/templates`; its first-level folders
//! are the resource categories, and folders may nest (`requirements/api`).
//! `template.json` holds a description per folder, keyed by relative path.
//! Saving creates missing folders, removes dropped ones only while they are
//! empty, and bumps the version whenever folders or descriptions change, so
//! projects created from it see the template as changed. Starter
//! files inside the folder are edited in Finder. Deleting moves the folder to
//! `templates/.trash/`, which listings skip, instead of erasing it.

use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};

use anyhow::{anyhow, Context, Result};
use serde::Deserialize;

use crate::resource_dirs::{self, TEMPLATES_DIR};
use crate::resource_templates::{
    read_template_meta, write_template_meta, TemplateMeta, TemplateTarget,
};

const TRASH_DIR: &str = ".trash";
const MAX_FOLDERS: usize = 200;
const MAX_DESCRIPTION_CHARS: usize = 500;

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CategoryInput {
    /// A folder's path relative to the template, `/`-separated.
    pub name: String,
    #[serde(default)]
    pub description: String,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TemplateInput {
    pub name: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub categories: Vec<CategoryInput>,
    /// Create a new template; with `copy_from`, start from that template's
    /// folder (starter files included). Without `create`, `name` must exist.
    #[serde(default)]
    pub create: bool,
    #[serde(default)]
    pub copy_from: Option<String>,
    /// What the template sets up; kept as it was when omitted.
    #[serde(default)]
    pub target: Option<TemplateTarget>,
}

/// Create or update a template and return its metadata as saved.
pub fn save(home: &Path, input: &TemplateInput) -> Result<TemplateMeta> {
    resource_dirs::seed_builtin_templates(home)?;
    let templates = home.join(TEMPLATES_DIR);
    let name = input.name.trim();
    resource_dirs::validate_template_name(name)?;
    if name.chars().count() > resource_dirs::MAX_NAME_CHARS {
        return Err(anyhow!("template name is too long"));
    }
    let description = bounded(&input.description, "template description")?;
    let wanted = wanted_categories(&input.categories)?;
    let root = templates.join(name);

    if input.create {
        if root.exists() {
            return Err(anyhow!("template already exists: {name}"));
        }
        let source = match input.copy_from.as_deref().map(str::trim) {
            Some(from) if !from.is_empty() => {
                resource_dirs::validate_template_name(from)?;
                let source = templates.join(from);
                if !source.is_dir() {
                    return Err(anyhow!("template not found: {from}"));
                }
                Some(source)
            }
            _ => None,
        };
        fs::create_dir_all(&root).with_context(|| format!("create {}", root.display()))?;
        let created = (|| -> Result<TemplateMeta> {
            if let Some(source) = &source {
                resource_dirs::copy_template(source, &root)?;
            }
            let target = input.target.unwrap_or_default();
            check_folders_for(target, &wanted)?;
            apply(
                &root,
                &description,
                &wanted,
                target,
                TemplateMeta::default(),
                true,
            )
        })();
        if created.is_err() {
            // The folder was made by this call and holds only copied content.
            let _ = fs::remove_dir_all(&root);
        }
        return created;
    }

    if !root.is_dir() {
        return Err(anyhow!("template not found: {name}"));
    }
    let previous = read_template_meta(&root)?;
    let target = input.target.unwrap_or(previous.target);
    check_folders_for(target, &wanted)?;
    apply(&root, &description, &wanted, target, previous, false)
}

/// Move a user template to `templates/.trash/`. Built-in templates are kept:
/// they would be seeded again on the next listing.
pub fn delete(home: &Path, name: &str) -> Result<PathBuf> {
    let name = name.trim();
    resource_dirs::validate_template_name(name)?;
    if resource_dirs::is_builtin_template(name) {
        return Err(anyhow!("built-in templates cannot be deleted"));
    }
    let templates = home.join(TEMPLATES_DIR);
    let root = templates.join(name);
    if !root.is_dir() {
        return Err(anyhow!("template not found: {name}"));
    }
    let trash = templates.join(TRASH_DIR);
    fs::create_dir_all(&trash)?;
    let mut target = trash.join(format!("{name}-{}", crate::db::now_ms()));
    let mut attempt = 1;
    while target.exists() {
        attempt += 1;
        target = trash.join(format!("{name}-{}-{attempt}", crate::db::now_ms()));
    }
    fs::rename(&root, &target).with_context(|| format!("move {} to the trash", root.display()))?;
    Ok(target)
}

fn apply(
    root: &Path,
    description: &str,
    wanted: &BTreeMap<String, String>,
    target: TemplateTarget,
    previous: TemplateMeta,
    created: bool,
) -> Result<TemplateMeta> {
    let existing: BTreeSet<String> = resource_dirs::template_folders(root)?.into_iter().collect();
    let dropped: BTreeSet<&String> = existing
        .iter()
        .filter(|name| !wanted.contains_key(*name))
        .collect();
    // Check every removal before touching the disk, so a refusal changes nothing.
    for name in &dropped {
        if !only_dropped_inside(root, name, &dropped)? {
            return Err(anyhow!(
                "folder {name} still has files; empty it in Finder before removing it"
            ));
        }
    }
    // Children first, so each folder is empty when its turn comes.
    let mut removals: Vec<&&String> = dropped.iter().collect();
    removals.sort_by_key(|name| std::cmp::Reverse(name.matches('/').count()));
    for name in removals {
        let folder = root.join(name.as_str());
        let _ = fs::remove_file(folder.join(".DS_Store"));
        fs::remove_dir(&folder).with_context(|| format!("remove {}", folder.display()))?;
    }
    for name in wanted.keys() {
        fs::create_dir_all(root.join(name))?;
    }

    let categories: BTreeMap<String, String> = wanted
        .iter()
        .filter(|(_, text)| !text.is_empty())
        .map(|(name, text)| (name.clone(), text.clone()))
        .collect();
    let structure_changed =
        !dropped.is_empty() || wanted.keys().any(|name| !existing.contains(name));
    let changed = structure_changed
        || previous.description != description
        || previous.categories != categories
        || previous.target != target;
    let version = if created {
        1
    } else if changed {
        previous.version.max(1) + 1
    } else {
        previous.version.max(1)
    };
    let meta = TemplateMeta {
        version,
        description: description.to_string(),
        categories,
        target,
    };
    if created || changed {
        write_template_meta(root, &meta)?;
    }
    Ok(meta)
}

/// The folders asked for, by relative path. A nested folder brings its
/// parents along, so the tree never has a gap.
pub(crate) fn wanted_categories(input: &[CategoryInput]) -> Result<BTreeMap<String, String>> {
    if input.len() > MAX_FOLDERS {
        return Err(anyhow!("a template can have at most {MAX_FOLDERS} folders"));
    }
    let mut wanted = BTreeMap::new();
    for category in input {
        let name = category.name.trim();
        let parts: Vec<&str> = name.split('/').collect();
        if parts.len() > resource_dirs::MAX_FOLDER_DEPTH {
            return Err(anyhow!("folder is nested too deep: {name}"));
        }
        for part in &parts {
            resource_dirs::validate_template_name(part)
                .map_err(|_| anyhow!("invalid folder name: {name}"))?;
            if part.chars().count() > resource_dirs::MAX_NAME_CHARS {
                return Err(anyhow!("folder name is too long: {name}"));
            }
        }
        let text = bounded(&category.description, "folder description")?;
        if wanted.insert(name.to_string(), text).is_some() {
            return Err(anyhow!("duplicate folder: {name}"));
        }
    }
    let parents: Vec<String> = wanted
        .keys()
        .flat_map(|name| {
            let parts: Vec<&str> = name.split('/').collect();
            (1..parts.len()).map(move |end| parts[..end].join("/"))
        })
        .collect();
    for parent in parents {
        wanted.entry(parent).or_default();
    }
    if wanted.len() > MAX_FOLDERS {
        return Err(anyhow!("a template can have at most {MAX_FOLDERS} folders"));
    }
    Ok(wanted)
}

/// A creative template's folders become studio categories, so they follow the
/// studio's rules (reserved names, characters) as well.
fn check_folders_for(target: TemplateTarget, wanted: &BTreeMap<String, String>) -> Result<()> {
    if target == TemplateTarget::Creative {
        for name in wanted.keys() {
            crate::mc_creative::normalize_category(name)
                .map_err(|error| anyhow!("{name}: {error:#}"))?;
        }
    }
    Ok(())
}

pub(crate) fn bounded(text: &str, what: &str) -> Result<String> {
    let text = text.trim();
    if text.chars().count() > MAX_DESCRIPTION_CHARS {
        return Err(anyhow!("{what} is too long"));
    }
    if text.contains(['\n', '\r']) {
        return Err(anyhow!("{what} must be one line"));
    }
    Ok(text.to_string())
}

#[cfg(test)]
fn first_level_folders(root: &Path) -> Result<BTreeSet<String>> {
    let mut names = BTreeSet::new();
    for entry in fs::read_dir(root)? {
        let entry = entry?;
        let name = entry.file_name().to_string_lossy().into_owned();
        if entry.file_type()?.is_dir() && !name.starts_with('.') {
            names.insert(name);
        }
    }
    Ok(names)
}

/// Does `name` hold nothing but `.DS_Store` and folders that are dropped too?
fn only_dropped_inside(root: &Path, name: &str, dropped: &BTreeSet<&String>) -> Result<bool> {
    for entry in fs::read_dir(root.join(name))? {
        let entry = entry?;
        let file = entry.file_name().to_string_lossy().into_owned();
        if file == ".DS_Store" {
            continue;
        }
        let child = format!("{name}/{file}");
        if !(entry.file_type()?.is_dir() && dropped.iter().any(|d| **d == child)) {
            return Ok(false);
        }
    }
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn input(name: &str, categories: &[(&str, &str)]) -> TemplateInput {
        TemplateInput {
            name: name.into(),
            description: String::new(),
            categories: categories
                .iter()
                .map(|(name, description)| CategoryInput {
                    name: (*name).into(),
                    description: (*description).into(),
                })
                .collect(),
            create: false,
            copy_from: None,
            target: None,
        }
    }

    #[test]
    fn a_new_template_can_start_from_another_and_gets_version_one() {
        let dir = tempfile::tempdir().unwrap();
        let home = dir.path();
        let mut new = input(
            "research",
            &[("notes", "Field notes"), ("requirements", "")],
        );
        new.create = true;
        new.copy_from = Some("software".into());
        new.description = "Research project".into();
        let meta = save(home, &new).unwrap();
        assert_eq!(meta.version, 1);
        assert_eq!(meta.categories.get("notes").unwrap(), "Field notes");

        let root = home.join("templates/research");
        // Copied starter files stay; the category set is exactly what was asked.
        assert!(root.join("AGENTS.md").is_file());
        assert_eq!(
            first_level_folders(&root)
                .unwrap()
                .into_iter()
                .collect::<Vec<_>>(),
            ["notes", "requirements"]
        );
        assert!(save(home, &new).is_err(), "names are unique");
    }

    #[test]
    fn edits_bump_the_version_and_refuse_to_drop_folders_with_files() {
        let dir = tempfile::tempdir().unwrap();
        let home = dir.path();
        resource_dirs::seed_builtin_templates(home).unwrap();
        let root = home.join("templates/software");
        let before = read_template_meta(&root).unwrap();
        let fingerprint = crate::resource_templates::fingerprint(&root).unwrap();

        // Saving the same categories and descriptions changes nothing.
        let same: Vec<(String, String)> = first_level_folders(&root)
            .unwrap()
            .into_iter()
            .map(|name| {
                let text = before.categories.get(&name).cloned().unwrap_or_default();
                (name, text)
            })
            .collect();
        let mut unchanged = input("software", &[]);
        unchanged.description = before.description.clone();
        unchanged.categories = same
            .iter()
            .map(|(name, description)| CategoryInput {
                name: name.clone(),
                description: description.clone(),
            })
            .collect();
        assert_eq!(save(home, &unchanged).unwrap().version, before.version);
        assert_eq!(
            crate::resource_templates::fingerprint(&root).unwrap(),
            fingerprint
        );

        fs::write(root.join("prototype/keep.md"), "x").unwrap();
        let without_prototype = input("software", &[("requirements", ""), ("design", "UI")]);
        let error = save(home, &without_prototype).unwrap_err().to_string();
        assert!(error.contains("prototype"), "{error}");
        assert!(
            root.join("architecture").is_dir(),
            "a refusal changes nothing"
        );
        assert!(!root.join("design").exists());

        fs::remove_file(root.join("prototype/keep.md")).unwrap();
        fs::write(root.join("prototype/.DS_Store"), "x").unwrap();
        let meta = save(home, &without_prototype).unwrap();
        assert_eq!(meta.version, before.version + 1);
        assert_eq!(
            first_level_folders(&root)
                .unwrap()
                .into_iter()
                .collect::<Vec<_>>(),
            ["design", "requirements"]
        );
        assert_eq!(read_template_meta(&root).unwrap(), meta);
    }

    #[test]
    fn bad_input_is_refused() {
        let dir = tempfile::tempdir().unwrap();
        let home = dir.path();
        assert!(save(home, &input("missing", &[])).is_err());
        assert!(save(home, &input("software", &[("../x", "")])).is_err());
        assert!(save(home, &input("software", &[(".hidden", "")])).is_err());
        assert!(save(home, &input("software", &[("a", ""), ("a", "")])).is_err());
        assert!(save(home, &input("software", &[("a", "line\nbreak")])).is_err());
        let mut bad = input("../escape", &[]);
        bad.create = true;
        assert!(save(home, &bad).is_err());
    }

    #[test]
    fn folders_nest_with_a_description_per_level() {
        let dir = tempfile::tempdir().unwrap();
        let home = dir.path();
        let mut new = input(
            "nested",
            &[
                ("docs/api", "Endpoints"),
                ("docs", "All documents"),
                ("design/screens", ""),
            ],
        );
        new.create = true;
        let meta = save(home, &new).unwrap();
        assert_eq!(meta.categories.get("docs/api").unwrap(), "Endpoints");
        assert_eq!(meta.categories.get("docs").unwrap(), "All documents");
        let root = home.join("templates/nested");
        assert_eq!(
            resource_dirs::template_folders(&root).unwrap(),
            ["design", "design/screens", "docs", "docs/api"],
            "parents come along and sort before children"
        );

        // Dropping a parent drops its empty children with it.
        let meta = save(home, &input("nested", &[("docs", "All documents")])).unwrap();
        assert_eq!(meta.version, 2);
        assert_eq!(resource_dirs::template_folders(&root).unwrap(), ["docs"]);

        // A file anywhere below blocks the removal, and nothing changes.
        save(home, &input("nested", &[("docs/api/v1", "")])).unwrap();
        fs::write(root.join("docs/api/v1/a.md"), "x").unwrap();
        let error = save(home, &input("nested", &[])).unwrap_err().to_string();
        assert!(error.contains("still has files"), "{error}");
        assert!(root.join("docs/api/v1/a.md").is_file());

        assert!(save(home, &input("nested", &[("a/../b", "")])).is_err());
        assert!(save(home, &input("nested", &[("a//b", "")])).is_err());
        assert!(save(home, &input("nested", &[("a/b/c/d/e/f/g", "")])).is_err());
    }

    #[test]
    fn deleting_moves_user_templates_to_the_trash_and_keeps_builtins() {
        let dir = tempfile::tempdir().unwrap();
        let home = dir.path();
        let mut new = input("mine", &[("notes", "")]);
        new.create = true;
        save(home, &new).unwrap();
        fs::write(home.join("templates/mine/notes/a.md"), "keep").unwrap();

        let moved = delete(home, "mine").unwrap();
        assert!(!home.join("templates/mine").exists());
        assert_eq!(
            fs::read_to_string(moved.join("notes/a.md")).unwrap(),
            "keep"
        );
        let names: Vec<_> = resource_dirs::list_templates(home)
            .unwrap()
            .into_iter()
            .map(|template| template.name)
            .collect();
        assert_eq!(names, ["blank", "software"]);

        assert!(delete(home, "software").is_err());
        assert!(delete(home, "mine").is_err());
    }
}
