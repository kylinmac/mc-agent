//! mc-agent resource directories on disk (MC-ADR-0003, R1.2 / R1.4).
//!
//! Layout below the mc-agent home (default `~/Documents/mc-agent`):
//!
//! ```text
//! templates/<template>/   built-in `software` and `blank`, plus user templates
//! projects/<project>/     one resource directory per project
//! ```
//!
//! A template is copied once when a project gets its resource directory; later
//! template edits never reach existing projects. The directory is then attached
//! to the project group through `Database::attach_project_resource_root`.

use std::fs;
use std::path::{Path, PathBuf};

use anyhow::{anyhow, Context, Result};
use serde::Serialize;

use crate::db::{Database, ProjectGroupRecord};

/// Overrides the mc-agent home, for tests and isolated E2E profiles.
pub const HOME_ENV: &str = "MC_AGENT_HOME";
/// Template used when the caller names none, and for existing projects.
pub const DEFAULT_TEMPLATE: &str = "blank";

pub(crate) const TEMPLATES_DIR: &str = "templates";
pub(crate) const PROJECTS_DIR: &str = "projects";
const HOME_DIR_NAME: &str = "mc-agent";
/// Upper bound on entries copied from one template; templates are skeletons.
const MAX_TEMPLATE_ENTRIES: usize = 2_000;
pub(crate) const MAX_NAME_CHARS: usize = 80;

/// Built-in templates: first-level folders (the resource categories) and
/// starter files at the template root.
type BuiltinTemplate = (
    &'static str,
    &'static [&'static str],
    &'static [(&'static str, &'static str)],
);

const BUILTIN_TEMPLATES: &[BuiltinTemplate] = &[
    (
        "software",
        &["requirements", "architecture", "prototype", "reference"],
        &[
            (crate::workspace_notes::FILE_NAME, SOFTWARE_WORKSPACES_MD),
            ("AGENTS.md", SOFTWARE_AGENTS_MD),
        ],
    ),
    ("blank", &[], &[]),
];

const SOFTWARE_WORKSPACES_MD: &str = "# Workspaces

<!-- One section per workspace: a \"## <folder name>\" heading, then what that
workspace is for. mc-agent shows these and tells sessions about them. -->
";

const SOFTWARE_AGENTS_MD: &str = "# AGENTS.md

Project-level rules for sessions started in this resource folder.
Workspace-specific rules belong in each workspace's own AGENTS.md.
";

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TemplateSummary {
    pub name: String,
    pub path: String,
    pub builtin: bool,
    /// First-level folders, i.e. the categories a new project starts with.
    pub categories: Vec<String>,
    /// From `template.json`; 1 when the template has none.
    pub version: u32,
    pub description: String,
    /// Folder (relative path, `/`-separated, any depth) → what belongs in
    /// it, from `template.json`.
    pub category_descriptions: std::collections::BTreeMap<String, String>,
    /// mc-agent: every folder of the template as a relative path, parents
    /// before children, so the editor can show the tree.
    pub folders: Vec<String>,
    /// What the template sets up: a resource folder or creative categories.
    pub target: crate::resource_templates::TemplateTarget,
}

/// The mc-agent home: `$MC_AGENT_HOME`, else `<Documents>/mc-agent`.
pub fn home_dir() -> Result<PathBuf> {
    if let Some(explicit) = std::env::var_os(HOME_ENV).filter(|value| !value.is_empty()) {
        return Ok(PathBuf::from(explicit));
    }
    let documents = dirs::document_dir()
        .or_else(|| dirs::home_dir().map(|home| home.join("Documents")))
        .ok_or_else(|| anyhow!("cannot locate the Documents folder"))?;
    Ok(documents.join(HOME_DIR_NAME))
}

/// Create any missing built-in template. Existing folders are left alone, so
/// a user's edits to a built-in template survive.
pub fn seed_builtin_templates(home: &Path) -> Result<()> {
    let templates = home.join(TEMPLATES_DIR);
    for (name, categories, files) in BUILTIN_TEMPLATES {
        let root = templates.join(name);
        if root.exists() {
            continue;
        }
        fs::create_dir_all(&root).with_context(|| format!("create template {}", root.display()))?;
        for category in *categories {
            fs::create_dir_all(root.join(category))?;
        }
        for (file, contents) in *files {
            fs::write(root.join(file), contents)?;
        }
        crate::resource_templates::write_template_meta(&root, &builtin_meta(name))?;
    }
    Ok(())
}

