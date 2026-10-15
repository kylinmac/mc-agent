//! Template and project metadata for resource folders (mc-agent R1.4).
//!
//! A template folder may carry `template.json` (version, description and a
//! description per category). It stays in the template and is never copied
//! into a project. A project's resource folder records which template it was
//! created from in `.mc-agent/project.json`, with the template's version and a
//! content fingerprint, so a later template edit is detected even when nobody
//! bumped the version.

use std::collections::BTreeMap;
use std::fs;
use std::path::Path;

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

pub const TEMPLATE_META_FILE: &str = "template.json";
const PROJECT_META_DIR: &str = ".mc-agent";
const PROJECT_META_FILE: &str = "project.json";
const MAX_FINGERPRINT_ENTRIES: usize = 2_000;

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", default)]
pub struct TemplateMeta {
    pub version: u32,
    pub description: String,
    /// Category folder → what belongs in it.
    pub categories: BTreeMap<String, String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProjectMeta {
    pub template: String,
    pub template_version: u32,
    pub template_fingerprint: String,
    pub recorded_at: i64,
}

/// A project's template record compared with the template as it is now.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProjectTemplateStatus {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub recorded: Option<ProjectMeta>,
    /// False when the recorded template no longer exists.
    pub template_exists: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub current_version: Option<u32>,
    /// The template changed since the project recorded it.
    pub outdated: bool,
}

pub fn read_template_meta(template: &Path) -> Result<TemplateMeta> {
    match fs::read_to_string(template.join(TEMPLATE_META_FILE)) {
        Ok(text) => {
            let mut meta: TemplateMeta =
                serde_json::from_str(&text).context("parse template.json")?;
            if meta.version == 0 {
                meta.version = 1;
            }
            Ok(meta)
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(TemplateMeta {
            version: 1,
            ..TemplateMeta::default()
        }),
        Err(error) => Err(error).context("read template.json"),
    }
}

pub fn write_template_meta(template: &Path, meta: &TemplateMeta) -> Result<()> {
    fs::write(
        template.join(TEMPLATE_META_FILE),
        format!("{}\n", serde_json::to_string_pretty(meta)?),
    )?;
    Ok(())
}

/// Hash of the template's folders, file names and contents, excluding its
/// own metadata file, hidden entries and symlinks.
pub fn fingerprint(template: &Path) -> Result<String> {
    let mut hasher = Sha256::new();
    let walker = walkdir::WalkDir::new(template)
        .min_depth(1)
        .follow_links(false)
        .sort_by_file_name()
        .into_iter()
        .filter_entry(|entry| !entry.file_name().to_string_lossy().starts_with('.'));
    for (count, entry) in walker.enumerate() {
        if count >= MAX_FINGERPRINT_ENTRIES {
            break;
        }
        let entry = entry?;
        let relative = entry
            .path()
            .strip_prefix(template)?
            .to_string_lossy()
            .replace('\\', "/");
        if relative == TEMPLATE_META_FILE || entry.path_is_symlink() {
            continue;
        }
        if entry.file_type().is_dir() {
            hasher.update(b"d:");
            hasher.update(relative.as_bytes());
            hasher.update(b"\n");
        } else if entry.file_type().is_file() {
            hasher.update(b"f:");
            hasher.update(relative.as_bytes());
            hasher.update(b"\n");
            hasher.update(fs::read(entry.path())?);
            hasher.update(b"\n");
        }
    }
    Ok(hex::encode(hasher.finalize()))
}

pub fn read_project_meta(resource_folder: &Path) -> Result<Option<ProjectMeta>> {
    match fs::read_to_string(
        resource_folder
            .join(PROJECT_META_DIR)
            .join(PROJECT_META_FILE),
    ) {
        Ok(text) => Ok(Some(
            serde_json::from_str(&text).context("parse .mc-agent/project.json")?,
        )),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error).context("read .mc-agent/project.json"),
    }
}

