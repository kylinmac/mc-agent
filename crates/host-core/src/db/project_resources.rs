//! mc-agent project resource directories (MC-ADR-0003).
//!
//! A project keeps its documents and other fixed material in one resource
//! directory outside every workspace. The directory is stored as the first root
//! of the project group with `kind: "resources"`, so the upstream containment,
//! session-ownership and launch-context paths treat it like any other root.

use super::project_groups::{ProjectGroupRecord, ProjectGroupRootKind};
use super::repositories::canonical_project_path;
use super::*;

impl Database {
    /// One project group by id, legacy projections included.
    pub fn project_group(&self, id: &str) -> Result<Option<ProjectGroupRecord>> {
        self.group_by_id(id.trim())
    }

    /// The folder a Worker session starts in (R1.6). Without a request the
    /// Worker inherits its parent's folder; a requested workspace must be a
    /// root of the parent's own project, so delegation can never reach a
    /// folder outside it.
    pub fn worker_project_path(
        &self,
        parent: Option<&str>,
        requested: Option<&str>,
    ) -> Result<Option<String>> {
        let Some(requested) = requested.map(str::trim).filter(|path| !path.is_empty()) else {
            return Ok(parent.map(str::to_string));
        };
        let parent = parent.ok_or_else(|| {
            anyhow!(
                "PERMISSION_DENIED: the parent session has no project to choose a workspace from"
            )
        })?;
        let group = self.project_group_for_path(parent)?.ok_or_else(|| {
            anyhow!(
                "PERMISSION_DENIED: the parent session has no project to choose a workspace from"
            )
        })?;
        let wanted = canonical_project_path(requested)
            .ok_or_else(|| anyhow!("INVALID_ARGUMENT: workspace path is invalid"))?;
        group
            .roots
            .iter()
            .find(|root| root.path == wanted)
            .map(|root| Some(root.path.clone()))
            .ok_or_else(|| {
                anyhow!("PERMISSION_DENIED: workspace is not a folder of this project: {wanted}")
            })
    }

    /// Mark a non-resource root as a development workspace or an external
    /// reference folder. Only the label changes; tools treat both alike.
    pub fn set_project_root_kind(
        &self,
        id: &str,
        path: &str,
        kind: ProjectGroupRootKind,
    ) -> Result<ProjectGroupRecord> {
        if kind == ProjectGroupRootKind::Resources {
            return Err(anyhow!("use the resource folder actions to change it"));
        }
        let mut group = self
            .group_by_id(id.trim())?
            .ok_or_else(|| anyhow!("project group not found"))?;
        if group.legacy {
            return Err(anyhow!(
                "open the project once so it becomes a project group first"
            ));
        }
        let wanted =
            canonical_project_path(path).ok_or_else(|| anyhow!("folder path is invalid"))?;
        let root = group
            .roots
            .iter_mut()
            .find(|root| root.path == wanted)
            .ok_or_else(|| anyhow!("not a folder of this project: {wanted}"))?;
        if root.kind == ProjectGroupRootKind::Resources {
            return Err(anyhow!("the resource folder cannot change its kind"));
        }
        root.kind = kind;
        group.updated_at = now_ms();
        self.store_project_group(&group)?;
        Ok(group)
    }

    /// Attach an existing directory as the project's resource directory.
    ///
    /// The directory becomes `roots[0]` and the primary path; the existing
    /// workspaces keep their order after it. A legacy single-folder project is
    /// upgraded to a stored group first, which carries its path-scoped memory
    /// over. Workspaces are never modified.
    pub fn attach_project_resource_root(&self, id: &str, path: &str) -> Result<ProjectGroupRecord> {
        let Some(current) = self.group_by_id(id.trim())? else {
            return Err(anyhow!("project group not found"));
        };
        if current.remote.is_some() {
            return Err(anyhow!("remote projects cannot have a resource folder"));
        }
        if current.resource_root().is_some() {
            return Err(anyhow!("project already has a resource folder"));
        }
        let resources = canonical_project_path(path)
            .ok_or_else(|| anyhow!("resource folder path must not be blank"))?;
        if !Path::new(&resources).is_dir() {
            return Err(anyhow!("resource folder is not a directory: {resources}"));
        }
        if current.roots.iter().any(|root| root.path == resources) {
            return Err(anyhow!(
                "resource folder is already a workspace of this project: {resources}"
            ));
        }

        let mut paths = Vec::with_capacity(current.roots.len() + 1);
        paths.push(resources.clone());
        paths.extend(current.roots.iter().map(|root| root.path.clone()));

        let transaction = self.conn.unchecked_transaction()?;
        let mut group =
            self.update_project_group(&current.id, &current.name, &paths, Some(&resources))?;
        if group.roots.first().map(|root| root.path.as_str()) != Some(resources.as_str()) {
            return Err(anyhow!("resource folder did not become the first root"));
        }
        group.roots[0].kind = ProjectGroupRootKind::Resources;
        self.store_project_group(&group)?;
        transaction.commit()?;
        Ok(group)
    }

