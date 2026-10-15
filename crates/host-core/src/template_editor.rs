//! In-app template editing (mc-agent R1.4).
//!
//! A template is a folder below `<home>/templates`; its first-level folders
//! are the resource categories and `template.json` holds the descriptions.
//! Saving creates missing category folders, removes dropped ones only while
//! they are empty, and bumps the version whenever categories or descriptions
//! change, so projects created from it see the template as changed. Starter
//! files inside the folder are edited in Finder. Deleting moves the folder to
//! `templates/.trash/`, which listings skip, instead of erasing it.

use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};

use anyhow::{anyhow, Context, Result};
use serde::Deserialize;

use crate::resource_dirs::{self, TEMPLATES_DIR};
use crate::resource_templates::{read_template_meta, write_template_meta, TemplateMeta};

const TRASH_DIR: &str = ".trash";
const MAX_CATEGORIES: usize = 64;
const MAX_DESCRIPTION_CHARS: usize = 500;

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CategoryInput {
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
            apply(&root, &description, &wanted, TemplateMeta::default(), true)
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
    apply(&root, &description, &wanted, previous, false)
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
    previous: TemplateMeta,
    created: bool,
) -> Result<TemplateMeta> {
    let existing = first_level_folders(root)?;
    let wanted_names: BTreeSet<&String> = wanted.keys().collect();
    let dropped: Vec<&String> = existing
        .iter()
        .filter(|name| !wanted_names.contains(name))
        .collect();
    // Check every removal before touching the disk, so a refusal changes nothing.
    for name in &dropped {
        if !is_empty_folder(&root.join(name))? {
            return Err(anyhow!(
                "category {name} still has files; empty it in Finder before removing it"
            ));
        }
    }
    for name in &dropped {
        let folder = root.join(name);
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
        || previous.categories != categories;
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
    };
    if created || changed {
        write_template_meta(root, &meta)?;
    }
    Ok(meta)
}

fn wanted_categories(input: &[CategoryInput]) -> Result<BTreeMap<String, String>> {
    if input.len() > MAX_CATEGORIES {
        return Err(anyhow!(
            "a template can have at most {MAX_CATEGORIES} categories"
        ));
    }
    let mut wanted = BTreeMap::new();
    for category in input {
        let name = category.name.trim();
        resource_dirs::validate_template_name(name)
            .map_err(|_| anyhow!("invalid category name: {name}"))?;
        if name.chars().count() > resource_dirs::MAX_NAME_CHARS {
            return Err(anyhow!("category name is too long: {name}"));
        }
        let text = bounded(&category.description, "category description")?;
        if wanted.insert(name.to_string(), text).is_some() {
            return Err(anyhow!("duplicate category: {name}"));
        }
    }
    Ok(wanted)
}

fn bounded(text: &str, what: &str) -> Result<String> {
    let text = text.trim();
    if text.chars().count() > MAX_DESCRIPTION_CHARS {
        return Err(anyhow!("{what} is too long"));
    }
    if text.contains(['\n', '\r']) {
        return Err(anyhow!("{what} must be one line"));
    }
    Ok(text.to_string())
}

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

fn is_empty_folder(folder: &Path) -> Result<bool> {
    for entry in fs::read_dir(folder)? {
        if entry?.file_name() != ".DS_Store" {
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