fn builtin_meta(name: &str) -> crate::resource_templates::TemplateMeta {
    let mut meta = crate::resource_templates::TemplateMeta {
        version: 1,
        ..Default::default()
    };
    if name == "software" {
        meta.description =
            "Software project: requirements, architecture, prototypes, references.".into();
        for (category, text) in [
            (
                "requirements",
                "Requirements, user stories and acceptance criteria",
            ),
            ("architecture", "Architecture, interfaces and data design"),
            ("prototype", "Prototypes, wireframes and UI drafts"),
            ("reference", "References, links and third-party documents"),
        ] {
            meta.categories.insert(category.into(), text.into());
        }
    } else {
        meta.description = "Empty resource folder.".into();
    }
    meta
}

pub fn list_templates(home: &Path) -> Result<Vec<TemplateSummary>> {
    seed_builtin_templates(home)?;
    let mut templates = Vec::new();
    for entry in fs::read_dir(home.join(TEMPLATES_DIR))? {
        let entry = entry?;
        if !entry.file_type()?.is_dir() {
            continue;
        }
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.starts_with('.') {
            continue;
        }
        let meta = crate::resource_templates::read_template_meta(&entry.path()).unwrap_or_default();
        templates.push(TemplateSummary {
            builtin: is_builtin_template(&name),
            path: entry.path().to_string_lossy().into_owned(),
            categories: categories(&entry.path())?,
            folders: template_folders(&entry.path())?,
            target: meta.target,
            version: meta.version.max(1),
            description: meta.description,
            category_descriptions: meta.categories,
            name,
        });
    }
    templates.sort_by(|left, right| {
        right
            .builtin
            .cmp(&left.builtin)
            .then_with(|| left.name.cmp(&right.name))
    });
    Ok(templates)
}

/// Give `group_id` a resource directory if it has none, copied from
/// `template`. Returns the group unchanged when it already has one, so callers
/// may use this to backfill existing projects.
pub fn ensure_project_resources(
    db: &Database,
    home: &Path,
    group_id: &str,
    template: &str,
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
    validate_template_name(template)?;
    seed_builtin_templates(home)?;
    let source = home.join(TEMPLATES_DIR).join(template);
    if !source.is_dir() {
        return Err(anyhow!("template not found: {template}"));
    }
    if !crate::resource_templates::read_template_meta(&source)?
        .target
        .is_resources()
    {
        return Err(anyhow!(
            "template {template} is for creative folders, not resource folders"
        ));
    }
    let projects = home.join(PROJECTS_DIR);
    fs::create_dir_all(&projects)?;
    // A project that was detached (MC-ADR-0003 decision 12) and is converted
    // back gets its old folder again, with its indexes and notes, as long as
    // no other project has claimed it meanwhile. The folder is found by the
    // owner it records, never by name: a new project that happens to share
    // the name of a detached or deleted one starts from its own template.
    if let Some(previous) = detached_folder_of(db, &projects, &group.id)? {
        return db.attach_project_resource_root(&group.id, &previous.to_string_lossy());
    }
    let target = create_unique_dir(&projects, &directory_name(&group.name))?;
    let attached = copy_template(&source, &target)
        .and_then(|()| {
            crate::resource_templates::record_project_template(&target, template, &source)
                .map(|_| ())
        })
        .and_then(|()| crate::resource_templates::record_project_owner(&target, &group.id))
        .and_then(|()| db.attach_project_resource_root(&group.id, &target.to_string_lossy()));
    match attached {
        Ok(group) => Ok(group),
        Err(error) => {
            // The directory was created by this call and holds only template
            // content, so removing it leaves the disk as it was.
            let _ = fs::remove_dir_all(&target);
            Err(error)
        }
    }
}

/// The unclaimed folder under `projects` that records `group_id` as its owner.
fn detached_folder_of(db: &Database, projects: &Path, group_id: &str) -> Result<Option<PathBuf>> {
    for entry in fs::read_dir(projects)? {
        let path = entry?.path();
        if !path.is_dir() {
            continue;
        }
        let owned = crate::resource_templates::read_project_meta(&path)
            .ok()
            .flatten()
            .and_then(|meta| meta.owner)
            .is_some_and(|owner| owner == group_id);
        if owned && !folder_in_any_group(db, &path)? {
            return Ok(Some(path));
        }
    }
    Ok(None)
}

