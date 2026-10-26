//! A resource folder from a template drafted for one project (mc-agent,
//! MC-ADR-0023).
//!
//! When the agent drafts a template during conversational project creation
//! and the user keeps it for this project only, the folders are created
//! directly in a new resource folder and the draft (descriptions included) is
//! stored beside the project in `.mc-agent/template.json`. The template
//! library is not touched; saving the draft as a template goes through
//! `template_editor::save` and the ordinary `ensure` instead.

use std::fs;
use std::path::Path;

use anyhow::{anyhow, Result};

use crate::db::Database;
use crate::db::ProjectGroupRecord;
use crate::resource_dirs::{self, PROJECTS_DIR};
use crate::resource_templates::{TemplateMeta, TemplateTarget};
use crate::template_editor::{self, TemplateInput};

/// Give `group_id` a resource folder laid out from `input`. Returns the group
/// unchanged when it already has one, like `ensure_project_resources`.
pub fn ensure_project_resources_from_draft(
    db: &Database,
    home: &Path,
    group_id: &str,
    input: &TemplateInput,
) -> Result<ProjectGroupRecord> {
    let group = db
        .project_group(group_id)?
        .ok_or_else(|| anyhow!("project group not found"))?;
    if group.resource_root().is_some() {
        return Ok(group);
    }
    if group.remote.is_some() {
        return Err(anyhow!("remote projects cannot have a resource folder"));
    }
    let name = input.name.trim();
    resource_dirs::validate_template_name(name)?;
    if name.chars().count() > resource_dirs::MAX_NAME_CHARS {
        return Err(anyhow!("template name is too long"));
    }
    let description = template_editor::bounded(&input.description, "template description")?;
    let folders = template_editor::wanted_categories(&input.categories)?;
    if folders.is_empty() {
        return Err(anyhow!("a drafted template needs at least one folder"));
    }
    let projects = home.join(PROJECTS_DIR);
    fs::create_dir_all(&projects)?;
    let target =
        resource_dirs::create_unique_dir(&projects, &resource_dirs::directory_name(&group.name))?;
    let meta = TemplateMeta {
        version: 1,
        description,
        categories: folders,
        target: TemplateTarget::Resources,
    };
    let attached = (|| -> Result<ProjectGroupRecord> {
        for folder in meta.categories.keys() {
            fs::create_dir_all(target.join(folder))?;
        }
        crate::resource_templates::record_one_off_template(&target, &meta, name, &group.id)?;
        db.attach_project_resource_root(&group.id, &target.to_string_lossy())
    })();
    if attached.is_err() {
        // The folder was created by this call and holds only empty folders.
        let _ = fs::remove_dir_all(&target);
    }
    attached
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::template_editor::CategoryInput;

    fn input(name: &str, folders: &[(&str, &str)]) -> TemplateInput {
        TemplateInput {
            name: name.into(),
            description: "Explainer videos".into(),
            categories: folders
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

    fn fixture() -> (
        tempfile::TempDir,
        Database,
        std::path::PathBuf,
        ProjectGroupRecord,
    ) {
        let dir = tempfile::tempdir().unwrap();
        let workspace = dir.path().join("explain");
        fs::create_dir_all(&workspace).unwrap();
        let db = Database::open(&dir.path().join("pi.sqlite")).unwrap();
        let path = crate::db::canonical_project_path(&workspace.to_string_lossy()).unwrap();
        let group = db.create_project_group("Explain", &[path]).unwrap();
        let home = dir.path().join("mc-agent");
        (dir, db, home, group)
    }

    #[test]
    fn a_draft_makes_its_folders_and_keeps_the_descriptions_beside_the_project() {
        let (_dir, db, home, created) = fixture();

        let group = ensure_project_resources_from_draft(
            &db,
            &home,
            &created.id,
            &input(
                "video",
                &[("topics", "Ideas"), ("assets/voice", "Voice-over takes")],
            ),
        )
        .unwrap();
        let root = Path::new(&group.resource_root().unwrap().path).to_path_buf();
        assert!(root.join("topics").is_dir());
        assert!(root.join("assets/voice").is_dir());

        let meta = crate::resource_templates::read_project_meta(&root)
            .unwrap()
            .unwrap();
        assert!(meta.one_off);
        assert_eq!(meta.template, "video");
        assert_eq!(meta.owner.as_deref(), Some(created.id.as_str()));
        let descriptions = crate::resource_overview::template_descriptions(&root);
        assert_eq!(
            descriptions.get("assets/voice").map(String::as_str),
            Some("Voice-over takes")
        );
        assert!(descriptions.contains_key("assets"), "parents come along");

        // The library is untouched, and a same-named library template is not
        // mistaken for this project's.
        assert!(!home.join("templates/video").exists());
        let status =
            crate::resource_templates::project_template_status(&root, &home.join("templates"))
                .unwrap();
        assert!(!status.template_exists && !status.outdated);
    }

    #[test]
    fn a_project_with_a_resource_folder_is_left_alone() {
        let (_dir, db, home, created) = fixture();
        let first = ensure_project_resources_from_draft(
            &db,
            &home,
            &created.id,
            &input("video", &[("topics", "")]),
        )
        .unwrap();
        let again = ensure_project_resources_from_draft(
            &db,
            &home,
            &created.id,
            &input("other", &[("x", "")]),
        )
        .unwrap();
        assert_eq!(
            first.resource_root().unwrap().path,
            again.resource_root().unwrap().path
        );
        assert!(!Path::new(&again.resource_root().unwrap().path)
            .join("x")
            .exists());
    }

    #[test]
    fn bad_drafts_leave_nothing_behind() {
        let (_dir, db, home, created) = fixture();
        for bad in [
            input("video", &[]),
            input(".hidden", &[("topics", "")]),
            input("video", &[("../escape", "")]),
            input("video", &[("topics", "two\nlines")]),
        ] {
            assert!(ensure_project_resources_from_draft(&db, &home, &created.id, &bad).is_err());
        }
        let projects = home.join(PROJECTS_DIR);
        let leftovers = fs::read_dir(&projects)
            .map(|entries| entries.count())
            .unwrap_or(0);
        assert_eq!(leftovers, 0);
        assert!(db
            .project_group(&created.id)
            .unwrap()
            .unwrap()
            .resource_root()
            .is_none());
    }
}
