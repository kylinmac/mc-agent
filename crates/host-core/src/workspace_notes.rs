//! Workspace descriptions kept in the project's resource directory (R10).
//!
//! `<resource dir>/workspaces.md` holds one `## <heading>` section per
//! workspace; the section body is that workspace's description. The heading is
//! the workspace folder name, or its full path when two workspaces of the
//! project share a folder name. The file is the source of truth: it is read on
//! every use, so edits made in any editor apply at once, and writes change only
//! the targeted section, leaving everything else the user wrote in place.

use std::fs;
use std::path::Path;

use anyhow::{anyhow, Context, Result};
use serde::Serialize;

use crate::db::{ProjectGroupRecord, ProjectGroupRootKind};

pub const FILE_NAME: &str = "workspaces.md";
const MAX_DESCRIPTION_CHARS: usize = 2_000;
const NEW_FILE_HEADER: &str = "# Workspaces\n";

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceNote {
    pub path: String,
    pub heading: String,
    pub description: String,
}

/// Every workspace of `group`, in root order, with its description (empty when
/// the file or the section is missing). A project without a resource directory
/// has no file to read and reports empty descriptions.
pub fn read(group: &ProjectGroupRecord) -> Result<Vec<WorkspaceNote>> {
    let text = match group.resource_root() {
        Some(root) => read_file(Path::new(&root.path))?,
        None => String::new(),
    };
    let sections = parse(&text).sections;
    Ok(workspaces(group)
        .into_iter()
        .map(|(path, heading)| {
            let description = sections
                .iter()
                .find(|section| section.heading == heading || section.heading == path)
                .map(|section| section.body.trim().to_string())
                .unwrap_or_default();
            WorkspaceNote {
                path,
                heading,
                description,
            }
        })
        .collect())
}

/// Replace the description of one workspace. An empty description removes its
/// section. The file is written through a temporary sibling and a rename, so a
/// failed write never leaves a truncated file behind.
pub fn write(
    group: &ProjectGroupRecord,
    workspace: &str,
    description: &str,
) -> Result<WorkspaceNote> {
    let resources = group
        .resource_root()
        .ok_or_else(|| anyhow!("project has no resource folder"))?;
    let (path, heading) = workspaces(group)
        .into_iter()
        .find(|(path, _)| path == workspace)
        .ok_or_else(|| anyhow!("not a workspace of this project: {workspace}"))?;
    let description = validate(description)?;

    let dir = Path::new(&resources.path);
    let mut document = parse(&read_file(dir)?);
    if document.preamble.trim().is_empty() && document.sections.is_empty() {
        document.preamble = NEW_FILE_HEADER.to_string();
    }
    let existing = document
        .sections
        .iter()
        .position(|section| section.heading == heading || section.heading == path);
    match (existing, description.is_empty()) {
        (Some(index), true) => {
            document.sections.remove(index);
        }
        (Some(index), false) => {
            document.sections[index].heading = heading.clone();
            document.sections[index].body = format!("{description}\n");
        }
        (None, true) => {}
        (None, false) => document.sections.push(Section {
            heading: heading.clone(),
            body: format!("{description}\n"),
        }),
    }
    write_atomically(dir, &render(&document))?;
    Ok(WorkspaceNote {
        path,
        heading,
        description,
    })
}

/// The workspace roots and their headings: the folder name, or the full path
/// when another workspace of the project has the same folder name.
fn workspaces(group: &ProjectGroupRecord) -> Vec<(String, String)> {
    let roots: Vec<_> = group
        .roots
        .iter()
        .filter(|root| root.kind != ProjectGroupRootKind::Resources)
        .collect();
    let folder = |path: &str| {
        Path::new(path)
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_else(|| path.to_string())
    };
    roots
        .iter()
        .map(|root| {
            let name = folder(&root.path);
            let shared = roots
                .iter()
                .filter(|other| folder(&other.path) == name)
                .count()
                > 1;
            let heading = if shared { root.path.clone() } else { name };
            (root.path.clone(), heading)
        })
        .collect()
}