/// Record that `resource_folder` follows the template at `template_dir`.
pub fn record_project_template(
    resource_folder: &Path,
    name: &str,
    template_dir: &Path,
) -> Result<ProjectMeta> {
    let meta = ProjectMeta {
        template: name.to_string(),
        template_version: read_template_meta(template_dir)?.version,
        template_fingerprint: fingerprint(template_dir)?,
        recorded_at: crate::db::now_ms(),
    };
    let dir = resource_folder.join(PROJECT_META_DIR);
    fs::create_dir_all(&dir)?;
    fs::write(
        dir.join(PROJECT_META_FILE),
        format!("{}\n", serde_json::to_string_pretty(&meta)?),
    )?;
    Ok(meta)
}

pub fn project_template_status(
    resource_folder: &Path,
    templates_dir: &Path,
) -> Result<ProjectTemplateStatus> {
    let Some(recorded) = read_project_meta(resource_folder)? else {
        return Ok(ProjectTemplateStatus {
            recorded: None,
            template_exists: false,
            current_version: None,
            outdated: false,
        });
    };
    let template = templates_dir.join(&recorded.template);
    if !template.is_dir() {
        return Ok(ProjectTemplateStatus {
            recorded: Some(recorded),
            template_exists: false,
            current_version: None,
            outdated: false,
        });
    }
    let version = read_template_meta(&template)?.version;
    let outdated = version > recorded.template_version
        || fingerprint(&template)? != recorded.template_fingerprint;
    Ok(ProjectTemplateStatus {
        recorded: Some(recorded),
        template_exists: true,
        current_version: Some(version),
        outdated,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn missing_metadata_reads_as_version_one() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(read_template_meta(dir.path()).unwrap().version, 1);
        assert!(read_project_meta(dir.path()).unwrap().is_none());
    }

    #[test]
    fn the_fingerprint_follows_structure_and_content_but_not_metadata() {
        let dir = tempfile::tempdir().unwrap();
        let template = dir.path().join("software");
        fs::create_dir_all(template.join("requirements")).unwrap();
        let first = fingerprint(&template).unwrap();
        write_template_meta(
            &template,
            &TemplateMeta {
                version: 1,
                ..TemplateMeta::default()
            },
        )
        .unwrap();
        fs::write(template.join(".DS_Store"), "x").unwrap();
        assert_eq!(fingerprint(&template).unwrap(), first);
        fs::create_dir_all(template.join("design")).unwrap();
        let second = fingerprint(&template).unwrap();
        assert_ne!(second, first);
        fs::write(template.join("design/README.md"), "a").unwrap();
        let third = fingerprint(&template).unwrap();
        fs::write(template.join("design/README.md"), "b").unwrap();
        assert_ne!(fingerprint(&template).unwrap(), third);
    }

    #[test]
    fn a_project_notices_when_its_template_changes() {
        let dir = tempfile::tempdir().unwrap();
        let templates = dir.path().join("templates");
        let template = templates.join("software");
        let project = dir.path().join("project");
        fs::create_dir_all(template.join("requirements")).unwrap();
        fs::create_dir_all(&project).unwrap();

        let status = project_template_status(&project, &templates).unwrap();
        assert!(status.recorded.is_none());

        record_project_template(&project, "software", &template).unwrap();
        let status = project_template_status(&project, &templates).unwrap();
        assert_eq!(status.recorded.as_ref().unwrap().template, "software");
        assert!(status.template_exists && !status.outdated);

        fs::create_dir_all(template.join("prototype")).unwrap();
        assert!(
            project_template_status(&project, &templates)
                .unwrap()
                .outdated
        );
        record_project_template(&project, "software", &template).unwrap();
        assert!(
            !project_template_status(&project, &templates)
                .unwrap()
                .outdated
        );

        write_template_meta(
            &template,
            &TemplateMeta {
                version: 2,
                ..TemplateMeta::default()
            },
        )
        .unwrap();
        assert!(
            project_template_status(&project, &templates)
                .unwrap()
                .outdated
        );

        fs::remove_dir_all(&template).unwrap();
        let gone = project_template_status(&project, &templates).unwrap();
        assert!(!gone.template_exists && !gone.outdated);
    }
}