/// Detach a project's resource folder (MC-ADR-0003 decision 12), first
/// recording the project as its owner so converting back finds it again.
pub fn detach_project_resources(db: &Database, group_id: &str) -> Result<ProjectGroupRecord> {
    let group = db
        .project_group(group_id)?
        .ok_or_else(|| anyhow!("project group not found"))?;
    if let Some(resources) = group.resource_root() {
        // Best effort: a folder that cannot record its owner is simply not
        // offered back later, which is the safe direction.
        let _ =
            crate::resource_templates::record_project_owner(Path::new(&resources.path), &group.id);
    }
    db.detach_project_resource_root(&group.id)
}

fn folder_in_any_group(db: &Database, folder: &Path) -> Result<bool> {
    let wanted = crate::db::canonical_project_path(&folder.to_string_lossy());
    // Legacy entries are only folders someone opened once (a detached
    // resource folder keeps one); they do not claim it.
    Ok(db.list_project_groups()?.iter().any(|group| {
        !group.legacy
            && group
                .roots
                .iter()
                .any(|root| Some(&root.path) == wanted.as_ref())
    }))
}

/// Where a renamed project's resource folder moved (R1.3).
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ResourceMove {
    pub from: String,
    pub to: String,
}

/// A project may be renamed only while no session that started in its
/// resource folder has a running turn: that turn owns the folder as its
/// working directory, and moving it would pull it out from under the tools.
pub fn ensure_rename_allowed(db: &Database, group_id: &str) -> Result<()> {
    let Some(group) = db.project_group(group_id)? else {
        return Ok(());
    };
    let Some(resources) = group.resource_root() else {
        return Ok(());
    };
    for session in db.project_session_ids(&resources.path)? {
        if crate::sessions::session_has_running_turn(db, &session)? {
            return Err(anyhow!(
                "a session in this project's resource folder is still running"
            ));
        }
    }
    Ok(())
}

/// Rename the project's resource folder to follow the project name, when the
/// folder is one mc-agent manages (directly below `<home>/projects`). Every
/// host-owned path below the old folder is rewritten in one transaction; if
/// that fails the folder is moved back, so disk and database never disagree.
/// Returns `None` when nothing had to move.
pub fn follow_project_name(
    db: &Database,
    home: &Path,
    group_id: &str,
) -> Result<Option<ResourceMove>> {
    let Some(group) = db.project_group(group_id)? else {
        return Ok(None);
    };
    let Some(resources) = group.resource_root() else {
        return Ok(None);
    };
    let current = PathBuf::from(&resources.path);
    let projects = home.join(PROJECTS_DIR);
    let managed = current
        .parent()
        .zip(fs::canonicalize(&projects).ok())
        .is_some_and(|(parent, projects)| {
            fs::canonicalize(parent).is_ok_and(|parent| parent == projects)
        });
    if !managed || !current.is_dir() {
        return Ok(None);
    }
    let wanted = directory_name(&group.name);
    let folder = current
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default();
    if folder == wanted || is_suffixed(&folder, &wanted) {
        return Ok(None);
    }
    let parent = current.parent().unwrap_or(&projects).to_path_buf();
    let target = free_name(&parent, &wanted)?;
    move_resource_folder(db, &current, &target).map(Some)
}

/// Move a resource folder that lives outside `<home>/projects` into it, e.g.
/// one created under another home. Returns `None` when it is already there.
pub fn relocate_into_home(
    db: &Database,
    home: &Path,
    group_id: &str,
) -> Result<Option<ResourceMove>> {
    let group = db
        .project_group(group_id)?
        .ok_or_else(|| anyhow!("project group not found"))?;
    let resources = group
        .resource_root()
        .ok_or_else(|| anyhow!("project has no resource folder"))?;
    let current = PathBuf::from(&resources.path);
    let projects = home.join(PROJECTS_DIR);
    fs::create_dir_all(&projects)?;
    let projects = fs::canonicalize(&projects)?;
    if current
        .parent()
        .and_then(|parent| fs::canonicalize(parent).ok())
        .is_some_and(|parent| parent == projects)
    {
        return Ok(None);
    }
    if !current.is_dir() {
        return Err(anyhow!("resource folder is missing: {}", current.display()));
    }
    ensure_rename_allowed(db, group_id)?;
    let target = free_name(&projects, &directory_name(&group.name))?;
    move_resource_folder(db, &current, &target).map(Some)
}