    /// Turn a managed project back into a simple one (MC-ADR-0003 decision
    /// 12): drop the resource root from the group and make the next folder
    /// primary. The folder and its files stay on disk; sessions started there
    /// keep their path. A project must keep at least one workspace.
    pub fn detach_project_resource_root(&self, id: &str) -> Result<ProjectGroupRecord> {
        let Some(mut group) = self.group_by_id(id.trim())? else {
            return Err(anyhow!("project group not found"));
        };
        if group.resource_root().is_none() {
            return Err(anyhow!("project has no resource folder"));
        }
        if group.roots.len() < 2 {
            return Err(anyhow!(
                "add a workspace before detaching the resource folder"
            ));
        }
        group.roots.remove(0);
        for (position, root) in group.roots.iter_mut().enumerate() {
            root.position = position as i64;
        }
        group.primary_path = group.roots[0].path.clone();
        group.updated_at = crate::db::now_ms();
        self.store_project_group(&group)?;
        Ok(group)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Fixture {
        _dir: tempfile::TempDir,
        db: Database,
        web: String,
        server: String,
        resources: String,
    }

    fn fixture() -> Fixture {
        let dir = tempfile::tempdir().unwrap();
        let mut paths = Vec::new();
        for name in ["web", "server", "resources"] {
            let path = dir.path().join(name);
            std::fs::create_dir_all(&path).unwrap();
            paths.push(canonical_project_path(&path.to_string_lossy()).unwrap());
        }
        let db = Database::open(&dir.path().join("pi.sqlite")).unwrap();
        Fixture {
            _dir: dir,
            db,
            web: paths[0].clone(),
            server: paths[1].clone(),
            resources: paths[2].clone(),
        }
    }

    #[test]
    fn attaching_puts_the_resource_root_first_and_keeps_workspace_order() {
        let f = fixture();
        let group =
            f.db.create_project_group("Split", &[f.web.clone(), f.server.clone()])
                .unwrap();

        let attached =
            f.db.attach_project_resource_root(&group.id, &f.resources)
                .unwrap();

        assert_eq!(attached.id, group.id);
        assert_eq!(attached.primary_path, f.resources);
        let roots: Vec<_> = attached
            .roots
            .iter()
            .map(|root| (root.path.as_str(), root.kind))
            .collect();
        assert_eq!(
            roots,
            [
                (f.resources.as_str(), ProjectGroupRootKind::Resources),
                (f.web.as_str(), ProjectGroupRootKind::Workspace),
                (f.server.as_str(), ProjectGroupRootKind::Workspace),
            ]
        );
        let reloaded = f.db.project_group_for_path(&f.resources).unwrap().unwrap();
        assert_eq!(reloaded.id, group.id);
        assert_eq!(reloaded.resource_root().unwrap().path, f.resources);
    }

    #[test]
    fn workspace_records_without_kind_stay_byte_identical() {
        let f = fixture();
        let group =
            f.db.create_project_group("Plain", std::slice::from_ref(&f.web))
                .unwrap();
        let stored = serde_json::to_value(&group).unwrap();
        assert!(stored["roots"][0].get("kind").is_none());

        let attached =
            f.db.attach_project_resource_root(&group.id, &f.resources)
                .unwrap();
        let stored = serde_json::to_value(&attached).unwrap();
        assert_eq!(stored["roots"][0]["kind"], "resources");
        assert!(stored["roots"][1].get("kind").is_none());
    }

    #[test]
    fn legacy_projects_are_upgraded_and_keep_their_memory() {
        let f = fixture();
        f.db.ensure_project(&f.web, false).unwrap();
        f.db.set_project_memory(&f.web, "Keep the API stable.")
            .unwrap();
        let legacy = f.db.list_project_groups().unwrap().pop().unwrap();
        assert!(legacy.legacy);

        let attached =
            f.db.attach_project_resource_root(&legacy.id, &f.resources)
                .unwrap();

        assert!(!attached.legacy);
        assert_eq!(attached.resource_root().unwrap().path, f.resources);
        assert_eq!(attached.roots[1].path, f.web);
        let memory = f.db.get_project_group_memory(&attached.id).unwrap();
        assert!(memory.content.contains("Keep the API stable."));
        assert_eq!(f.db.list_project_groups().unwrap().len(), 1);
    }

    #[test]
    fn attaching_is_refused_for_bad_targets() {
        let f = fixture();
        let group =
            f.db.create_project_group("Split", &[f.web.clone(), f.server.clone()])
                .unwrap();

        assert!(f
            .db
            .attach_project_resource_root(&group.id, &f.server)
            .is_err());
        let missing = format!("{}/missing", f.resources);
        assert!(f
            .db
            .attach_project_resource_root(&group.id, &missing)
            .is_err());
        assert!(f
            .db
            .attach_project_resource_root("no-such-group", &f.resources)
            .is_err());

        f.db.attach_project_resource_root(&group.id, &f.resources)
            .unwrap();
        assert!(f
            .db
            .attach_project_resource_root(&group.id, &f.resources)
            .is_err());
        let unchanged = f.db.project_group_for_path(&f.web).unwrap().unwrap();
        assert_eq!(unchanged.roots.len(), 3);
    }

    #[test]
    fn editing_workspaces_keeps_the_resource_root_first() {
        let f = fixture();
        let group =
            f.db.create_project_group("Split", &[f.web.clone(), f.server.clone()])
                .unwrap();
        f.db.attach_project_resource_root(&group.id, &f.resources)
            .unwrap();

        let edited =
            f.db.update_project_group(
                &group.id,
                "Split",
                &[f.resources.clone(), f.server.clone()],
                None,
            )
            .unwrap();
        assert_eq!(edited.roots[0].kind, ProjectGroupRootKind::Resources);
        assert_eq!(edited.roots[1].path, f.server);

        assert!(f
            .db
            .update_project_group(&group.id, "Split", std::slice::from_ref(&f.server), None)
            .is_err());
        assert!(f
            .db
            .update_project_group(
                &group.id,
                "Split",
                &[f.resources.clone(), f.server.clone()],
                Some(&f.server),
            )
            .is_err());
    }

    #[test]
    fn workers_start_in_a_folder_of_the_parent_project_only() {
        let f = fixture();
        let group =
            f.db.create_project_group("Split", &[f.web.clone(), f.server.clone()])
                .unwrap();
        f.db.attach_project_resource_root(&group.id, &f.resources)
            .unwrap();

        assert_eq!(
            f.db.worker_project_path(Some(&f.resources), None).unwrap(),
            Some(f.resources.clone())
        );
        assert_eq!(
            f.db.worker_project_path(Some(&f.resources), Some(&format!("{}/", f.server)))
                .unwrap(),
            Some(f.server.clone())
        );
        assert!(f
            .db
            .worker_project_path(Some(&f.resources), Some("/etc"))
            .is_err());
        assert!(f.db.worker_project_path(None, Some(&f.server)).is_err());
        let outsider = f._dir.path().join("outsider");
        std::fs::create_dir_all(&outsider).unwrap();
        let outsider = canonical_project_path(&outsider.to_string_lossy()).unwrap();
        f.db.create_project_group("Other", std::slice::from_ref(&outsider))
            .unwrap();
        assert!(f
            .db
            .worker_project_path(Some(&f.resources), Some(&outsider))
            .is_err());
    }

    #[test]
    fn folders_can_be_labelled_as_reference_and_back() {
        let f = fixture();
        let group =
            f.db.create_project_group("Split", &[f.web.clone(), f.server.clone()])
                .unwrap();
        f.db.attach_project_resource_root(&group.id, &f.resources)
            .unwrap();
        let labelled =
            f.db.set_project_root_kind(&group.id, &f.server, ProjectGroupRootKind::Reference)
                .unwrap();
        assert_eq!(labelled.roots[2].kind, ProjectGroupRootKind::Reference);
        let stored = serde_json::to_value(&labelled).unwrap();
        assert_eq!(stored["roots"][2]["kind"], "reference");
        // Editing folders keeps the label.
        let edited =
            f.db.update_project_group(
                &group.id,
                "Split",
                &[f.resources.clone(), f.web.clone(), f.server.clone()],
                None,
            )
            .unwrap();
        assert_eq!(edited.roots[2].kind, ProjectGroupRootKind::Reference);
        assert!(f
            .db
            .set_project_root_kind(&group.id, &f.resources, ProjectGroupRootKind::Reference)
            .is_err());
        assert!(f
            .db
            .set_project_root_kind(&group.id, &f.web, ProjectGroupRootKind::Resources)
            .is_err());
        let back =
            f.db.set_project_root_kind(&group.id, &f.server, ProjectGroupRootKind::Workspace)
                .unwrap();
        assert!(serde_json::to_value(&back).unwrap()["roots"][2]
            .get("kind")
            .is_none());
    }

    #[test]
    fn detaching_returns_a_simple_project_and_keeps_the_folder() {
        let f = fixture();
        let group =
            f.db.create_project_group("Split", &[f.web.clone(), f.server.clone()])
                .unwrap();
        assert!(f.db.detach_project_resource_root(&group.id).is_err());
        f.db.attach_project_resource_root(&group.id, &f.resources)
            .unwrap();

        let simple = f.db.detach_project_resource_root(&group.id).unwrap();
        assert!(simple.resource_root().is_none());
        assert_eq!(simple.primary_path, f.web);
        assert_eq!(
            simple
                .roots
                .iter()
                .map(|root| root.path.as_str())
                .collect::<Vec<_>>(),
            [f.web.as_str(), f.server.as_str()]
        );
        assert_eq!(
            simple
                .roots
                .iter()
                .map(|root| root.position)
                .collect::<Vec<_>>(),
            [0, 1]
        );
        assert!(std::path::Path::new(&f.resources).is_dir());
        let stored = f.db.project_group(&group.id).unwrap().unwrap();
        assert_eq!(stored.primary_path, simple.primary_path);
        assert!(stored.resource_root().is_none());

        // Attaching again works: simple and managed are reversible.
        f.db.attach_project_resource_root(&group.id, &f.resources)
            .unwrap();
    }

    #[test]
    fn a_resource_folder_alone_cannot_be_detached() {
        let f = fixture();
        let group =
            f.db.create_project_group("Solo", std::slice::from_ref(&f.web))
                .unwrap();
        f.db.attach_project_resource_root(&group.id, &f.resources)
            .unwrap();
        f.db.remove_project_from_group(&group.id, &f.web).unwrap();
        assert!(f.db.detach_project_resource_root(&group.id).is_err());
    }

    #[test]
    fn the_resource_root_is_removed_only_with_the_last_workspace() {
        let f = fixture();
        let group =
            f.db.create_project_group("Split", &[f.web.clone(), f.server.clone()])
                .unwrap();
        f.db.attach_project_resource_root(&group.id, &f.resources)
            .unwrap();

        assert!(f
            .db
            .remove_project_from_group(&group.id, &f.resources)
            .is_err());
        let after_web =
            f.db.remove_project_from_group(&group.id, &f.web)
                .unwrap()
                .unwrap();
        assert_eq!(after_web.primary_path, f.resources);
        assert_eq!(after_web.roots[0].kind, ProjectGroupRootKind::Resources);
        f.db.remove_project_from_group(&group.id, &f.server)
            .unwrap()
            .unwrap();
        assert!(f
            .db
            .remove_project_from_group(&group.id, &f.resources)
            .unwrap()
            .is_none());
    }
}
