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

const TEMPLATES_DIR: &str = "templates";
const PROJECTS_DIR: &str = "projects";
const HOME_DIR_NAME: &str = "mc-agent";
/// Upper bound on entries copied from one template; templates are skeletons.
const MAX_TEMPLATE_ENTRIES: usize = 2_000;
const MAX_NAME_CHARS: usize = 80;

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
    }
    Ok(())
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
        templates.push(TemplateSummary {
            builtin: BUILTIN_TEMPLATES
                .iter()
                .any(|(builtin, _, _)| *builtin == name),
            path: entry.path().to_string_lossy().into_owned(),
            categories: categories(&entry.path())?,
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
    let projects = home.join(PROJECTS_DIR);
    fs::create_dir_all(&projects)?;
    let target = create_unique_dir(&projects, &directory_name(&group.name))?;
    let attached = copy_template(&source, &target)
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
fn create_unique_dir(parent: &Path, name: &str) -> Result<PathBuf> {
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

fn validate_template_name(name: &str) -> Result<()> {
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
fn copy_template(source: &Path, target: &Path) -> Result<()> {
    let mut copied = 0usize;
    for entry in walkdir::WalkDir::new(source)
        .min_depth(1)
        .follow_links(false)
    {
        let entry = entry?;
        if entry.file_name() == ".DS_Store" || entry.path_is_symlink() {
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
        let entries = fs::read_dir(&first.roots[0].path).unwrap().count();
        assert_eq!(entries, 0);
        assert_eq!(fs::read_dir(f.home.join("projects")).unwrap().count(), 1);
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
        for template in ["missing", "../escape", ".hidden", ""] {
            assert!(ensure_project_resources(&f.db, &f.home, &group.id, template).is_err());
        }
        let projects = f.home.join("projects");
        assert!(!projects.exists() || fs::read_dir(&projects).unwrap().count() == 0);
        let unchanged = f.db.project_group(&group.id).unwrap().unwrap();
        assert!(unchanged.resource_root().is_none());
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