/// Move `current` to `target` and rewrite every host-owned path below it in
/// one transaction. A rename that crosses volumes falls back to copy and
/// delete; any failure puts the folder back so disk and database agree.
fn move_resource_folder(db: &Database, current: &Path, target: &Path) -> Result<ResourceMove> {
    let roots = crate::data_relocation::Roots::moving(current, target);
    let copied = match fs::rename(current, target) {
        Ok(()) => false,
        Err(error) if error.kind() == std::io::ErrorKind::CrossesDevices => {
            copy_tree(current, target)?;
            true
        }
        Err(error) => return Err(error).with_context(|| format!("move {}", current.display())),
    };
    let rewritten = (|| -> Result<()> {
        let transaction = db.conn.unchecked_transaction()?;
        crate::data_relocation::rewrite_database_paths(&transaction, &roots)?;
        transaction.commit()?;
        Ok(())
    })();
    if let Err(error) = rewritten {
        if copied {
            let _ = fs::remove_dir_all(target);
        } else {
            let _ = fs::rename(target, current);
        }
        return Err(error);
    }
    if copied {
        fs::remove_dir_all(current)
            .with_context(|| format!("remove the old folder {}", current.display()))?;
    }
    Ok(ResourceMove {
        from: current.to_string_lossy().into_owned(),
        to: target.to_string_lossy().into_owned(),
    })
}

fn copy_tree(source: &Path, target: &Path) -> Result<()> {
    fs::create_dir_all(target)?;
    for entry in walkdir::WalkDir::new(source)
        .min_depth(1)
        .follow_links(false)
    {
        let entry = entry?;
        let destination = target.join(entry.path().strip_prefix(source)?);
        if entry.file_type().is_dir() {
            fs::create_dir_all(&destination)?;
        } else if entry.file_type().is_file() {
            fs::copy(entry.path(), &destination)?;
        }
    }
    Ok(())
}

/// `name-2`, `name-3`, … count as already following `name`.
fn is_suffixed(folder: &str, wanted: &str) -> bool {
    folder
        .strip_prefix(wanted)
        .and_then(|rest| rest.strip_prefix('-'))
        .is_some_and(|number| !number.is_empty() && number.chars().all(|c| c.is_ascii_digit()))
}

fn free_name(parent: &Path, name: &str) -> Result<PathBuf> {
    for attempt in 1..=1_000u32 {
        let candidate = if attempt == 1 {
            parent.join(name)
        } else {
            parent.join(format!("{name}-{attempt}"))
        };
        if fs::symlink_metadata(&candidate).is_err() {
            return Ok(candidate);
        }
    }
    Err(anyhow!("no free folder name for {name}"))
}

/// A folder name for `project_name`: path separators, `:` and control
/// characters become `-`, surrounding dots and spaces are trimmed, and an empty
/// result falls back to `project`. Non-ASCII names are kept as they are.
pub fn directory_name(project_name: &str) -> String {
    let replaced: String = project_name
        .chars()
        .map(|character| match character {
            '/' | '\\' | ':' => '-',
            character if character.is_control() => '-',
            character => character,
        })
        .take(MAX_NAME_CHARS)
        .collect();
    let trimmed =
        replaced.trim_matches(|character: char| character == '.' || character.is_whitespace());
    if trimmed.is_empty() {
        "project".to_string()
    } else {
        trimmed.to_string()
    }
}

/// Create `parent/name`, or `name-2`, `name-3`, … when taken. Creation itself
/// is the existence check, so a concurrent writer cannot be handed the same
/// directory.
pub(crate) fn create_unique_dir(parent: &Path, name: &str) -> Result<PathBuf> {
    for attempt in 1..=1_000u32 {
        let candidate = if attempt == 1 {
            parent.join(name)
        } else {
            parent.join(format!("{name}-{attempt}"))
        };
        match fs::create_dir(&candidate) {
            Ok(()) => return Ok(candidate),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => {
                return Err(error).with_context(|| format!("create {}", candidate.display()))
            }
        }
    }
    Err(anyhow!("no free folder name for {name}"))
}

pub(crate) fn is_builtin_template(name: &str) -> bool {
    BUILTIN_TEMPLATES
        .iter()
        .any(|(builtin, _, _)| *builtin == name)
}