fn validate(description: &str) -> Result<String> {
    let description = description.trim().replace("\r\n", "\n");
    if description.chars().count() > MAX_DESCRIPTION_CHARS {
        return Err(anyhow!(
            "workspace description exceeds {MAX_DESCRIPTION_CHARS} characters"
        ));
    }
    // A heading line would split the section and hand text to another workspace.
    if description
        .lines()
        .any(|line| line.trim_start().starts_with('#'))
    {
        return Err(anyhow!(
            "workspace description cannot contain heading lines"
        ));
    }
    Ok(description)
}

fn read_file(dir: &Path) -> Result<String> {
    match fs::read_to_string(dir.join(FILE_NAME)) {
        Ok(text) => Ok(text),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(String::new()),
        Err(error) => Err(error).with_context(|| format!("read {FILE_NAME}")),
    }
}

fn write_atomically(dir: &Path, text: &str) -> Result<()> {
    let temp = dir.join(format!(".{FILE_NAME}.{}.tmp", std::process::id()));
    fs::write(&temp, text).with_context(|| format!("write {}", temp.display()))?;
    if let Err(error) = fs::rename(&temp, dir.join(FILE_NAME)) {
        let _ = fs::remove_file(&temp);
        return Err(error).with_context(|| format!("replace {FILE_NAME}"));
    }
    Ok(())
}

#[derive(Debug, Default)]
struct Document {
    preamble: String,
    sections: Vec<Section>,
}

#[derive(Debug)]
struct Section {
    heading: String,
    body: String,
}

/// Split on `## ` headings outside fenced code blocks. Everything before the
/// first section is kept verbatim as the preamble.
fn parse(text: &str) -> Document {
    let mut document = Document::default();
    let mut in_fence = false;
    for line in text.split_inclusive('\n') {
        let trimmed = line.trim_end_matches(['\n', '\r']);
        if trimmed.trim_start().starts_with("```") {
            in_fence = !in_fence;
        }
        if !in_fence {
            if let Some(heading) = trimmed.strip_prefix("## ") {
                document.sections.push(Section {
                    heading: heading.trim().to_string(),
                    body: String::new(),
                });
                continue;
            }
        }
        match document.sections.last_mut() {
            Some(section) => section.body.push_str(line),
            None => document.preamble.push_str(line),
        }
    }
    document
}

