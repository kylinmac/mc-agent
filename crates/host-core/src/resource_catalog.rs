//! Project resource catalog (mc-agent R3 list, R4 confirmation, R2 summary).
//!
//! Files inside the resource folder are listed automatically: the first-level
//! folder is the category, files at the folder root are uncategorized, and
//! hidden files, symlinks and the reserved `workspaces.md` / `AGENTS.md` are
//! skipped. Files in a workspace and URLs are registered explicitly.
//!
//! A resource is a draft until the user confirms it. Confirming a file records
//! its content hash; every listing re-hashes confirmed files and reports
//! `changed` when the content moved on, so a confirmed version is never shown
//! as current after an outside edit. Registrations and states live in their
//! own kv namespaces keyed by project group id.

use std::collections::BTreeMap;
use std::fs;
use std::io::Read;
use std::path::{Component, Path, PathBuf};

use anyhow::{anyhow, Context, Result};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::db::{now_ms, Database, ProjectGroupRecord, ProjectGroupRootKind};

const ENTRIES_NAMESPACE: &str = "mcResourceEntries";
const STATES_NAMESPACE: &str = "mcResourceStates";
const RESERVED_ROOT_FILES: &[&str] = &[crate::workspace_notes::FILE_NAME, "AGENTS.md"];
const MAX_LISTED_FILES: usize = 2_000;
const MAX_DEPTH: usize = 8;
const MAX_HASHED_BYTES: u64 = 50 * 1024 * 1024;
const MAX_TITLE_CHARS: usize = 200;
const MAX_URL_CHARS: usize = 2_048;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ResourceStatus {
    Draft,
    Confirmed,
    /// Confirmed, but the file no longer matches the confirmed content.
    Changed,
    Deprecated,
    Missing,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ResourceSource {
    Folder,
    Workspace,
    Url,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ResourceItem {
    pub key: String,
    pub source: ResourceSource,
    /// First-level folder of the resource folder; empty when uncategorized.
    pub category: String,
    pub title: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    pub status: ResourceStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub confirmed_at: Option<i64>,
}

#[derive(Debug, Clone, Default, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ResourceSummary {
    pub total: usize,
    pub draft: usize,
    pub confirmed: usize,
    pub changed: usize,
    pub deprecated: usize,
    pub missing: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResourceListing {
    pub items: Vec<ResourceItem>,
    pub summary: ResourceSummary,
    pub categories: Vec<String>,
    /// True when the folder had more files than the listing shows.
    pub truncated: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct Entry {
    id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    root: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    relative: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    url: Option<String>,
    title: String,
    category: String,
    added_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct State {
    confirmed: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    hash: Option<String>,
    at: i64,
}

/// What a resource key resolves to, for opening it.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ResourceTarget {
    Path(String),
    Url(String),
}

pub fn list(db: &Database, group: &ProjectGroupRecord) -> Result<ResourceListing> {
    let states = load_states(db, &group.id)?;
    let mut items = Vec::new();
    let mut categories = Vec::new();
    let mut truncated = false;
    if let Some(resources) = group.resource_root() {
        let root = Path::new(&resources.path);
        let (files, more) = scan(root)?;
        truncated = more;
        categories = first_level_folders(root)?;
        for relative in files {
            let key = format!("folder:{relative}");
            let category = match relative.split_once('/') {
                Some((category, _)) => category.to_string(),
                None => String::new(),
            };
            let path = root.join(&relative);
            let title = relative.rsplit('/').next().unwrap_or(&relative).to_string();
            items.push(item(
                &key,
                ResourceSource::Folder,
                category,
                title,
                Some(path),
                None,
                &states,
            )?);
        }
    }
    for entry in load_entries(db, &group.id)? {
        let key = format!("entry:{}", entry.id);
        let item = match (&entry.url, &entry.root, &entry.relative) {
            (Some(url), _, _) => item(
                &key,
                ResourceSource::Url,
                entry.category.clone(),
                entry.title.clone(),
                None,
                Some(url.clone()),
                &states,
            )?,
            (None, Some(root), Some(relative)) => {
                let path = Path::new(root).join(relative);
                item(
                    &key,
                    ResourceSource::Workspace,
                    entry.category.clone(),
                    entry.title.clone(),
                    Some(path),
                    None,
                    &states,
                )?
            }
            _ => continue,
        };
        items.push(item);
    }
    let mut summary = ResourceSummary {
        total: items.len(),
        ..ResourceSummary::default()
    };
    for item in &items {
        match item.status {
            ResourceStatus::Draft => summary.draft += 1,
            ResourceStatus::Confirmed => summary.confirmed += 1,
            ResourceStatus::Changed => summary.changed += 1,
            ResourceStatus::Deprecated => summary.deprecated += 1,
            ResourceStatus::Missing => summary.missing += 1,
        }
    }
    Ok(ResourceListing {
        items,
        summary,
        categories,
        truncated,
    })
}

/// Mark a resource draft, confirmed or deprecated. Confirming a file hashes
/// its current content; a file that cannot be read is never confirmed.
pub fn set_status(
    db: &Database,
    group: &ProjectGroupRecord,
    key: &str,
    status: ResourceStatus,
) -> Result<()> {
    let target = locate(db, group, key)?;
    let mut states = load_states(db, &group.id)?;
    match status {
        ResourceStatus::Draft => {
            states.remove(key);
        }
        ResourceStatus::Confirmed => {
            let hash = match &target {
                ResourceTarget::Path(path) => Some(hash_file(Path::new(path))?),
                ResourceTarget::Url(_) => None,
            };
            states.insert(
                key.to_string(),
                State {
                    confirmed: true,
                    hash,
                    at: now_ms(),
                },
            );
        }
        ResourceStatus::Deprecated => {
            states.insert(
                key.to_string(),
                State {
                    confirmed: false,
                    hash: None,
                    at: now_ms(),
                },
            );
        }
        ResourceStatus::Changed | ResourceStatus::Missing => {
            return Err(anyhow!("{status:?} is computed, not set"));
        }
    }
    save_states(db, &group.id, &states)
}

/// Register a file inside one of the project's workspaces.
pub fn register_file(
    db: &Database,
    group: &ProjectGroupRecord,
    path: &str,
    category: &str,
    title: Option<&str>,
) -> Result<String> {
    let canonical =
        fs::canonicalize(path).with_context(|| format!("resource file not found: {path}"))?;
    if !canonical.is_file() {
        return Err(anyhow!("resource is not a file: {path}"));
    }
    let root = group
        .roots
        .iter()
        .filter(|root| root.kind == ProjectGroupRootKind::Workspace)
        .find_map(|root| {
            let base = fs::canonicalize(&root.path).ok()?;
            let relative = canonical.strip_prefix(&base).ok()?;
            Some((root.path.clone(), relative.to_path_buf()))
        });
    let Some((root, relative)) = root else {
        return Err(anyhow!(
            "file is not inside a workspace of this project: {path}"
        ));
    };
    let relative = relative_string(&relative)?;
    let title = clean_title(title)
        .unwrap_or_else(|| relative.rsplit('/').next().unwrap_or(&relative).to_string());
    add_entry(
        db,
        group,
        Entry {
            id: uuid::Uuid::new_v4().to_string(),
            root: Some(root),
            relative: Some(relative),
            url: None,
            title,
            category: clean_category(category)?,
            added_at: now_ms(),
        },
    )
}

pub fn register_url(
    db: &Database,
    group: &ProjectGroupRecord,
    url: &str,
    category: &str,
    title: Option<&str>,
) -> Result<String> {
    let url = url.trim();
    let scheme_ok = url.starts_with("https://") || url.starts_with("http://");
    if !scheme_ok || url.chars().count() > MAX_URL_CHARS || url.chars().any(char::is_whitespace) {
        return Err(anyhow!("resource link must be an http(s) URL"));
    }
    add_entry(
        db,
        group,
        Entry {
            id: uuid::Uuid::new_v4().to_string(),
            root: None,
            relative: None,
            url: Some(url.to_string()),
            title: clean_title(title).unwrap_or_else(|| url.to_string()),
            category: clean_category(category)?,
            added_at: now_ms(),
        },
    )
}

/// Remove a registration. Folder files are not registrations and the file on
/// disk is never touched.
pub fn unregister(db: &Database, group: &ProjectGroupRecord, key: &str) -> Result<()> {
    let id = key
        .strip_prefix("entry:")
        .ok_or_else(|| anyhow!("only registered resources can be removed: {key}"))?;
    let mut entries = load_entries(db, &group.id)?;
    let before = entries.len();
    entries.retain(|entry| entry.id != id);
    if entries.len() == before {
        return Err(anyhow!("resource not found: {key}"));
    }
    save_entries(db, &group.id, &entries)?;
    let mut states = load_states(db, &group.id)?;
    states.remove(key);
    save_states(db, &group.id, &states)
}

/// Resolve a key to the file or URL it names, only within this project.
pub fn locate(db: &Database, group: &ProjectGroupRecord, key: &str) -> Result<ResourceTarget> {
    if let Some(relative) = key.strip_prefix("folder:") {
        let resources = group
            .resource_root()
            .ok_or_else(|| anyhow!("project has no resource folder"))?;
        let relative = safe_relative(relative)?;
        return Ok(ResourceTarget::Path(
            Path::new(&resources.path)
                .join(relative)
                .to_string_lossy()
                .into_owned(),
        ));
    }
    let id = key
        .strip_prefix("entry:")
        .ok_or_else(|| anyhow!("unknown resource key: {key}"))?;
    let entry = load_entries(db, &group.id)?
        .into_iter()
        .find(|entry| entry.id == id)
        .ok_or_else(|| anyhow!("resource not found: {key}"))?;
    match (entry.url, entry.root, entry.relative) {
        (Some(url), _, _) => Ok(ResourceTarget::Url(url)),
        (None, Some(root), Some(relative)) => Ok(ResourceTarget::Path(
            Path::new(&root)
                .join(safe_relative(&relative)?)
                .to_string_lossy()
                .into_owned(),
        )),
        _ => Err(anyhow!("resource entry is malformed: {key}")),
    }
}

fn item(
    key: &str,
    source: ResourceSource,
    category: String,
    title: String,
    path: Option<PathBuf>,
    url: Option<String>,
    states: &BTreeMap<String, State>,
) -> Result<ResourceItem> {
    let state = states.get(key);
    let exists = path.as_ref().is_none_or(|path| path.is_file());
    let status = match state {
        _ if !exists => ResourceStatus::Missing,
        None => ResourceStatus::Draft,
        Some(state) if !state.confirmed => ResourceStatus::Deprecated,
        Some(state) => match (&state.hash, &path) {
            (Some(hash), Some(path)) => match hash_file(path) {
                Ok(current) if &current == hash => ResourceStatus::Confirmed,
                _ => ResourceStatus::Changed,
            },
            _ => ResourceStatus::Confirmed,
        },
    };
    Ok(ResourceItem {
        key: key.to_string(),
        source,
        category,
        title,
        path: path.map(|path| path.to_string_lossy().into_owned()),
        url,
        status,
        confirmed_at: state.filter(|state| state.confirmed).map(|state| state.at),
    })
}

/// Files below `root`, as `/`-separated relative paths, sorted.
fn scan(root: &Path) -> Result<(Vec<String>, bool)> {
    let mut files = Vec::new();
    let mut truncated = false;
    let walker = walkdir::WalkDir::new(root)
        .min_depth(1)
        .max_depth(MAX_DEPTH)
        .follow_links(false)
        .sort_by_file_name()
        .into_iter()
        .filter_entry(|entry| !entry.file_name().to_string_lossy().starts_with('.'));
    for entry in walker {
        let Ok(entry) = entry else { continue };
        if !entry.file_type().is_file() {
            continue;
        }
        let relative = relative_string(entry.path().strip_prefix(root)?)?;
        if !relative.contains('/') && RESERVED_ROOT_FILES.contains(&relative.as_str()) {
            continue;
        }
        if files.len() == MAX_LISTED_FILES {
            truncated = true;
            break;
        }
        files.push(relative);
    }
    Ok((files, truncated))
}

fn first_level_folders(root: &Path) -> Result<Vec<String>> {
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

fn hash_file(path: &Path) -> Result<String> {
    let metadata = fs::metadata(path).with_context(|| format!("read {}", path.display()))?;
    if metadata.len() > MAX_HASHED_BYTES {
        return Err(anyhow!("file is too large to confirm: {}", path.display()));
    }
    let mut file = fs::File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let read = file.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(hex::encode(hasher.finalize()))
}

fn relative_string(path: &Path) -> Result<String> {
    let mut parts = Vec::new();
    for component in path.components() {
        match component {
            Component::Normal(part) => parts.push(part.to_string_lossy().into_owned()),
            _ => return Err(anyhow!("unexpected path component in {}", path.display())),
        }
    }
    Ok(parts.join("/"))
}

/// A stored relative path may never climb out of its base.
fn safe_relative(relative: &str) -> Result<PathBuf> {
    let path = Path::new(relative);
    if relative.is_empty()
        || path.is_absolute()
        || path
            .components()
            .any(|part| !matches!(part, Component::Normal(_)))
    {
        return Err(anyhow!("invalid resource path: {relative}"));
    }
    Ok(path.to_path_buf())
}

fn clean_title(title: Option<&str>) -> Option<String> {
    title
        .map(str::trim)
        .filter(|title| !title.is_empty())
        .map(|title| title.chars().take(MAX_TITLE_CHARS).collect())
}

fn clean_category(category: &str) -> Result<String> {
    let category = category.trim();
    if category.contains(['/', '\\']) || category.starts_with('.') || category.chars().count() > 80
    {
        return Err(anyhow!("invalid resource category: {category}"));
    }
    Ok(category.to_string())
}

fn add_entry(db: &Database, group: &ProjectGroupRecord, entry: Entry) -> Result<String> {
    let mut entries = load_entries(db, &group.id)?;
    let duplicate = entries.iter().any(|existing| {
        (entry.url.is_some() && existing.url == entry.url)
            || (entry.relative.is_some()
                && existing.root == entry.root
                && existing.relative == entry.relative)
    });
    if duplicate {
        return Err(anyhow!("resource is already registered"));
    }
    let key = format!("entry:{}", entry.id);
    entries.push(entry);
    save_entries(db, &group.id, &entries)?;
    Ok(key)
}

fn load_entries(db: &Database, group_id: &str) -> Result<Vec<Entry>> {
    Ok(match db.kv_get(ENTRIES_NAMESPACE, group_id)? {
        Some(value) => serde_json::from_value(value).context("parse resource registrations")?,
        None => Vec::new(),
    })
}

fn save_entries(db: &Database, group_id: &str, entries: &[Entry]) -> Result<()> {
    db.kv_set(ENTRIES_NAMESPACE, group_id, &serde_json::to_value(entries)?)
}

fn load_states(db: &Database, group_id: &str) -> Result<BTreeMap<String, State>> {
    Ok(match db.kv_get(STATES_NAMESPACE, group_id)? {
        Some(value) => serde_json::from_value(value).context("parse resource states")?,
        None => BTreeMap::new(),
    })
}

fn save_states(db: &Database, group_id: &str, states: &BTreeMap<String, State>) -> Result<()> {
    db.kv_set(STATES_NAMESPACE, group_id, &serde_json::to_value(states)?)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::canonical_project_path;

    struct Fixture {
        _dir: tempfile::TempDir,
        db: Database,
        group: ProjectGroupRecord,
        resources: PathBuf,
        web: PathBuf,
    }

    fn fixture() -> Fixture {
        let dir = tempfile::tempdir().unwrap();
        let resources = dir.path().join("resources");
        let web = dir.path().join("web");
        for path in [&resources, &web] {
            fs::create_dir_all(path).unwrap();
        }
        fs::create_dir_all(resources.join("requirements/login")).unwrap();
        fs::create_dir_all(resources.join("reference")).unwrap();
        fs::create_dir_all(resources.join(".git")).unwrap();
        fs::write(resources.join("requirements/login/spec.md"), "v1").unwrap();
        fs::write(resources.join("reference/api.md"), "api").unwrap();
        fs::write(resources.join("notes.md"), "loose").unwrap();
        fs::write(resources.join("workspaces.md"), "# Workspaces").unwrap();
        fs::write(resources.join("AGENTS.md"), "# rules").unwrap();
        fs::write(resources.join(".DS_Store"), "x").unwrap();
        fs::write(resources.join(".git/HEAD"), "ref").unwrap();
        fs::write(web.join("README.md"), "web").unwrap();
        let canonical = |path: &Path| canonical_project_path(&path.to_string_lossy()).unwrap();
        let db = Database::open(&dir.path().join("pi.sqlite")).unwrap();
        let group = db.create_project_group("App", &[canonical(&web)]).unwrap();
        let group = db
            .attach_project_resource_root(&group.id, &canonical(&resources))
            .unwrap();
        Fixture {
            _dir: dir,
            db,
            group,
            resources: PathBuf::from(canonical(&resources)),
            web: PathBuf::from(canonical(&web)),
        }
    }

    fn status_of(listing: &ResourceListing, key: &str) -> ResourceStatus {
        listing
            .items
            .iter()
            .find(|item| item.key == key)
            .unwrap()
            .status
    }

    #[test]
    fn the_folder_is_listed_by_category_without_reserved_or_hidden_files() {
        let f = fixture();
        let listing = list(&f.db, &f.group).unwrap();
        let rows: Vec<_> = listing
            .items
            .iter()
            .map(|item| (item.category.as_str(), item.key.as_str(), item.status))
            .collect();
        assert_eq!(
            rows,
            [
                ("", "folder:notes.md", ResourceStatus::Draft),
                (
                    "reference",
                    "folder:reference/api.md",
                    ResourceStatus::Draft
                ),
                (
                    "requirements",
                    "folder:requirements/login/spec.md",
                    ResourceStatus::Draft
                ),
            ]
        );
        assert_eq!(listing.categories, ["reference", "requirements"]);
        assert_eq!(listing.summary.draft, 3);
    }

    #[test]
    fn a_confirmed_file_turns_changed_when_edited_and_missing_when_deleted() {
        let f = fixture();
        let key = "folder:requirements/login/spec.md";
        set_status(&f.db, &f.group, key, ResourceStatus::Confirmed).unwrap();
        assert_eq!(
            status_of(&list(&f.db, &f.group).unwrap(), key),
            ResourceStatus::Confirmed
        );

        fs::write(f.resources.join("requirements/login/spec.md"), "v2").unwrap();
        let listing = list(&f.db, &f.group).unwrap();
        assert_eq!(status_of(&listing, key), ResourceStatus::Changed);
        assert_eq!(listing.summary.changed, 1);

        set_status(&f.db, &f.group, key, ResourceStatus::Confirmed).unwrap();
        assert_eq!(
            status_of(&list(&f.db, &f.group).unwrap(), key),
            ResourceStatus::Confirmed
        );

        set_status(&f.db, &f.group, key, ResourceStatus::Deprecated).unwrap();
        assert_eq!(
            status_of(&list(&f.db, &f.group).unwrap(), key),
            ResourceStatus::Deprecated
        );
        set_status(&f.db, &f.group, key, ResourceStatus::Draft).unwrap();
        assert_eq!(
            status_of(&list(&f.db, &f.group).unwrap(), key),
            ResourceStatus::Draft
        );
    }

    #[test]
    fn workspace_files_and_links_are_registered_and_removed_without_touching_disk() {
        let f = fixture();
        let file_key = register_file(
            &f.db,
            &f.group,
            &f.web.join("README.md").to_string_lossy(),
            "reference",
            None,
        )
        .unwrap();
        let url_key = register_url(
            &f.db,
            &f.group,
            "https://example.com/design",
            "prototype",
            Some("设计稿"),
        )
        .unwrap();
        let listing = list(&f.db, &f.group).unwrap();
        let file = listing
            .items
            .iter()
            .find(|item| item.key == file_key)
            .unwrap();
        assert_eq!(file.source, ResourceSource::Workspace);
        assert_eq!(file.title, "README.md");
        let link = listing
            .items
            .iter()
            .find(|item| item.key == url_key)
            .unwrap();
        assert_eq!(link.url.as_deref(), Some("https://example.com/design"));
        assert_eq!(link.title, "设计稿");

        set_status(&f.db, &f.group, &url_key, ResourceStatus::Confirmed).unwrap();
        assert_eq!(
            status_of(&list(&f.db, &f.group).unwrap(), &url_key),
            ResourceStatus::Confirmed
        );

        unregister(&f.db, &f.group, &file_key).unwrap();
        assert!(f.web.join("README.md").is_file());
        assert!(list(&f.db, &f.group)
            .unwrap()
            .items
            .iter()
            .all(|item| item.key != file_key));
        assert!(unregister(&f.db, &f.group, "folder:notes.md").is_err());
    }

    #[test]
    fn registration_is_limited_to_project_workspaces_and_valid_links() {
        let f = fixture();
        let outside = f._dir.path().join("outside.md");
        fs::write(&outside, "x").unwrap();
        assert!(register_file(&f.db, &f.group, &outside.to_string_lossy(), "", None).is_err());
        assert!(register_file(
            &f.db,
            &f.group,
            &f.resources.join("notes.md").to_string_lossy(),
            "",
            None
        )
        .is_err());
        assert!(register_url(&f.db, &f.group, "file:///etc/passwd", "", None).is_err());
        assert!(register_url(&f.db, &f.group, "javascript:alert(1)", "", None).is_err());
        register_url(&f.db, &f.group, "https://example.com", "", None).unwrap();
        assert!(register_url(&f.db, &f.group, "https://example.com", "", None).is_err());
        assert!(register_url(&f.db, &f.group, "https://example.com/x", "../escape", None).is_err());
    }

    #[test]
    fn keys_cannot_reach_outside_the_project() {
        let f = fixture();
        for key in [
            "folder:../pi.sqlite",
            "folder:/etc/passwd",
            "folder:",
            "other:x",
            "entry:missing",
        ] {
            assert!(locate(&f.db, &f.group, key).is_err(), "{key}");
            assert!(
                set_status(&f.db, &f.group, key, ResourceStatus::Confirmed).is_err(),
                "{key}"
            );
        }
        assert_eq!(
            locate(&f.db, &f.group, "folder:reference/api.md").unwrap(),
            ResourceTarget::Path(
                f.resources
                    .join("reference/api.md")
                    .to_string_lossy()
                    .into_owned()
            )
        );
    }

    #[test]
    fn computed_statuses_cannot_be_set() {
        let f = fixture();
        assert!(set_status(&f.db, &f.group, "folder:notes.md", ResourceStatus::Changed).is_err());
        assert!(set_status(&f.db, &f.group, "folder:notes.md", ResourceStatus::Missing).is_err());
    }
}