pub(crate) fn validate_template_name(name: &str) -> Result<()> {
    let valid = !name.is_empty()
        && name != "."
        && name != ".."
        && !name.starts_with('.')
        && !name.contains(['/', '\\'])
        && !name.chars().any(char::is_control);
    if valid {
        Ok(())
    } else {
        Err(anyhow!("invalid template name: {name}"))
    }
}

/// Copy the template tree into the empty `target`. Symlinks are skipped rather
/// than followed, so a template cannot pull content from outside itself.
pub(crate) fn copy_template(source: &Path, target: &Path) -> Result<()> {
    let mut copied = 0usize;
    for entry in walkdir::WalkDir::new(source)
        .min_depth(1)
        .follow_links(false)
    {
        let entry = entry?;
        let template_meta = entry.depth() == 1
            && entry.file_name() == crate::resource_templates::TEMPLATE_META_FILE;
        if entry.file_name() == ".DS_Store" || entry.path_is_symlink() || template_meta {
            continue;
        }
        copied += 1;
        if copied > MAX_TEMPLATE_ENTRIES {
            return Err(anyhow!(
                "template has more than {MAX_TEMPLATE_ENTRIES} entries"
            ));
        }
        let relative = entry.path().strip_prefix(source)?;
        let destination = target.join(relative);
        if entry.file_type().is_dir() {
            fs::create_dir_all(&destination)?;
        } else if entry.file_type().is_file() {
            fs::copy(entry.path(), &destination)
                .with_context(|| format!("copy {}", entry.path().display()))?;
        }
    }
    Ok(())
}

/// Deepest folder level a template may have.
pub(crate) const MAX_FOLDER_DEPTH: usize = 6;

/// Every visible folder below `root` as a `/`-separated relative path,
/// sorted so a parent comes right before its children. Symlinks are not
/// followed.
pub(crate) fn template_folders(root: &Path) -> Result<Vec<String>> {
    let mut folders: Vec<Vec<String>> = Vec::new();
    let walker = walkdir::WalkDir::new(root)
        .min_depth(1)
        .max_depth(MAX_FOLDER_DEPTH)
        .follow_links(false)
        .into_iter()
        .filter_entry(|entry| !entry.file_name().to_string_lossy().starts_with('.'));
    for entry in walker {
        let entry = entry?;
        if !entry.file_type().is_dir() {
            continue;
        }
        let relative = entry.path().strip_prefix(root)?;
        folders.push(
            relative
                .components()
                .map(|part| part.as_os_str().to_string_lossy().into_owned())
                .collect(),
        );
    }
    folders.sort();
    Ok(folders.into_iter().map(|parts| parts.join("/")).collect())
}

