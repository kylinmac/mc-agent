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
use crate::resource_index::{self, IndexTarget};

const STATES_NAMESPACE: &str = "mcResourceStates";
const RESERVED_ROOT_FILES: &[&str] = &[
    crate::workspace_notes::FILE_NAME,
    "AGENTS.md",
    crate::resource_overview::OVERVIEW_FILE,
];
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
        // The studio's own folder, when it lives here, is not scanned: its
        // outputs are not project documents. Files in it the user confirmed
        // as resources stay listed, so no reference disappears.
        let managed = crate::mc_creative::managed_resource_subfolder(db, group);
        let (mut files, more) = scan(root, managed)?;
        truncated = more;
        categories = first_level_folders(root)?;
        if let Some(managed) = managed {
            categories.retain(|name| name != managed);
            let prefix = format!("folder:{managed}/");
            for key in states.keys() {
                if let Some(relative) = key.strip_prefix("folder:") {
                    if key.starts_with(&prefix) && root.join(relative).is_file() {
                        files.push(relative.to_string());
                    }
                }
            }
        }
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
    if let Some(resources) = group.resource_root() {
        for entry in resource_index::read_all(Path::new(&resources.path))? {
            let item = match &entry.target {
                IndexTarget::Url(url) => item(
                    &entry.key,
                    ResourceSource::Url,
                    entry.category.clone(),
                    entry.title.clone(),
                    None,
                    Some(url.clone()),
                    &states,
                )?,
                IndexTarget::Path(path) => {
                    // A path outside the project is shown as missing and
                    // never opened or hashed.
                    let inside = inside_project(group, path);
                    item(
                        &entry.key,
                        ResourceSource::Workspace,
                        entry.category.clone(),
                        entry.title.clone(),
                        inside.then(|| path.clone()),
                        None,
                        &states,
                    )
                    .map(|mut item| {
                        if !inside {
                            item.status = ResourceStatus::Missing;
                        }
                        item
                    })?
                }
            };
            items.push(item);
        }
    }
    let mut paths: BTreeMap<PathBuf, usize> = BTreeMap::new();
    let mut unique: Vec<ResourceItem> = Vec::new();
    for item in items {
        // Keep explicit confirmation/deprecation state without rewriting old keys.
        if let Some(path) = item
            .path
            .as_deref()
            .and_then(|path| fs::canonicalize(path).ok())
        {
            if let Some(&index) = paths.get(&path) {
                if states.contains_key(&item.key) && !states.contains_key(&unique[index].key) {
                    unique[index] = item;
                }
                continue;
            }
            paths.insert(path, unique.len());
        }
        unique.push(item);
    }
    let items = unique;
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
    let listing = ResourceListing {
        items,
        summary,
        categories,
        truncated,
    };
    // Keep RESOURCES.md in step with what is listed. Best effort: a folder
    // that cannot be written still lists.
    if let Some(resources) = group.resource_root() {
        let root = Path::new(&resources.path);
        let descriptions = crate::resource_overview::template_descriptions(root);
        let _ = crate::resource_overview::write_if_changed(root, &listing, &descriptions);
    }
    Ok(listing)
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

/// Register a file inside one of the project's workspaces by adding a link
/// to the category's `INDEX.md`; the file itself is not copied.
pub fn register_file(
    db: &Database,
    group: &ProjectGroupRecord,
    path: &str,
    category: &str,
    title: Option<&str>,
) -> Result<String> {
    let resources = resource_folder(group)?;
    let canonical =
        fs::canonicalize(path).with_context(|| format!("resource file not found: {path}"))?;
    if !canonical.is_file() {
        return Err(anyhow!("resource is not a file: {path}"));
    }
    let in_workspace = group
        .roots
        .iter()
        .filter(|root| root.kind != ProjectGroupRootKind::Resources)
        .any(|root| fs::canonicalize(&root.path).is_ok_and(|base| canonical.starts_with(base)));
    if !in_workspace {
        return Err(anyhow!(
            "file is not inside a workspace of this project: {path}"
        ));
    }
    let category = clean_category(category)?;
    let listing = list(db, group)?;
    if let Some(existing) = listing.items.iter().find(|item| {
        item.category != category
            && item
                .path
                .as_deref()
                .and_then(|candidate| fs::canonicalize(candidate).ok())
                .as_deref()
                == Some(canonical.as_path())
    }) {
        return Ok(existing.key.clone());
    }
    let title = clean_title(title).unwrap_or_else(|| {
        canonical
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_default()
    });
    resource_index::add(resources, &category, &title, &IndexTarget::Path(canonical))
}