fn render(document: &Document) -> String {
    let mut text = document.preamble.trim_end().to_string();
    for section in &document.sections {
        if !text.is_empty() {
            // Exactly one blank line between blocks, whatever the body ended with.
            text.truncate(text.trim_end_matches('\n').len());
            text.push_str("\n\n");
        }
        text.push_str("## ");
        text.push_str(&section.heading);
        text.push('\n');
        let body = section.body.trim_matches('\n');
        if !body.is_empty() {
            text.push_str(body);
            text.push('\n');
        }
    }
    if !text.ends_with('\n') {
        text.push('\n');
    }
    text
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::{canonical_project_path, Database};

    struct Fixture {
        _dir: tempfile::TempDir,
        db: Database,
        group: ProjectGroupRecord,
        resources: String,
        web: String,
        server: String,
    }

    fn fixture() -> Fixture {
        let dir = tempfile::tempdir().unwrap();
        let mut paths = Vec::new();
        for name in ["resources", "web", "server"] {
            let path = dir.path().join(name);
            fs::create_dir_all(&path).unwrap();
            paths.push(canonical_project_path(&path.to_string_lossy()).unwrap());
        }
        let db = Database::open(&dir.path().join("pi.sqlite")).unwrap();
        let group = db
            .create_project_group("Split", &[paths[1].clone(), paths[2].clone()])
            .unwrap();
        let group = db
            .attach_project_resource_root(&group.id, &paths[0])
            .unwrap();
        Fixture {
            _dir: dir,
            db,
            group,
            resources: paths[0].clone(),
            web: paths[1].clone(),
            server: paths[2].clone(),
        }
    }

    fn file(f: &Fixture) -> String {
        fs::read_to_string(Path::new(&f.resources).join(FILE_NAME)).unwrap()
    }

    #[test]
    fn missing_file_reads_as_empty_descriptions() {
        let f = fixture();
        let notes = read(&f.group).unwrap();
        assert_eq!(
            notes
                .iter()
                .map(|note| (note.heading.as_str(), note.description.as_str()))
                .collect::<Vec<_>>(),
            [("web", ""), ("server", "")]
        );
    }

    #[test]
    fn writing_creates_the_file_and_round_trips() {
        let f = fixture();
        write(&f.group, &f.web, "前端，React + Vite。").unwrap();
        write(&f.group, &f.server, "  后端 Rust API\n提供 /login  ").unwrap();
        assert_eq!(
            file(&f),
            "# Workspaces\n\n## web\n前端，React + Vite。\n\n## server\n后端 Rust API\n提供 /login\n"
        );
        let notes = read(&f.group).unwrap();
        assert_eq!(notes[1].description, "后端 Rust API\n提供 /login");
    }

    #[test]
    fn writes_touch_only_their_section_and_keep_user_text() {
        let f = fixture();
        fs::write(
            Path::new(&f.resources).join(FILE_NAME),
            "# 工作区\n\n手写的前言。\n\n## server\n旧说明\n\n```md\n## not a heading\n```\n\n## notes\n其他内容\n",
        )
        .unwrap();
        write(&f.group, &f.server, "新说明").unwrap();
        write(&f.group, &f.web, "前端").unwrap();
        assert_eq!(
            file(&f),
            "# 工作区\n\n手写的前言。\n\n## server\n新说明\n\n## notes\n其他内容\n\n## web\n前端\n"
        );
    }

    #[test]
    fn external_edits_apply_on_next_read() {
        let f = fixture();
        write(&f.group, &f.web, "v1").unwrap();
        fs::write(
            Path::new(&f.resources).join(FILE_NAME),
            "# Workspaces\n\n## web\nv2 from an editor\n",
        )
        .unwrap();
        assert_eq!(read(&f.group).unwrap()[0].description, "v2 from an editor");
    }

    #[test]
    fn an_empty_description_removes_the_section() {
        let f = fixture();
        write(&f.group, &f.web, "前端").unwrap();
        write(&f.group, &f.server, "后端").unwrap();
        write(&f.group, &f.web, "   ").unwrap();
        assert_eq!(file(&f), "# Workspaces\n\n## server\n后端\n");
    }

    #[test]
    fn same_folder_names_are_told_apart_by_path() {
        let dir = tempfile::tempdir().unwrap();
        let resources = dir.path().join("resources");
        let first = dir.path().join("a/app");
        let second = dir.path().join("b/app");
        for path in [&resources, &first, &second] {
            fs::create_dir_all(path).unwrap();
        }
        let canonical = |path: &Path| canonical_project_path(&path.to_string_lossy()).unwrap();
        let db = Database::open(&dir.path().join("pi.sqlite")).unwrap();
        let group = db
            .create_project_group("Twins", &[canonical(&first), canonical(&second)])
            .unwrap();
        let group = db
            .attach_project_resource_root(&group.id, &canonical(&resources))
            .unwrap();
        write(&group, &canonical(&first), "first").unwrap();
        write(&group, &canonical(&second), "second").unwrap();
        let notes = read(&group).unwrap();
        assert_eq!(notes[0].heading, canonical(&first));
        assert_eq!(notes[0].description, "first");
        assert_eq!(notes[1].description, "second");
    }

    #[test]
    fn invalid_writes_are_refused_and_leave_the_file_alone() {
        let f = fixture();
        write(&f.group, &f.web, "前端").unwrap();
        let before = file(&f);
        assert!(write(&f.group, &f.web, "line\n## server\nstolen").is_err());
        assert!(write(&f.group, &f.web, &"x".repeat(MAX_DESCRIPTION_CHARS + 1)).is_err());
        assert!(write(&f.group, &f.resources, "the resource folder").is_err());
        assert!(write(&f.group, "/elsewhere", "outside").is_err());
        assert_eq!(file(&f), before);

        let plain =
            f.db.create_project_group("Plain", &[format!("{}/..", f.resources)])
                .unwrap();
        assert!(write(&plain, &plain.roots[0].path, "no resource folder").is_err());
    }
}