fn categories(root: &Path) -> Result<Vec<String>> {
    let mut names = Vec::new();
    for entry in fs::read_dir(root)? {
        let entry = entry?;
        let name = entry.file_name().to_string_lossy().into_owned();
        if entry.file_type()?.is_dir() && !name.starts_with('.') {
            names.push(name);
        }
    }
    names.sort();
    Ok(names)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::{canonical_project_path, ProjectGroupRootKind};

    struct Fixture {
        dir: tempfile::TempDir,
        db: Database,
        home: PathBuf,
        web: String,
    }

    fn fixture() -> Fixture {
        let dir = tempfile::tempdir().unwrap();
        let web = dir.path().join("web");
        fs::create_dir_all(&web).unwrap();
        let db = Database::open(&dir.path().join("pi.sqlite")).unwrap();
        let home = dir.path().join("mc-agent");
        Fixture {
            web: canonical_project_path(&web.to_string_lossy()).unwrap(),
            dir,
            db,
            home,
        }
    }

    #[test]
    fn directory_names_are_safe_and_keep_unicode() {
        assert_eq!(directory_name("登录/后台:v2"), "登录-后台-v2");
        assert_eq!(directory_name("  ..hidden.. "), "hidden");
        assert_eq!(directory_name("../.."), "-");
        assert_eq!(directory_name(" .. "), "project");
        assert_eq!(directory_name("a\nb"), "a-b");
    }

    #[test]
    fn builtin_templates_are_seeded_once_and_user_edits_survive() {
        let f = fixture();
        seed_builtin_templates(&f.home).unwrap();
        let software = f.home.join("templates/software");
        assert!(software.join("requirements").is_dir());
        assert!(f.home.join("templates/blank").is_dir());

        fs::remove_dir(software.join("prototype")).unwrap();
        fs::write(software.join("README.md"), "mine").unwrap();
        seed_builtin_templates(&f.home).unwrap();
        assert!(!software.join("prototype").exists());
        assert_eq!(
            fs::read_to_string(software.join("README.md")).unwrap(),
            "mine"
        );

        let templates = list_templates(&f.home).unwrap();
        let names: Vec<_> = templates.iter().map(|t| t.name.as_str()).collect();
        assert_eq!(names, ["blank", "software"]);
        assert_eq!(
            templates[1].categories,
            ["architecture", "reference", "requirements"]
        );
    }

    #[test]
    fn ensure_copies_the_template_and_attaches_it_first() {
        let f = fixture();
        let group =
            f.db.create_project_group("登录 项目", std::slice::from_ref(&f.web))
                .unwrap();
        seed_builtin_templates(&f.home).unwrap();
        fs::write(
            f.home.join("templates/software/requirements/TEMPLATE.md"),
            "# Req",
        )
        .unwrap();

        let attached = ensure_project_resources(&f.db, &f.home, &group.id, "software").unwrap();

        let root = attached.resource_root().unwrap();
        assert_eq!(attached.roots[0].kind, ProjectGroupRootKind::Resources);
        assert!(root.path.ends_with("projects/登录 项目"));
        let resources = Path::new(&root.path);
        assert!(resources.join("architecture").is_dir());
        assert!(resources.join("workspaces.md").is_file());
        assert!(!resources.join("template.json").exists());
        let meta = crate::resource_templates::read_project_meta(resources)
            .unwrap()
            .unwrap();
        assert_eq!(meta.template, "software");
        assert!(resources.join("AGENTS.md").is_file());
        assert_eq!(
            fs::read_to_string(resources.join("requirements/TEMPLATE.md")).unwrap(),
            "# Req"
        );
        assert_eq!(attached.roots[1].path, f.web);
    }

    #[test]
    fn ensure_is_idempotent_and_backfills_with_blank() {
        let f = fixture();
        let group =
            f.db.create_project_group("App", std::slice::from_ref(&f.web))
                .unwrap();
        let first = ensure_project_resources(&f.db, &f.home, &group.id, DEFAULT_TEMPLATE).unwrap();
        let second = ensure_project_resources(&f.db, &f.home, &group.id, "software").unwrap();
        assert_eq!(first.roots[0].path, second.roots[0].path);
        let visible = fs::read_dir(&first.roots[0].path)
            .unwrap()
            .filter(|entry| {
                !entry
                    .as_ref()
                    .unwrap()
                    .file_name()
                    .to_string_lossy()
                    .starts_with('.')
            })
            .count();
        assert_eq!(visible, 0);
        let meta = crate::resource_templates::read_project_meta(Path::new(&first.roots[0].path))
            .unwrap()
            .unwrap();
        assert_eq!(meta.template, "blank");
        assert_eq!(fs::read_dir(f.home.join("projects")).unwrap().count(), 1);
    }

    #[test]
    fn converting_back_reattaches_the_detached_folder() {
        let f = fixture();
        let group =
            f.db.create_project_group("App", std::slice::from_ref(&f.web))
                .unwrap();
        let managed = ensure_project_resources(&f.db, &f.home, &group.id, "software").unwrap();
        let folder = managed.resource_root().unwrap().path.clone();
        fs::write(
            Path::new(&folder).join("requirements/INDEX.md"),
            "# Index\n",
        )
        .unwrap();

        detach_project_resources(&f.db, &group.id).unwrap();

        let again = ensure_project_resources(&f.db, &f.home, &group.id, "blank").unwrap();
        assert_eq!(again.resource_root().unwrap().path, folder);
        assert!(Path::new(&folder).join("requirements/INDEX.md").is_file());
        assert!(!f.home.join("projects/App-2").exists());
    }

    #[test]
    fn a_project_with_the_same_name_never_takes_a_detached_folder() {
        let f = fixture();
        let first =
            f.db.create_project_group("App", std::slice::from_ref(&f.web))
                .unwrap();
        let managed = ensure_project_resources(&f.db, &f.home, &first.id, "software").unwrap();
        let folder = managed.resource_root().unwrap().path.clone();
        detach_project_resources(&f.db, &first.id).unwrap();

        let other = f.dir.path().join("other");
        fs::create_dir_all(&other).unwrap();
        let other = canonical_project_path(&other.to_string_lossy()).unwrap();
        let second =
            f.db.create_project_group("App", std::slice::from_ref(&other))
                .unwrap();
        let attached = ensure_project_resources(&f.db, &f.home, &second.id, "blank").unwrap();
        let path = attached.resource_root().unwrap().path.clone();
        assert_ne!(path, folder);
        assert!(path.ends_with("projects/App-2"));
        let meta = crate::resource_templates::read_project_meta(Path::new(&path))
            .unwrap()
            .unwrap();
        assert_eq!(meta.template, "blank");
        assert_eq!(meta.owner.as_deref(), Some(second.id.as_str()));

        // The first project still gets its own folder back.
        let again = ensure_project_resources(&f.db, &f.home, &first.id, "blank").unwrap();
        assert_eq!(again.resource_root().unwrap().path, folder);
    }

    #[test]
    fn a_folder_without_an_owner_is_not_claimed_by_name() {
        let f = fixture();
        let first =
            f.db.create_project_group("App", std::slice::from_ref(&f.web))
                .unwrap();
        let managed = ensure_project_resources(&f.db, &f.home, &first.id, "software").unwrap();
        let folder = managed.resource_root().unwrap().path.clone();
        // A folder made before owners were recorded, detached directly.
        let meta_path = Path::new(&folder).join(".mc-agent/project.json");
        let mut meta: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(&meta_path).unwrap()).unwrap();
        meta.as_object_mut().unwrap().remove("owner");
        fs::write(&meta_path, meta.to_string()).unwrap();
        f.db.detach_project_resource_root(&first.id).unwrap();

        let other = f.dir.path().join("other");
        fs::create_dir_all(&other).unwrap();
        let other = canonical_project_path(&other.to_string_lossy()).unwrap();
        let second =
            f.db.create_project_group("App", std::slice::from_ref(&other))
                .unwrap();
        let attached = ensure_project_resources(&f.db, &f.home, &second.id, "blank").unwrap();
        assert_ne!(attached.resource_root().unwrap().path, folder);
    }

    #[test]
    fn name_collisions_get_a_suffix() {
        let f = fixture();
        fs::create_dir_all(f.home.join("projects/App")).unwrap();
        let group =
            f.db.create_project_group("App", std::slice::from_ref(&f.web))
                .unwrap();
        let attached = ensure_project_resources(&f.db, &f.home, &group.id, "blank").unwrap();
        assert!(attached.roots[0].path.ends_with("projects/App-2"));
    }

    #[test]
    fn bad_templates_create_nothing() {
        let f = fixture();
        let group =
            f.db.create_project_group("App", std::slice::from_ref(&f.web))
                .unwrap();
        // A creative template sets up categories, never a resource folder.
        crate::template_editor::save(
            &f.home,
            &crate::template_editor::TemplateInput {
                name: "art".into(),
                description: String::new(),
                categories: vec![],
                create: true,
                copy_from: None,
                target: Some(crate::resource_templates::TemplateTarget::Creative),
            },
        )
        .unwrap();
        for template in ["missing", "../escape", ".hidden", "", "art"] {
            assert!(ensure_project_resources(&f.db, &f.home, &group.id, template).is_err());
        }
        let projects = f.home.join("projects");
        assert!(!projects.exists() || fs::read_dir(&projects).unwrap().count() == 0);
        let unchanged = f.db.project_group(&group.id).unwrap().unwrap();
        assert!(unchanged.resource_root().is_none());
    }

    #[test]
    fn renaming_moves_the_folder_and_rewrites_host_paths() {
        let f = fixture();
        let group =
            f.db.create_project_group("Old", std::slice::from_ref(&f.web))
                .unwrap();
        let attached = ensure_project_resources(&f.db, &f.home, &group.id, "software").unwrap();
        let old = attached.roots[0].path.clone();
        f.db.ensure_project(&old, false).unwrap();
        crate::mc_creative::set_storage(&f.db, &attached, &old).unwrap();
        let image = crate::mc_creative::output_dir(&f.db, &attached, "")
            .unwrap()
            .join("reference.png");
        fs::write(&image, b"image bytes").unwrap();
        let asset = crate::mc_creative::import_existing(
            &f.db,
            &attached,
            &image,
            &crate::mc_creative::FileFacts::default(),
        )
        .unwrap();
        f.db.rename_project_group(&group.id, "新名字").unwrap();

        let moved = follow_project_name(&f.db, &f.home, &group.id)
            .unwrap()
            .unwrap();
        assert_eq!(moved.from, old);
        assert!(moved.to.ends_with("projects/新名字"));
        assert!(!Path::new(&old).exists());
        assert!(Path::new(&moved.to).join("requirements").is_dir());
        let reloaded = f.db.project_group(&group.id).unwrap().unwrap();
        assert_eq!(reloaded.primary_path, moved.to);
        assert_eq!(reloaded.roots[0].kind, ProjectGroupRootKind::Resources);
        assert_eq!(
            crate::mc_creative::storage(&f.db, &reloaded)
                .unwrap()
                .folder,
            Path::new(&moved.to)
        );
        let asset = crate::mc_creative::get_asset(&f.db, &asset.id)
            .unwrap()
            .unwrap();
        assert!(asset.file_exists);
        assert!(Path::new(&asset.path).starts_with(&moved.to));
        assert!(f
            .db
            .list_projects()
            .unwrap()
            .iter()
            .any(|p| p.path == moved.to));
        assert!(f.db.list_projects().unwrap().iter().all(|p| p.path != old));

        // Nothing moves when the name already matches.
        assert!(follow_project_name(&f.db, &f.home, &group.id)
            .unwrap()
            .is_none());
    }

    #[test]
    fn renaming_avoids_taken_names_and_leaves_unmanaged_folders_alone() {
        let f = fixture();
        let group =
            f.db.create_project_group("A", std::slice::from_ref(&f.web))
                .unwrap();
        ensure_project_resources(&f.db, &f.home, &group.id, "blank").unwrap();
        fs::create_dir_all(f.home.join("projects/B")).unwrap();
        f.db.rename_project_group(&group.id, "B").unwrap();
        let moved = follow_project_name(&f.db, &f.home, &group.id)
            .unwrap()
            .unwrap();
        assert!(moved.to.ends_with("projects/B-2"));
        // B-2 already follows "B".
        assert!(follow_project_name(&f.db, &f.home, &group.id)
            .unwrap()
            .is_none());

        let elsewhere = f.dir.path().join("my-docs");
        let server = f.dir.path().join("server");
        fs::create_dir_all(&elsewhere).unwrap();
        fs::create_dir_all(&server).unwrap();
        let custom =
            f.db.create_project_group(
                "Custom",
                &[canonical_project_path(&server.to_string_lossy()).unwrap()],
            )
            .unwrap();
        f.db.attach_project_resource_root(&custom.id, &elsewhere.to_string_lossy())
            .unwrap();
        f.db.rename_project_group(&custom.id, "Renamed").unwrap();
        assert!(follow_project_name(&f.db, &f.home, &custom.id)
            .unwrap()
            .is_none());
        assert!(elsewhere.is_dir());
    }

    #[test]
    fn relocating_moves_a_foreign_folder_into_the_home() {
        let f = fixture();
        let elsewhere = f.dir.path().join("old-home/projects/App");
        fs::create_dir_all(elsewhere.join("requirements")).unwrap();
        fs::write(elsewhere.join("requirements/a.md"), "a").unwrap();
        let group =
            f.db.create_project_group("App", std::slice::from_ref(&f.web))
                .unwrap();
        f.db.attach_project_resource_root(&group.id, &elsewhere.to_string_lossy())
            .unwrap();
        let moved = relocate_into_home(&f.db, &f.home, &group.id)
            .unwrap()
            .unwrap();
        assert!(moved.to.ends_with("projects/App"));
        assert!(Path::new(&moved.to).join("requirements/a.md").is_file());
        assert!(!elsewhere.exists());
        let reloaded = f.db.project_group(&group.id).unwrap().unwrap();
        assert_eq!(reloaded.resource_root().unwrap().path, moved.to);
        assert!(relocate_into_home(&f.db, &f.home, &group.id)
            .unwrap()
            .is_none());
    }

    #[cfg(unix)]
    #[test]
    fn template_symlinks_are_not_followed() {
        let f = fixture();
        seed_builtin_templates(&f.home).unwrap();
        let secret = f.dir.path().join("secret.txt");
        fs::write(&secret, "secret").unwrap();
        std::os::unix::fs::symlink(&secret, f.home.join("templates/blank/link.txt")).unwrap();
        let group =
            f.db.create_project_group("App", std::slice::from_ref(&f.web))
                .unwrap();
        let attached = ensure_project_resources(&f.db, &f.home, &group.id, "blank").unwrap();
        assert!(!Path::new(&attached.roots[0].path).join("link.txt").exists());
    }
}