/// Find a resource in a deduplicated listing by exact key, or by resolving an
/// indexed alias key to the same canonical file or URL.
pub fn find_listed<'a>(
    listing: &'a ResourceListing,
    db: &Database,
    group: &ProjectGroupRecord,
    key: &str,
) -> Option<&'a ResourceItem> {
    if let Some(item) = listing.items.iter().find(|item| item.key == key) {
        return Some(item);
    }
    match locate(db, group, key).ok()? {
        ResourceTarget::Path(path) => {
            let wanted = fs::canonicalize(path).ok()?;
            listing.items.iter().find(|item| {
                item.path
                    .as_deref()
                    .and_then(|candidate| fs::canonicalize(candidate).ok())
                    .as_deref()
                    == Some(wanted.as_path())
            })
        }
        ResourceTarget::Url(url) => listing
            .items
            .iter()
            .find(|item| item.url.as_deref() == Some(url.as_str())),
    }
}

pub fn register_url(
    _db: &Database,
    group: &ProjectGroupRecord,
    url: &str,
    category: &str,
    title: Option<&str>,
) -> Result<String> {
    let resources = resource_folder(group)?;
    let url = url.trim();
    let scheme_ok = url.starts_with("https://") || url.starts_with("http://");
    if !scheme_ok || url.chars().count() > MAX_URL_CHARS || url.chars().any(char::is_whitespace) {
        return Err(anyhow!("resource link must be an http(s) URL"));
    }
    resource_index::add(
        resources,
        &clean_category(category)?,
        &clean_title(title).unwrap_or_else(|| url.to_string()),
        &IndexTarget::Url(url.to_string()),
    )
}

/// Remove an index entry. Folder files are not entries, and the linked file
/// is never touched.
pub fn unregister(db: &Database, group: &ProjectGroupRecord, key: &str) -> Result<()> {
    if !key.starts_with("index:") {
        return Err(anyhow!("only indexed resources can be removed: {key}"));
    }
    resource_index::remove(resource_folder(group)?, key)?;
    let mut states = load_states(db, &group.id)?;
    states.remove(key);
    save_states(db, &group.id, &states)
}

/// Resolve a key to the file or URL it names, only within this project.
pub fn locate(_db: &Database, group: &ProjectGroupRecord, key: &str) -> Result<ResourceTarget> {
    let resources = resource_folder(group)?;
    if let Some(relative) = key.strip_prefix("folder:") {
        let relative = safe_relative(relative)?;
        return Ok(ResourceTarget::Path(
            resources.join(relative).to_string_lossy().into_owned(),
        ));
    }
    if key.starts_with("index:") {
        return match resource_index::find(resources, key)?.target {
            IndexTarget::Url(url) => Ok(ResourceTarget::Url(url)),
            IndexTarget::Path(path) if inside_project(group, &path) => {
                Ok(ResourceTarget::Path(path.to_string_lossy().into_owned()))
            }
            IndexTarget::Path(path) => Err(anyhow!(
                "indexed file is outside this project: {}",
                path.display()
            )),
        };
    }
    Err(anyhow!("unknown resource key: {key}"))
}

fn resource_folder(group: &ProjectGroupRecord) -> Result<&Path> {
    group
        .resource_root()
        .map(|root| Path::new(&root.path))
        .ok_or_else(|| anyhow!("project has no resource folder"))
}

/// Whether `path` (resolved, possibly through symlinks) lies in one of the
/// project's folders.
fn inside_project(group: &ProjectGroupRecord, path: &Path) -> bool {
    let resolved = fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    group.roots.iter().any(|root| {
        fs::canonicalize(&root.path)
            .map(|base| resolved.starts_with(base))
            .unwrap_or(false)
    })
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
fn scan(root: &Path, skip: Option<&str>) -> Result<(Vec<String>, bool)> {
    let mut files = Vec::new();
    let mut truncated = false;
    let walker = walkdir::WalkDir::new(root)
        .min_depth(1)
        .max_depth(MAX_DEPTH)
        .follow_links(false)
        .sort_by_file_name()
        .into_iter()
        .filter_entry(|entry| {
            let name = entry.file_name().to_string_lossy();
            let hidden = name.starts_with('.');
            let skipped = entry.depth() == 1 && skip == Some(name.as_ref());
            !hidden && !skipped
        });
    for entry in walker {
        let Ok(entry) = entry else { continue };
        if !entry.file_type().is_file() {
            continue;
        }
        let relative = relative_string(entry.path().strip_prefix(root)?)?;
        if !relative.contains('/') && RESERVED_ROOT_FILES.contains(&relative.as_str()) {
            continue;
        }
        let depth = relative.matches('/').count();
        if depth <= 1 && relative.rsplit('/').next() == Some(resource_index::INDEX_FILE) {
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

pub(crate) fn hash_file(path: &Path) -> Result<String> {
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
#[path = "resource_catalog_tests.rs"]
mod tests;
