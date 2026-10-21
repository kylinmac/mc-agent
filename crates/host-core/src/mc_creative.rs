//! mc-agent: the creative studio's records (docs/mc-agent/creative-studio.md).
//!
//! A creative project is an ordinary project group whose purpose is marked
//! `creative`; its files live under `creative/` in one of the group's folders
//! (see [`Storage`]), one sub-folder per category. This module keeps the index
//! beside them:
//!
//! - **Assets:** every image the studio knows, with where it came from
//!   (reference, model, code, import). Removing one from the library only
//!   hides the record; deleting the file is a separate call.
//! - **Generation jobs:** one per request, from chat, the form, or code. Each
//!   result is recorded with its file path *before* it is registered as an
//!   asset, so a failed registration is completed from the record instead of
//!   calling the model again.
//! - **References:** which assets a result used, in order and with a role
//!   (many to many).
//! - **Categories:** user-made, nested; each is a folder, and moving an image
//!   between categories moves its file.
//! - **Comparisons:** saved sets of asset references with a note and a pick.
//!
//! The tables are mc-owned (`mc_creative_*`) and created when missing, so
//! they never touch upstream's schema version.

use anyhow::{anyhow, Context, Result};
use rusqlite::{params, OptionalExtension, Row};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::fs;
use std::path::{Path, PathBuf};

use crate::db::{now_ms, Database, ProjectGroupRecord};

const PURPOSE_NAMESPACE: &str = "mc.projectPurpose";
const STORAGE_NAMESPACE: &str = "mc.creativeStorage";
/// Inside a workspace, everything the studio writes lives under this folder.
const WORKSPACE_DIR: &str = "creative";
const MAX_RESULTS: usize = 10;
const MAX_REFERENCES: usize = 10;
const MAX_TEXT_CHARS: usize = 32_000;
const MAX_COMPARISON_ITEMS: usize = 8;

const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS mc_creative_assets (
  id          TEXT PRIMARY KEY,
  group_id    TEXT NOT NULL,
  origin      TEXT NOT NULL,
  kind        TEXT NOT NULL DEFAULT 'image',
  path        TEXT NOT NULL,
  sha256      TEXT NOT NULL,
  mime        TEXT,
  width       INTEGER,
  height      INTEGER,
  bytes       INTEGER NOT NULL DEFAULT 0,
  title       TEXT NOT NULL DEFAULT '',
  favorite    INTEGER NOT NULL DEFAULT 0,
  job_id      TEXT,
  result_index INTEGER,
  created_at  INTEGER NOT NULL,
  removed_at  INTEGER,
  category    TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_mc_creative_assets_group ON mc_creative_assets(group_id, created_at);
CREATE TABLE IF NOT EXISTS mc_creative_jobs (
  id          TEXT PRIMARY KEY,
  group_id    TEXT NOT NULL,
  entry       TEXT NOT NULL,
  session_id  TEXT,
  provider_id TEXT,
  model_id    TEXT,
  snapshot    TEXT NOT NULL,
  status      TEXT NOT NULL,
  error       TEXT,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  ended_at    INTEGER
);
CREATE INDEX IF NOT EXISTS idx_mc_creative_jobs_group ON mc_creative_jobs(group_id, created_at);
CREATE TABLE IF NOT EXISTS mc_creative_job_results (
  job_id    TEXT NOT NULL,
  idx       INTEGER NOT NULL,
  status    TEXT NOT NULL,
  path      TEXT,
  asset_id  TEXT,
  error     TEXT,
  PRIMARY KEY (job_id, idx)
);
CREATE TABLE IF NOT EXISTS mc_creative_asset_refs (
  asset_id     TEXT NOT NULL,
  ref_asset_id TEXT NOT NULL,
  position     INTEGER NOT NULL,
  role         TEXT NOT NULL,
  PRIMARY KEY (asset_id, ref_asset_id, role)
);
CREATE TABLE IF NOT EXISTS mc_creative_categories (
  group_id   TEXT NOT NULL,
  path       TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (group_id, path)
);
CREATE TABLE IF NOT EXISTS mc_creative_comparisons (
  id         TEXT PRIMARY KEY,
  group_id   TEXT NOT NULL,
  title      TEXT NOT NULL,
  note       TEXT NOT NULL DEFAULT '',
  chosen     TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS mc_creative_comparison_items (
  comparison_id TEXT NOT NULL,
  asset_id      TEXT NOT NULL,
  position      INTEGER NOT NULL,
  PRIMARY KEY (comparison_id, asset_id)
);
";

fn ensure_schema(db: &Database) -> Result<()> {
    db.conn()
        .execute_batch(SCHEMA)
        .context("create creative tables")?;
    // Tables made before categories existed get the column.
    let has_category: bool = db
        .conn()
        .prepare("SELECT 1 FROM pragma_table_info('mc_creative_assets') WHERE name = 'category'")?
        .exists([])?;
    if !has_category {
        db.conn().execute_batch(
            "ALTER TABLE mc_creative_assets ADD COLUMN category TEXT NOT NULL DEFAULT ''",
        )?;
    }
    Ok(())
}

// ---- purpose ----------------------------------------------------------------

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum Purpose {
    Code,
    Creative,
}

/// Every group whose purpose is not the default (`code`).
pub fn purposes(db: &Database) -> Result<Value> {
    let mut stmt = db
        .conn()
        .prepare("SELECT key, value_json FROM kv WHERE ns = ?1")?;
    let rows = stmt.query_map(params![PURPOSE_NAMESPACE], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
    })?;
    let mut map = serde_json::Map::new();
    for row in rows {
        let (key, value) = row?;
        if let Ok(value) = serde_json::from_str::<Value>(&value) {
            map.insert(key, value);
        }
    }
    Ok(Value::Object(map))
}

#[cfg(test)]
pub fn purpose(db: &Database, group_id: &str) -> Result<Purpose> {
    Ok(db
        .kv_get(PURPOSE_NAMESPACE, group_id)?
        .and_then(|value| serde_json::from_value(value).ok())
        .unwrap_or(Purpose::Code))
}

pub fn set_purpose(db: &Database, group: &ProjectGroupRecord, purpose: Purpose) -> Result<()> {
    match purpose {
        Purpose::Code => db.kv_delete(PURPOSE_NAMESPACE, &group.id),
        Purpose::Creative => db.kv_set(PURPOSE_NAMESPACE, &group.id, &json!(purpose)),
    }
}

/// A new creative project from a folder the user picked (for example the code
/// project the art is for): a new project with that folder as its workspace,
/// storing under `<folder>/creative/`.
pub fn create_project(db: &Database, name: &str, folder: &Path) -> Result<ProjectGroupRecord> {
    if !folder.is_dir() {
        return Err(anyhow!("INVALID_ARGUMENT: the folder does not exist"));
    }
    let folder = crate::db::canonical_project_path(&folder.to_string_lossy())
        .ok_or_else(|| anyhow!("INVALID_ARGUMENT: folder required"))?;
    let name = match name.trim() {
        "" => Path::new(&folder)
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_else(|| "project".into()),
        name => name.to_string(),
    };
    if name.chars().count() > 120 {
        return Err(anyhow!("INVALID_ARGUMENT: a project needs a short name"));
    }
    if let Some(existing) = db.project_group_for_path(&folder)? {
        if !existing.legacy {
            return Err(anyhow!(
                "CONFLICT: the folder already belongs to the project {}; choose that project instead",
                existing.name
            ));
        }
    }
    let group = db.create_project_group(&name, std::slice::from_ref(&folder))?;
    set_purpose(db, &group, Purpose::Creative)?;
    set_storage(db, &group, &folder)?;
    Ok(group)
}

/// Use an existing project for creative work: store in one of its folders, or
/// first add a new folder to it as a workspace.
pub fn use_workspace(
    db: &Database,
    group: &ProjectGroupRecord,
    folder: &Path,
    add: bool,
) -> Result<(ProjectGroupRecord, Storage)> {
    let wanted = crate::db::canonical_project_path(&folder.to_string_lossy())
        .ok_or_else(|| anyhow!("INVALID_ARGUMENT: folder required"))?;
    let group = if group.roots.iter().any(|root| root.path == wanted) {
        group.clone()
    } else if add {
        if !Path::new(&wanted).is_dir() {
            return Err(anyhow!("INVALID_ARGUMENT: the folder does not exist"));
        }
        let mut paths: Vec<String> = group.roots.iter().map(|root| root.path.clone()).collect();
        paths.push(wanted.clone());
        db.update_project_group(&group.id, &group.name, &paths, None)
            .map_err(|error| anyhow!("CONFLICT: {error}"))?
    } else {
        return Err(anyhow!("INVALID_ARGUMENT: not a folder of this project"));
    };
    set_purpose(db, &group, Purpose::Creative)?;
    let storage = set_storage(db, &group, &wanted)?;
    Ok((group, storage))
}

// ---- image models added by hand ---------------------------------------------

const ACCOUNT_IMAGE_MODELS_NAMESPACE: &str = "mc.accountImageModels";
const MAX_ACCOUNT_IMAGE_MODELS: usize = 20;

/// Image model ids the user added to subscription accounts, by provider id.
/// They join the account's own (or built-in) list, so a model the app does not
/// know yet can be used without waiting for an update.
pub fn account_image_models(db: &Database) -> Result<Value> {
    let mut stmt = db
        .conn()
        .prepare("SELECT key, value_json FROM kv WHERE ns = ?1")?;
    let rows = stmt.query_map(params![ACCOUNT_IMAGE_MODELS_NAMESPACE], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
    })?;
    let mut map = serde_json::Map::new();
    for row in rows {
        let (key, value) = row?;
        if let Ok(value) = serde_json::from_str::<Value>(&value) {
            map.insert(key, value);
        }
    }
    Ok(Value::Object(map))
}

pub fn set_account_image_models(
    db: &Database,
    provider_id: &str,
    ids: &[String],
) -> Result<Vec<String>> {
    let provider_id = provider_id.trim();
    if provider_id.is_empty() {
        return Err(anyhow!("INVALID_ARGUMENT: provider id required"));
    }
    let mut cleaned: Vec<String> = Vec::new();
    for id in ids {
        let id = id.trim();
        if id.is_empty() {
            continue;
        }
        if id.chars().count() > 120
            || !id
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_' | ':' | '/'))
        {
            return Err(anyhow!("INVALID_ARGUMENT: not a model id: {id}"));
        }
        if !cleaned
            .iter()
            .any(|existing| existing.eq_ignore_ascii_case(id))
        {
            cleaned.push(id.to_string());
        }
    }
    if cleaned.len() > MAX_ACCOUNT_IMAGE_MODELS {
        return Err(anyhow!(
            "INVALID_ARGUMENT: at most {MAX_ACCOUNT_IMAGE_MODELS} models"
        ));
    }
    if cleaned.is_empty() {
        db.kv_delete(ACCOUNT_IMAGE_MODELS_NAMESPACE, provider_id)?;
    } else {
        db.kv_set(ACCOUNT_IMAGE_MODELS_NAMESPACE, provider_id, &json!(cleaned))?;
    }
    Ok(cleaned)
}

// ---- records ----------------------------------------------------------------

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum Origin {
    Reference,
    Model,
    Code,
    Import,
}

impl Origin {
    fn as_str(self) -> &'static str {
        match self {
            Origin::Reference => "reference",
            Origin::Model => "model",
            Origin::Code => "code",
            Origin::Import => "import",
        }
    }
    fn parse(value: &str) -> Origin {
        match value {
            "reference" => Origin::Reference,
            "code" => Origin::Code,
            "import" => Origin::Import,
            _ => Origin::Model,
        }
    }
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Asset {
    pub id: String,
    pub group_id: String,
    pub origin: Origin,
    pub kind: String,
    pub path: String,
    pub sha256: String,
    pub mime: Option<String>,
    pub width: Option<i64>,
    pub height: Option<i64>,
    pub bytes: i64,
    pub title: String,
    pub favorite: bool,
    pub job_id: Option<String>,
    pub result_index: Option<i64>,
    pub created_at: i64,
    pub removed_at: Option<i64>,
    /// The category folder, e.g. `角色/角色A`; empty for uncategorized.
    pub category: String,
    /// False when the file is gone from disk.
    pub file_exists: bool,
}

const ASSET_COLUMNS: &str = "id, group_id, origin, kind, path, sha256, mime, width, height, bytes, title, favorite, job_id, result_index, created_at, removed_at, category";

fn asset_from_row(row: &Row<'_>) -> rusqlite::Result<Asset> {
    let path: String = row.get(4)?;
    Ok(Asset {
        id: row.get(0)?,
        group_id: row.get(1)?,
        origin: Origin::parse(&row.get::<_, String>(2)?),
        kind: row.get(3)?,
        file_exists: Path::new(&path).is_file(),
        path,
        sha256: row.get(5)?,
        mime: row.get(6)?,
        width: row.get(7)?,
        height: row.get(8)?,
        bytes: row.get(9)?,
        title: row.get(10)?,
        favorite: row.get::<_, i64>(11)? != 0,
        job_id: row.get(12)?,
        result_index: row.get(13)?,
        created_at: row.get(14)?,
        removed_at: row.get(15)?,
        category: row.get(16)?,
    })
}

/// What a file is, as Electron main measured it (it decodes images).
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileFacts {
    pub mime: Option<String>,
    pub width: Option<i64>,
    pub height: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ReferenceUse {
    pub asset_id: String,
    /// `reference`, `edit` (the image being changed) or `style`.
    pub role: String,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum JobStatus {
    Pending,
    Running,
    Saving,
    Done,
    Partial,
    Failed,
    Cancelled,
    Interrupted,
}

impl JobStatus {
    fn as_str(self) -> &'static str {
        match self {
            JobStatus::Pending => "pending",
            JobStatus::Running => "running",
            JobStatus::Saving => "saving",
            JobStatus::Done => "done",
            JobStatus::Partial => "partial",
            JobStatus::Failed => "failed",
            JobStatus::Cancelled => "cancelled",
            JobStatus::Interrupted => "interrupted",
        }
    }
    fn parse(value: &str) -> JobStatus {
        serde_json::from_value(json!(value)).unwrap_or(JobStatus::Failed)
    }
    fn is_final(self) -> bool {
        !matches!(
            self,
            JobStatus::Pending | JobStatus::Running | JobStatus::Saving
        )
    }
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct JobResult {
    pub index: i64,
    pub status: String,
    pub path: Option<String>,
    pub asset_id: Option<String>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Job {
    pub id: String,
    pub group_id: String,
    /// `chat`, `form` or `code`.
    pub entry: String,
    pub session_id: Option<String>,
    pub provider_id: Option<String>,
    pub model_id: Option<String>,
    /// What was asked, exactly as sent: prompt, parameters, references (with
    /// order and role), or for code the script and command.
    pub snapshot: Value,
    pub status: JobStatus,
    pub error: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
    pub ended_at: Option<i64>,
    pub results: Vec<JobResult>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JobInput {
    pub entry: String,
    #[serde(default)]
    pub session_id: Option<String>,
    #[serde(default)]
    pub provider_id: Option<String>,
    #[serde(default)]
    pub model_id: Option<String>,
    pub snapshot: Value,
    /// How many results the job asks for.
    pub count: usize,
}

// ---- helpers ----------------------------------------------------------------

/// Where a creative project keeps its files: `<folder>/creative/`, with one
/// folder per category (`角色/角色A/…`), `未分类/` for the rest, and `scripts/`
/// for code drawings' scripts. The folder is one of the project's folders.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Storage {
    /// The project folder chosen (a root of the group).
    pub folder: PathBuf,
    /// `workspace` or `resources`.
    pub kind: String,
    pub base: PathBuf,
    /// Where uncategorized images go.
    pub uncategorized: PathBuf,
    pub scripts: PathBuf,
}

/// The folder uncategorized images live in, and a name categories cannot use.
pub const UNCATEGORIZED_DIR: &str = "未分类";
const SCRIPTS_DIR: &str = "scripts";
const MAX_CATEGORY_DEPTH: usize = 6;

fn storage_for(folder: &Path, resources: bool) -> Storage {
    let base = folder.join(WORKSPACE_DIR);
    Storage {
        folder: folder.to_path_buf(),
        kind: if resources { "resources" } else { "workspace" }.into(),
        uncategorized: base.join(UNCATEGORIZED_DIR),
        scripts: base.join(SCRIPTS_DIR),
        base,
    }
}

impl Storage {
    /// The folder of a category (an empty category is uncategorized).
    pub fn category_dir(&self, category: &str) -> PathBuf {
        if category.is_empty() {
            self.uncategorized.clone()
        } else {
            self.base.join(category)
        }
    }
}

/// A category path as stored: segments joined by `/`, each trimmed; empty for
/// uncategorized. Refuses names that are not plain folder names.
pub fn normalize_category(raw: &str) -> Result<String> {
    let segments: Vec<&str> = raw
        .split(['/', '\\'])
        .map(str::trim)
        .filter(|segment| !segment.is_empty())
        .collect();
    if segments.len() > MAX_CATEGORY_DEPTH {
        return Err(anyhow!(
            "INVALID_ARGUMENT: categories nest at most {MAX_CATEGORY_DEPTH} levels"
        ));
    }
    for segment in &segments {
        if *segment == "."
            || *segment == ".."
            || segment.starts_with('.')
            || segment.chars().count() > 60
            || segment
                .chars()
                .any(|c| c.is_control() || matches!(c, ':' | '*' | '?' | '"' | '<' | '>' | '|'))
        {
            return Err(anyhow!("INVALID_ARGUMENT: not a folder name: {segment}"));
        }
    }
    if segments
        .first()
        .is_some_and(|first| *first == SCRIPTS_DIR || *first == UNCATEGORIZED_DIR)
    {
        return Err(anyhow!("INVALID_ARGUMENT: that name is reserved"));
    }
    Ok(segments.join("/"))
}

/// The project's storage: the folder the user chose, else its first
/// workspace, else its resource folder.
pub fn storage(db: &Database, group: &ProjectGroupRecord) -> Result<Storage> {
    let chosen = db.kv_get(STORAGE_NAMESPACE, &group.id)?.and_then(|value| {
        value
            .get("folder")
            .and_then(Value::as_str)
            .map(str::to_string)
    });
    let root = chosen
        .and_then(|folder| group.roots.iter().find(|root| root.path == folder))
        .or_else(|| {
            group
                .roots
                .iter()
                .find(|root| root.kind != crate::db::ProjectGroupRootKind::Resources)
        })
        .or_else(|| group.roots.first())
        .ok_or_else(|| anyhow!("PRECONDITION: the project has no folder"))?;
    let resources = root.kind == crate::db::ProjectGroupRootKind::Resources;
    Ok(storage_for(Path::new(&root.path), resources))
}

/// Choose which of the project's folders keeps its files. Files already
/// stored stay where they are.
pub fn set_storage(db: &Database, group: &ProjectGroupRecord, folder: &str) -> Result<Storage> {
    let wanted = crate::db::canonical_project_path(folder)
        .ok_or_else(|| anyhow!("INVALID_ARGUMENT: folder required"))?;
    if !group.roots.iter().any(|root| root.path == wanted) {
        return Err(anyhow!("INVALID_ARGUMENT: not a folder of this project"));
    }
    db.kv_set(STORAGE_NAMESPACE, &group.id, &json!({ "folder": wanted }))?;
    storage(db, group)
}

/// Whether `path` is inside one of the project's folders.
fn in_project(group: &ProjectGroupRecord, path: &Path) -> bool {
    group
        .roots
        .iter()
        .any(|root| within(Path::new(&root.path), path))
}

fn sha256_file(path: &Path) -> Result<(String, i64)> {
    let bytes = fs::read(path).with_context(|| format!("read {}", path.display()))?;
    Ok((hex::encode(Sha256::digest(&bytes)), bytes.len() as i64))
}

fn safe_file_name(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .map(|c| {
            if c.is_alphanumeric() || matches!(c, '.' | '-' | '_') {
                c
            } else {
                '-'
            }
        })
        .collect();
    let trimmed = cleaned.trim_matches(|c| c == '.' || c == '-');
    if trimmed.is_empty() {
        "image".to_string()
    } else {
        trimmed.chars().take(80).collect()
    }
}

fn within(root: &Path, path: &Path) -> bool {
    match (root.canonicalize(), path.canonicalize()) {
        (Ok(root), Ok(path)) => path.starts_with(root),
        _ => false,
    }
}

fn insert_asset(
    db: &Database,
    group_id: &str,
    origin: Origin,
    path: &Path,
    facts: &FileFacts,
    title: &str,
    job: Option<(&str, i64)>,
    category: &str,
) -> Result<Asset> {
    let (sha, bytes) = sha256_file(path)?;
    let id = uuid::Uuid::new_v4().to_string();
    db.conn().execute(
        "INSERT INTO mc_creative_assets (id, group_id, origin, kind, path, sha256, mime, width, height, bytes, title, job_id, result_index, created_at, category)
         VALUES (?1, ?2, ?3, 'image', ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)",
        params![
            id,
            group_id,
            origin.as_str(),
            path.to_string_lossy(),
            sha,
            facts.mime,
            facts.width,
            facts.height,
            bytes,
            title.chars().take(200).collect::<String>(),
            job.map(|(job, _)| job.to_string()),
            job.map(|(_, index)| index),
            now_ms(),
            category
        ],
    )?;
    if !category.is_empty() {
        remember_category(db, group_id, category)?;
    }
    get_asset(db, &id)?.ok_or_else(|| anyhow!("asset vanished"))
}

pub fn get_asset(db: &Database, id: &str) -> Result<Option<Asset>> {
    ensure_schema(db)?;
    Ok(db
        .conn()
        .query_row(
            &format!("SELECT {ASSET_COLUMNS} FROM mc_creative_assets WHERE id = ?1"),
            params![id],
            asset_from_row,
        )
        .optional()?)
}

fn group_asset(db: &Database, group: &ProjectGroupRecord, id: &str) -> Result<Asset> {
    get_asset(db, id)?
        .filter(|asset| asset.group_id == group.id)
        .ok_or_else(|| anyhow!("NOT_FOUND: asset not found"))
}

// ---- assets -----------------------------------------------------------------

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AssetFilter {
    #[serde(default)]
    pub origin: Option<Origin>,
    #[serde(default)]
    pub favorite: bool,
    #[serde(default)]
    pub include_removed: bool,
    #[serde(default)]
    pub query: Option<String>,
}

pub fn list_assets(
    db: &Database,
    group: &ProjectGroupRecord,
    filter: &AssetFilter,
) -> Result<Vec<Asset>> {
    ensure_schema(db)?;
    let mut stmt = db.conn().prepare(&format!(
        "SELECT {ASSET_COLUMNS} FROM mc_creative_assets WHERE group_id = ?1 ORDER BY created_at DESC, result_index ASC"
    ))?;
    let needle = filter
        .query
        .as_deref()
        .map(str::to_lowercase)
        .filter(|q| !q.trim().is_empty());
    let rows = stmt.query_map(params![group.id], asset_from_row)?;
    let mut assets = Vec::new();
    for row in rows {
        let asset = row?;
        if asset.removed_at.is_some() && !filter.include_removed {
            continue;
        }
        if filter.origin.is_some_and(|origin| origin != asset.origin)
            || (filter.favorite && !asset.favorite)
        {
            continue;
        }
        if let Some(needle) = &needle {
            let prompt = asset
                .job_id
                .as_deref()
                .and_then(|job| get_job(db, job).ok().flatten())
                .and_then(|job| {
                    job.snapshot
                        .get("prompt")
                        .and_then(Value::as_str)
                        .map(str::to_lowercase)
                })
                .unwrap_or_default();
            if !asset.title.to_lowercase().contains(needle) && !prompt.contains(needle) {
                continue;
            }
        }
        assets.push(asset);
    }
    Ok(assets)
}

/// Copy a reference into the project (deduplicated by content) and register
/// it. Later changes to the original never reach the project.
pub fn import_reference(
    db: &Database,
    group: &ProjectGroupRecord,
    source: &Path,
    facts: &FileFacts,
    category: &str,
) -> Result<Asset> {
    ensure_schema(db)?;
    let store = storage(db, group)?;
    let category = normalize_category(category)?;
    if !source.is_file() {
        return Err(anyhow!("INVALID_ARGUMENT: the file does not exist"));
    }
    let (sha, _) = sha256_file(source)?;
    let existing: Option<String> = db
        .conn()
        .query_row(
            "SELECT id FROM mc_creative_assets WHERE group_id = ?1 AND sha256 = ?2 AND origin = 'reference' ORDER BY created_at LIMIT 1",
            params![group.id, sha],
            |row| row.get(0),
        )
        .optional()?;
    if let Some(id) = existing {
        let asset = group_asset(db, group, &id)?;
        if asset.file_exists {
            db.conn().execute(
                "UPDATE mc_creative_assets SET removed_at = NULL WHERE id = ?1",
                params![id],
            )?;
            return group_asset(db, group, &id);
        }
    }
    let dir = store.category_dir(&category);
    fs::create_dir_all(&dir)?;
    let name = source
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default();
    let target = dir.join(format!("{}-{}", &sha[..8], safe_file_name(&name)));
    if !target.exists() {
        fs::copy(source, &target).with_context(|| format!("copy {}", source.display()))?;
    }
    let title = Path::new(&name)
        .file_stem()
        .map(|stem| stem.to_string_lossy().into_owned())
        .unwrap_or_default();
    insert_asset(
        db,
        &group.id,
        Origin::Reference,
        &target,
        facts,
        &title,
        None,
        &category,
    )
}

/// Register an image already inside the project folder (an imported file).
pub fn import_existing(
    db: &Database,
    group: &ProjectGroupRecord,
    path: &Path,
    facts: &FileFacts,
) -> Result<Asset> {
    ensure_schema(db)?;
    if !in_project(group, path) || !path.is_file() {
        return Err(anyhow!(
            "INVALID_ARGUMENT: the file is not inside the project folder"
        ));
    }
    let title = path
        .file_stem()
        .map(|stem| stem.to_string_lossy().into_owned())
        .unwrap_or_default();
    insert_asset(db, &group.id, Origin::Import, path, facts, &title, None, "")
}

pub fn set_favorite(
    db: &Database,
    group: &ProjectGroupRecord,
    id: &str,
    favorite: bool,
) -> Result<Asset> {
    group_asset(db, group, id)?;
    db.conn().execute(
        "UPDATE mc_creative_assets SET favorite = ?2 WHERE id = ?1",
        params![id, favorite as i64],
    )?;
    group_asset(db, group, id)
}

pub fn set_title(
    db: &Database,
    group: &ProjectGroupRecord,
    id: &str,
    title: &str,
) -> Result<Asset> {
    group_asset(db, group, id)?;
    let title: String = title.trim().chars().take(200).collect();
    db.conn().execute(
        "UPDATE mc_creative_assets SET title = ?2 WHERE id = ?1",
        params![id, title],
    )?;
    group_asset(db, group, id)
}

/// Take the asset out of the library; the file stays on disk.
pub fn remove_asset(db: &Database, group: &ProjectGroupRecord, id: &str) -> Result<Asset> {
    group_asset(db, group, id)?;
    db.conn().execute(
        "UPDATE mc_creative_assets SET removed_at = ?2 WHERE id = ?1 AND removed_at IS NULL",
        params![id, now_ms()],
    )?;
    group_asset(db, group, id)
}

pub fn restore_asset(db: &Database, group: &ProjectGroupRecord, id: &str) -> Result<Asset> {
    group_asset(db, group, id)?;
    db.conn().execute(
        "UPDATE mc_creative_assets SET removed_at = NULL WHERE id = ?1",
        params![id],
    )?;
    group_asset(db, group, id)
}

/// Delete the file itself (only inside the project folder) and remove the
/// asset from the library. The record stays, so snapshots that used it still
/// name it.
pub fn delete_asset_file(db: &Database, group: &ProjectGroupRecord, id: &str) -> Result<Asset> {
    let asset = group_asset(db, group, id)?;
    let path = Path::new(&asset.path);
    if path.exists() {
        if !in_project(group, path) {
            return Err(anyhow!(
                "PERMISSION_DENIED: the file is outside the project folder"
            ));
        }
        fs::remove_file(path).with_context(|| format!("delete {}", path.display()))?;
    }
    remove_asset(db, group, id)
}

/// The assets a result used, and the results that used an asset.
pub fn asset_links(db: &Database, group: &ProjectGroupRecord, id: &str) -> Result<Value> {
    group_asset(db, group, id)?;
    let uses = |sql: &str| -> Result<Vec<Value>> {
        let mut stmt = db.conn().prepare(sql)?;
        let rows = stmt.query_map(params![id], |row| {
            Ok(json!({ "assetId": row.get::<_, String>(0)?, "position": row.get::<_, i64>(1)?, "role": row.get::<_, String>(2)? }))
        })?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    };
    Ok(json!({
        "uses": uses("SELECT ref_asset_id, position, role FROM mc_creative_asset_refs WHERE asset_id = ?1 ORDER BY position")?,
        "usedBy": uses("SELECT asset_id, position, role FROM mc_creative_asset_refs WHERE ref_asset_id = ?1 ORDER BY asset_id")?,
    }))
}

// ---- jobs -------------------------------------------------------------------

fn snapshot_references(snapshot: &Value) -> Vec<ReferenceUse> {
    snapshot
        .get("references")
        .cloned()
        .and_then(|value| serde_json::from_value::<Vec<ReferenceUse>>(value).ok())
        .unwrap_or_default()
}

pub fn get_job(db: &Database, id: &str) -> Result<Option<Job>> {
    ensure_schema(db)?;
    let job = db
        .conn()
        .query_row(
            "SELECT id, group_id, entry, session_id, provider_id, model_id, snapshot, status, error, created_at, updated_at, ended_at FROM mc_creative_jobs WHERE id = ?1",
            params![id],
            |row| {
                Ok(Job {
                    id: row.get(0)?,
                    group_id: row.get(1)?,
                    entry: row.get(2)?,
                    session_id: row.get(3)?,
                    provider_id: row.get(4)?,
                    model_id: row.get(5)?,
                    snapshot: serde_json::from_str(&row.get::<_, String>(6)?).unwrap_or(Value::Null),
                    status: JobStatus::parse(&row.get::<_, String>(7)?),
                    error: row.get(8)?,
                    created_at: row.get(9)?,
                    updated_at: row.get(10)?,
                    ended_at: row.get(11)?,
                    results: Vec::new(),
                })
            },
        )
        .optional()?;
    let Some(mut job) = job else { return Ok(None) };
    let mut stmt = db.conn().prepare(
        "SELECT idx, status, path, asset_id, error FROM mc_creative_job_results WHERE job_id = ?1 ORDER BY idx",
    )?;
    job.results = stmt
        .query_map(params![id], |row| {
            Ok(JobResult {
                index: row.get(0)?,
                status: row.get(1)?,
                path: row.get(2)?,
                asset_id: row.get(3)?,
                error: row.get(4)?,
            })
        })?
        .collect::<rusqlite::Result<_>>()?;
    Ok(Some(job))
}

fn group_job(db: &Database, group: &ProjectGroupRecord, id: &str) -> Result<Job> {
    get_job(db, id)?
        .filter(|job| job.group_id == group.id)
        .ok_or_else(|| anyhow!("NOT_FOUND: generation not found"))
}

/// Record a request before anything runs: the queue shows it at once, and
/// every result has a row to land in.
pub fn create_job(db: &Database, group: &ProjectGroupRecord, input: JobInput) -> Result<Job> {
    ensure_schema(db)?;
    if !matches!(input.entry.as_str(), "chat" | "form" | "code") {
        return Err(anyhow!("INVALID_ARGUMENT: unknown entry"));
    }
    if input.count == 0 || input.count > MAX_RESULTS {
        return Err(anyhow!(
            "INVALID_ARGUMENT: a generation asks for 1 to {MAX_RESULTS} results"
        ));
    }
    if input.snapshot.to_string().chars().count() > MAX_TEXT_CHARS * 2 {
        return Err(anyhow!("INVALID_ARGUMENT: the request is too large"));
    }
    if let Some(raw) = input.snapshot.get("category").and_then(Value::as_str) {
        normalize_category(raw)?;
    }
    let references = snapshot_references(&input.snapshot);
    if references.len() > MAX_REFERENCES {
        return Err(anyhow!("INVALID_ARGUMENT: too many references"));
    }
    for reference in &references {
        group_asset(db, group, &reference.asset_id)?;
    }
    storage(db, group)?;
    let id = uuid::Uuid::new_v4().to_string();
    let now = now_ms();
    let tx = db.conn().unchecked_transaction()?;
    tx.execute(
        "INSERT INTO mc_creative_jobs (id, group_id, entry, session_id, provider_id, model_id, snapshot, status, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'pending', ?8, ?8)",
        params![id, group.id, input.entry, input.session_id, input.provider_id, input.model_id, input.snapshot.to_string(), now],
    )?;
    for index in 0..input.count {
        tx.execute(
            "INSERT INTO mc_creative_job_results (job_id, idx, status) VALUES (?1, ?2, 'pending')",
            params![id, index as i64],
        )?;
    }
    tx.commit()?;
    group_job(db, group, &id)
}

/// Where the job's results are written: the folder of the chosen category.
pub fn output_dir(db: &Database, group: &ProjectGroupRecord, category: &str) -> Result<PathBuf> {
    let dir = storage(db, group)?.category_dir(&normalize_category(category)?);
    fs::create_dir_all(&dir)?;
    Ok(dir)
}

/// The category a job's results go to (from its snapshot; empty when none).
fn snapshot_category(snapshot: &Value) -> String {
    snapshot
        .get("category")
        .and_then(Value::as_str)
        .and_then(|raw| normalize_category(raw).ok())
        .unwrap_or_default()
}

pub fn set_job_status(
    db: &Database,
    group: &ProjectGroupRecord,
    id: &str,
    status: JobStatus,
    error: Option<&str>,
) -> Result<Job> {
    let job = group_job(db, group, id)?;
    if job.status.is_final() {
        return Ok(job);
    }
    let now = now_ms();
    db.conn().execute(
        "UPDATE mc_creative_jobs SET status = ?2, error = COALESCE(?3, error), updated_at = ?4, ended_at = CASE WHEN ?5 THEN ?4 ELSE ended_at END WHERE id = ?1",
        params![id, status.as_str(), error, now, status.is_final()],
    )?;
    if status.is_final() {
        // Results that never reported end with the job.
        let left = if status == JobStatus::Cancelled {
            "cancelled"
        } else {
            "failed"
        };
        db.conn().execute(
            "UPDATE mc_creative_job_results SET status = ?2 WHERE job_id = ?1 AND status = 'pending'",
            params![id, left],
        )?;
    }
    group_job(db, group, id)
}

/// Record one result. A saved file is written to the record first and then
/// registered; a registration that fails leaves the path for `reconcile`.
pub fn record_result(
    db: &Database,
    group: &ProjectGroupRecord,
    id: &str,
    index: i64,
    path: Option<&Path>,
    facts: &FileFacts,
    error: Option<&str>,
) -> Result<Job> {
    let job = group_job(db, group, id)?;
    let Some(result) = job.results.iter().find(|result| result.index == index) else {
        return Err(anyhow!("INVALID_ARGUMENT: no such result"));
    };
    if result.asset_id.is_some() {
        return Ok(job);
    }
    match path {
        Some(path) => {
            if !in_project(group, path) {
                return Err(anyhow!(
                    "PERMISSION_DENIED: results are saved inside the project folder"
                ));
            }
            db.conn().execute(
                "UPDATE mc_creative_job_results SET status = 'saved', path = ?3, error = NULL WHERE job_id = ?1 AND idx = ?2",
                params![id, index, path.to_string_lossy()],
            )?;
            register_result(db, group, &job, index, path, facts)?;
        }
        None => {
            db.conn().execute(
                "UPDATE mc_creative_job_results SET status = 'failed', error = ?3 WHERE job_id = ?1 AND idx = ?2",
                params![id, index, error.unwrap_or("failed")],
            )?;
        }
    }
    settle(db, group, id)
}

fn register_result(
    db: &Database,
    group: &ProjectGroupRecord,
    job: &Job,
    index: i64,
    path: &Path,
    facts: &FileFacts,
) -> Result<()> {
    let origin = if job.entry == "code" {
        Origin::Code
    } else {
        Origin::Model
    };
    let title = job
        .snapshot
        .get("prompt")
        .and_then(Value::as_str)
        .unwrap_or("")
        .chars()
        .take(60)
        .collect::<String>();
    let category = snapshot_category(&job.snapshot);
    let asset = insert_asset(
        db,
        &group.id,
        origin,
        path,
        facts,
        &title,
        Some((&job.id, index)),
        &category,
    )?;
    for (position, reference) in snapshot_references(&job.snapshot).iter().enumerate() {
        db.conn().execute(
            "INSERT OR IGNORE INTO mc_creative_asset_refs (asset_id, ref_asset_id, position, role) VALUES (?1, ?2, ?3, ?4)",
            params![asset.id, reference.asset_id, position as i64, reference.role],
        )?;
    }
    db.conn().execute(
        "UPDATE mc_creative_job_results SET status = 'done', asset_id = ?3 WHERE job_id = ?1 AND idx = ?2",
        params![job.id, index, asset.id],
    )?;
    Ok(())
}

/// Close the job once every result has reported.
fn settle(db: &Database, group: &ProjectGroupRecord, id: &str) -> Result<Job> {
    let job = group_job(db, group, id)?;
    if job.status.is_final() || job.results.iter().any(|result| result.status == "pending") {
        return Ok(job);
    }
    let done = job
        .results
        .iter()
        .filter(|result| result.status == "done")
        .count();
    let status = match done {
        0 => JobStatus::Failed,
        n if n == job.results.len() => JobStatus::Done,
        _ => JobStatus::Partial,
    };
    set_job_status(db, group, id, status, None)
}

/// Complete registrations that a crash or an error cut off: a result whose
/// file was saved but has no asset is registered from its record, without
/// calling the model again. Returns how many were registered.
pub fn reconcile(db: &Database, group: &ProjectGroupRecord) -> Result<usize> {
    ensure_schema(db)?;
    let mut stmt = db.conn().prepare(
        "SELECT r.job_id, r.idx, r.path FROM mc_creative_job_results r JOIN mc_creative_jobs j ON j.id = r.job_id
         WHERE j.group_id = ?1 AND r.path IS NOT NULL AND r.asset_id IS NULL",
    )?;
    let pending: Vec<(String, i64, String)> = stmt
        .query_map(params![group.id], |row| {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?))
        })?
        .collect::<rusqlite::Result<_>>()?;
    let mut registered = 0;
    for (job_id, index, path) in pending {
        let path = PathBuf::from(path);
        if !path.is_file() {
            continue;
        }
        let Some(job) = get_job(db, &job_id)? else {
            continue;
        };
        register_result(db, group, &job, index, &path, &FileFacts::default())?;
        registered += 1;
        if !job.status.is_final() {
            settle(db, group, &job_id)?;
        }
    }
    Ok(registered)
}

/// At startup nothing can still be generating: Electron main runs every job.
/// Unfinished jobs are marked interrupted so the queue does not wait forever.
pub fn interrupt_unfinished(db: &Database) -> Result<usize> {
    ensure_schema(db)?;
    let now = now_ms();
    let changed = db.conn().execute(
        "UPDATE mc_creative_jobs SET status = 'interrupted', updated_at = ?1, ended_at = ?1
         WHERE status IN ('pending', 'running', 'saving')",
        params![now],
    )?;
    db.conn().execute(
        "UPDATE mc_creative_job_results SET status = 'failed', error = 'interrupted'
         WHERE status = 'pending' AND job_id IN (SELECT id FROM mc_creative_jobs WHERE status = 'interrupted')",
        [],
    )?;
    Ok(changed)
}

pub fn list_jobs(db: &Database, group: &ProjectGroupRecord, limit: usize) -> Result<Vec<Job>> {
    ensure_schema(db)?;
    let mut stmt = db.conn().prepare(
        "SELECT id FROM mc_creative_jobs WHERE group_id = ?1 ORDER BY created_at DESC LIMIT ?2",
    )?;
    let ids: Vec<String> = stmt
        .query_map(params![group.id, limit.clamp(1, 500) as i64], |row| {
            row.get(0)
        })?
        .collect::<rusqlite::Result<_>>()?;
    let mut jobs = Vec::with_capacity(ids.len());
    for id in ids {
        if let Some(job) = get_job(db, &id)? {
            jobs.push(job);
        }
    }
    Ok(jobs)
}

/// Register an image a script drew, with the script as its snapshot. The
/// image is moved into the category's folder when it is inside the project
/// and copied there otherwise; the script is kept under `scripts/`.
pub fn register_code_drawing(
    db: &Database,
    group: &ProjectGroupRecord,
    image: &Path,
    script: Option<&Path>,
    command: &str,
    session_id: Option<&str>,
    facts: &FileFacts,
    category: &str,
) -> Result<Job> {
    ensure_schema(db)?;
    let store = storage(db, group)?;
    let category = normalize_category(category)?;
    if !image.is_file() {
        return Err(anyhow!("INVALID_ARGUMENT: the image does not exist"));
    }
    let mut snapshot = json!({ "command": command.chars().take(4000).collect::<String>() });
    if let Some(script) = script {
        if !script.is_file() {
            return Err(anyhow!("INVALID_ARGUMENT: the script does not exist"));
        }
        let (sha, bytes) = sha256_file(script)?;
        if bytes > 1024 * 1024 {
            return Err(anyhow!("INVALID_ARGUMENT: the script is too large"));
        }
        let dir = store.scripts.clone();
        fs::create_dir_all(&dir)?;
        let name = script
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_default();
        let kept = dir.join(format!("{}-{}", &sha[..8], safe_file_name(&name)));
        if !kept.exists() {
            fs::copy(script, &kept)?;
        }
        snapshot["script"] = json!({
            "source": script.to_string_lossy(),
            "kept": kept.to_string_lossy(),
            "sha256": sha,
        });
    }
    // Results are filed in their category folder: a drawing already there
    // stays; one elsewhere in the project (say, its root) is moved in; one
    // outside the project (the session scratch) is copied in.
    let target = if within(&store.category_dir(&category), image) {
        image.to_path_buf()
    } else {
        let name = image
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_default();
        let target = output_dir(db, group, &category)?.join(format!(
            "{}-{}",
            &uuid::Uuid::new_v4().to_string()[..8],
            safe_file_name(&name)
        ));
        if in_project(group, image) {
            if fs::rename(image, &target).is_err() {
                fs::copy(image, &target)?;
                let _ = fs::remove_file(image);
            }
        } else {
            fs::copy(image, &target)?;
        }
        target
    };
    snapshot["category"] = json!(category);
    snapshot["prompt"] = json!(image
        .file_stem()
        .map(|stem| stem.to_string_lossy().into_owned())
        .unwrap_or_default());
    let job = create_job(
        db,
        group,
        JobInput {
            entry: "code".into(),
            session_id: session_id.map(str::to_string),
            provider_id: None,
            model_id: None,
            snapshot,
            count: 1,
        },
    )?;
    set_job_status(db, group, &job.id, JobStatus::Saving, None)?;
    record_result(db, group, &job.id, 0, Some(&target), facts, None)
}

// ---- categories -------------------------------------------------------------

/// Record a category (and its parents) so it shows even while empty.
fn remember_category(db: &Database, group_id: &str, category: &str) -> Result<()> {
    let segments: Vec<&str> = category.split('/').collect();
    for depth in 1..=segments.len() {
        db.conn().execute(
            "INSERT OR IGNORE INTO mc_creative_categories (group_id, path, created_at) VALUES (?1, ?2, ?3)",
            params![group_id, segments[..depth].join("/"), now_ms()],
        )?;
    }
    Ok(())
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CategoryInfo {
    pub path: String,
    /// Assets directly in this category (not its children).
    pub count: i64,
}

/// Every category of the project, sorted by path, with its own asset count.
pub fn list_categories(db: &Database, group: &ProjectGroupRecord) -> Result<Vec<CategoryInfo>> {
    ensure_schema(db)?;
    let mut stmt = db.conn().prepare(
        "SELECT path FROM mc_creative_categories WHERE group_id = ?1
         UNION SELECT category FROM mc_creative_assets WHERE group_id = ?1 AND category != '' AND removed_at IS NULL",
    )?;
    let mut paths: Vec<String> = stmt
        .query_map(params![group.id], |row| row.get(0))?
        .collect::<rusqlite::Result<_>>()?;
    paths.sort();
    paths.dedup();
    let mut out = Vec::with_capacity(paths.len());
    for path in paths {
        let count: i64 = db.conn().query_row(
            "SELECT COUNT(*) FROM mc_creative_assets WHERE group_id = ?1 AND category = ?2 AND removed_at IS NULL",
            params![group.id, path],
            |row| row.get(0),
        )?;
        out.push(CategoryInfo { path, count });
    }
    Ok(out)
}

pub fn create_category(db: &Database, group: &ProjectGroupRecord, raw: &str) -> Result<String> {
    ensure_schema(db)?;
    let category = normalize_category(raw)?;
    if category.is_empty() {
        return Err(anyhow!("INVALID_ARGUMENT: a category needs a name"));
    }
    fs::create_dir_all(storage(db, group)?.category_dir(&category))?;
    remember_category(db, group.id.as_str(), &category)?;
    Ok(category)
}

/// A free file name in `dir` for `name` (adds -2, -3, … when taken).
fn free_target(dir: &Path, name: &str) -> PathBuf {
    let candidate = dir.join(name);
    if !candidate.exists() {
        return candidate;
    }
    let path = Path::new(name);
    let stem = path
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_default();
    let ext = path
        .extension()
        .map(|e| format!(".{}", e.to_string_lossy()))
        .unwrap_or_default();
    (2..)
        .map(|n| dir.join(format!("{stem}-{n}{ext}")))
        .find(|p| !p.exists())
        .unwrap()
}

fn move_file(from: &Path, to: &Path) -> Result<()> {
    if fs::rename(from, to).is_err() {
        fs::copy(from, to)?;
        fs::remove_file(from)?;
    }
    Ok(())
}

/// Move assets into a category: the files move into its folder (a file that
/// is outside the project, or already gone, only changes category).
pub fn move_assets(
    db: &Database,
    group: &ProjectGroupRecord,
    ids: &[String],
    raw: &str,
) -> Result<Vec<Asset>> {
    ensure_schema(db)?;
    let category = normalize_category(raw)?;
    let dir = storage(db, group)?.category_dir(&category);
    fs::create_dir_all(&dir)?;
    if !category.is_empty() {
        remember_category(db, group.id.as_str(), &category)?;
    }
    let mut moved = Vec::new();
    for id in ids {
        let asset = group_asset(db, group, id)?;
        let from = PathBuf::from(&asset.path);
        let mut path = asset.path.clone();
        if from.is_file() && in_project(group, &from) && from.parent() != Some(dir.as_path()) {
            let name = from
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_default();
            let target = free_target(&dir, &name);
            move_file(&from, &target)?;
            path = target.to_string_lossy().into_owned();
        }
        db.conn().execute(
            "UPDATE mc_creative_assets SET category = ?2, path = ?3 WHERE id = ?1",
            params![id, category, path],
        )?;
        db.conn().execute(
            "UPDATE mc_creative_job_results SET path = ?2 WHERE asset_id = ?1",
            params![id, path],
        )?;
        moved.push(group_asset(db, group, id)?);
    }
    Ok(moved)
}

fn replace_prefix(value: &str, from: &str, to: &str) -> Option<String> {
    if value == from {
        Some(to.to_string())
    } else {
        value
            .strip_prefix(&format!("{from}/"))
            .map(|rest| format!("{to}/{rest}"))
    }
}

/// Rename (or move) a category and everything under it, folder included.
pub fn rename_category(
    db: &Database,
    group: &ProjectGroupRecord,
    from_raw: &str,
    to_raw: &str,
) -> Result<String> {
    ensure_schema(db)?;
    let from = normalize_category(from_raw)?;
    let to = normalize_category(to_raw)?;
    if from.is_empty() || to.is_empty() {
        return Err(anyhow!("INVALID_ARGUMENT: a category needs a name"));
    }
    if to == from {
        return Ok(to);
    }
    if to.starts_with(&format!("{from}/")) {
        return Err(anyhow!(
            "INVALID_ARGUMENT: a category cannot move into itself"
        ));
    }
    let store = storage(db, group)?;
    let (old_dir, new_dir) = (store.category_dir(&from), store.category_dir(&to));
    if new_dir.exists() {
        return Err(anyhow!(
            "CONFLICT: a category with that name already exists"
        ));
    }
    if old_dir.exists() {
        if let Some(parent) = new_dir.parent() {
            fs::create_dir_all(parent)?;
        }
        fs::rename(&old_dir, &new_dir).context("rename the category folder")?;
    } else {
        fs::create_dir_all(&new_dir)?;
    }
    let old_prefix = old_dir.to_string_lossy().into_owned();
    let new_prefix = new_dir.to_string_lossy().into_owned();
    let tx = db.conn().unchecked_transaction()?;
    let rows: Vec<(String, String, String)> = tx
        .prepare("SELECT id, category, path FROM mc_creative_assets WHERE group_id = ?1")?
        .query_map(params![group.id], |row| {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?))
        })?
        .collect::<rusqlite::Result<_>>()?;
    for (id, category, path) in rows {
        let Some(next) = replace_prefix(&category, &from, &to) else {
            continue;
        };
        let next_path = replace_prefix(&path, &old_prefix, &new_prefix).unwrap_or(path);
        tx.execute(
            "UPDATE mc_creative_assets SET category = ?2, path = ?3 WHERE id = ?1",
            params![id, next, next_path],
        )?;
        tx.execute(
            "UPDATE mc_creative_job_results SET path = ?2 WHERE asset_id = ?1",
            params![id, next_path],
        )?;
    }
    let categories: Vec<String> = tx
        .prepare("SELECT path FROM mc_creative_categories WHERE group_id = ?1")?
        .query_map(params![group.id], |row| row.get(0))?
        .collect::<rusqlite::Result<_>>()?;
    for path in categories {
        if let Some(next) = replace_prefix(&path, &from, &to) {
            tx.execute(
                "DELETE FROM mc_creative_categories WHERE group_id = ?1 AND path = ?2",
                params![group.id, path],
            )?;
            tx.execute(
                "INSERT OR IGNORE INTO mc_creative_categories (group_id, path, created_at) VALUES (?1, ?2, ?3)",
                params![group.id, next, now_ms()],
            )?;
        }
    }
    tx.commit()?;
    remember_category(db, group.id.as_str(), &to)?;
    Ok(to)
}

/// Delete a category: its images (and those of its children) move up to the
/// parent category, or to uncategorized; the emptied folders are removed.
pub fn delete_category(db: &Database, group: &ProjectGroupRecord, raw: &str) -> Result<()> {
    ensure_schema(db)?;
    let category = normalize_category(raw)?;
    if category.is_empty() {
        return Err(anyhow!("INVALID_ARGUMENT: uncategorized cannot be deleted"));
    }
    let parent = category
        .rsplit_once('/')
        .map(|(parent, _)| parent.to_string())
        .unwrap_or_default();
    let ids: Vec<String> = db
        .conn()
        .prepare("SELECT id, category FROM mc_creative_assets WHERE group_id = ?1")?
        .query_map(params![group.id], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?
        .into_iter()
        .filter(|(_, c)| replace_prefix(c, &category, "x").is_some())
        .map(|(id, _)| id)
        .collect();
    move_assets(db, group, &ids, &parent)?;
    let paths: Vec<String> = db
        .conn()
        .prepare("SELECT path FROM mc_creative_categories WHERE group_id = ?1")?
        .query_map(params![group.id], |row| row.get(0))?
        .collect::<rusqlite::Result<_>>()?;
    for path in paths {
        if replace_prefix(&path, &category, "x").is_some() {
            db.conn().execute(
                "DELETE FROM mc_creative_categories WHERE group_id = ?1 AND path = ?2",
                params![group.id, path],
            )?;
        }
    }
    // Only folders left empty are removed; anything else in them stays.
    let dir = storage(db, group)?.category_dir(&category);
    remove_empty_dirs(&dir);
    Ok(())
}

fn remove_empty_dirs(dir: &Path) {
    if let Ok(entries) = fs::read_dir(dir) {
        for entry in entries.flatten() {
            if entry.path().is_dir() {
                remove_empty_dirs(&entry.path());
            }
        }
    }
    let _ = fs::remove_dir(dir);
}

// ---- comparisons ------------------------------------------------------------

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Comparison {
    pub id: String,
    pub group_id: String,
    pub title: String,
    pub note: String,
    pub chosen: Option<String>,
    pub asset_ids: Vec<String>,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ComparisonInput {
    pub title: String,
    #[serde(default)]
    pub note: String,
    #[serde(default)]
    pub chosen: Option<String>,
    pub asset_ids: Vec<String>,
}

fn validate_comparison(
    db: &Database,
    group: &ProjectGroupRecord,
    input: &ComparisonInput,
) -> Result<()> {
    if input.asset_ids.len() < 2 || input.asset_ids.len() > MAX_COMPARISON_ITEMS {
        return Err(anyhow!(
            "INVALID_ARGUMENT: compare 2 to {MAX_COMPARISON_ITEMS} assets"
        ));
    }
    for id in &input.asset_ids {
        group_asset(db, group, id)?;
    }
    if input
        .chosen
        .as_ref()
        .is_some_and(|chosen| !input.asset_ids.contains(chosen))
    {
        return Err(anyhow!(
            "INVALID_ARGUMENT: the pick must be one of the compared assets"
        ));
    }
    if input.title.trim().is_empty()
        || input.title.chars().count() > 200
        || input.note.chars().count() > MAX_TEXT_CHARS
    {
        return Err(anyhow!(
            "INVALID_ARGUMENT: a comparison needs a short title"
        ));
    }
    Ok(())
}

fn write_comparison_items(db: &Database, id: &str, asset_ids: &[String]) -> Result<()> {
    db.conn().execute(
        "DELETE FROM mc_creative_comparison_items WHERE comparison_id = ?1",
        params![id],
    )?;
    for (position, asset) in asset_ids.iter().enumerate() {
        db.conn().execute(
            "INSERT OR IGNORE INTO mc_creative_comparison_items (comparison_id, asset_id, position) VALUES (?1, ?2, ?3)",
            params![id, asset, position as i64],
        )?;
    }
    Ok(())
}

pub fn get_comparison(db: &Database, group: &ProjectGroupRecord, id: &str) -> Result<Comparison> {
    ensure_schema(db)?;
    let mut comparison = db
        .conn()
        .query_row(
            "SELECT id, group_id, title, note, chosen, created_at, updated_at FROM mc_creative_comparisons WHERE id = ?1 AND group_id = ?2",
            params![id, group.id],
            |row| {
                Ok(Comparison {
                    id: row.get(0)?,
                    group_id: row.get(1)?,
                    title: row.get(2)?,
                    note: row.get(3)?,
                    chosen: row.get(4)?,
                    asset_ids: Vec::new(),
                    created_at: row.get(5)?,
                    updated_at: row.get(6)?,
                })
            },
        )
        .optional()?
        .ok_or_else(|| anyhow!("NOT_FOUND: comparison not found"))?;
    let mut stmt = db.conn().prepare(
        "SELECT asset_id FROM mc_creative_comparison_items WHERE comparison_id = ?1 ORDER BY position",
    )?;
    comparison.asset_ids = stmt
        .query_map(params![id], |row| row.get(0))?
        .collect::<rusqlite::Result<_>>()?;
    Ok(comparison)
}

pub fn list_comparisons(db: &Database, group: &ProjectGroupRecord) -> Result<Vec<Comparison>> {
    ensure_schema(db)?;
    let mut stmt = db.conn().prepare(
        "SELECT id FROM mc_creative_comparisons WHERE group_id = ?1 ORDER BY updated_at DESC",
    )?;
    let ids: Vec<String> = stmt
        .query_map(params![group.id], |row| row.get(0))?
        .collect::<rusqlite::Result<_>>()?;
    ids.iter().map(|id| get_comparison(db, group, id)).collect()
}

pub fn save_comparison(
    db: &Database,
    group: &ProjectGroupRecord,
    id: Option<&str>,
    input: ComparisonInput,
) -> Result<Comparison> {
    ensure_schema(db)?;
    validate_comparison(db, group, &input)?;
    let now = now_ms();
    let id = match id {
        Some(id) => {
            get_comparison(db, group, id)?;
            db.conn().execute(
                "UPDATE mc_creative_comparisons SET title = ?2, note = ?3, chosen = ?4, updated_at = ?5 WHERE id = ?1",
                params![id, input.title.trim(), input.note, input.chosen, now],
            )?;
            id.to_string()
        }
        None => {
            let id = uuid::Uuid::new_v4().to_string();
            db.conn().execute(
                "INSERT INTO mc_creative_comparisons (id, group_id, title, note, chosen, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)",
                params![id, group.id, input.title.trim(), input.note, input.chosen, now],
            )?;
            id
        }
    };
    write_comparison_items(db, &id, &input.asset_ids)?;
    get_comparison(db, group, &id)
}

pub fn delete_comparison(db: &Database, group: &ProjectGroupRecord, id: &str) -> Result<()> {
    get_comparison(db, group, id)?;
    db.conn().execute(
        "DELETE FROM mc_creative_comparison_items WHERE comparison_id = ?1",
        params![id],
    )?;
    db.conn().execute(
        "DELETE FROM mc_creative_comparisons WHERE id = ?1",
        params![id],
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::canonical_project_path;

    struct Fixture {
        dir: tempfile::TempDir,
        db: Database,
        group: ProjectGroupRecord,
        root: PathBuf,
    }

    fn fixture() -> Fixture {
        let dir = tempfile::tempdir().unwrap();
        let resources = dir.path().join("studio");
        let web = dir.path().join("web");
        fs::create_dir_all(&resources).unwrap();
        fs::create_dir_all(&web).unwrap();
        let db = Database::open(&dir.path().join("pi.sqlite")).unwrap();
        let canonical = |path: &Path| canonical_project_path(&path.to_string_lossy()).unwrap();
        let group = db
            .create_project_group("Studio", &[canonical(&web)])
            .unwrap();
        let group = db
            .attach_project_resource_root(&group.id, &canonical(&resources))
            .unwrap();
        let root = storage(&db, &group).unwrap().base;
        Fixture {
            dir,
            db,
            group,
            root,
        }
    }

    fn png(path: &Path, seed: u8) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, [0x89, b'P', b'N', b'G', seed]).unwrap();
    }

    fn job(f: &Fixture, references: Vec<ReferenceUse>, count: usize) -> Job {
        create_job(&f.db, &f.group, JobInput {
            entry: "form".into(),
            session_id: None,
            provider_id: Some("p".into()),
            model_id: Some("gpt-image-2".into()),
            snapshot: json!({ "prompt": "樱花背景", "params": { "size": "1024x1024" }, "references": references }),
            count,
        })
        .unwrap()
    }

    #[test]
    fn a_new_creative_project_is_made_from_a_picked_folder() {
        let f = fixture();
        let game = f.dir.path().join("game");
        fs::create_dir_all(&game).unwrap();
        let group = create_project(&f.db, "", &game).unwrap();
        assert_eq!(group.name, "game");
        assert_eq!(purpose(&f.db, &group.id).unwrap(), Purpose::Creative);
        let store = storage(&f.db, &group).unwrap();
        assert_eq!(store.kind, "workspace");
        assert_eq!(store.base, game.canonicalize().unwrap().join("creative"));
        // A folder that already belongs to a project points at that project.
        let taken = create_project(&f.db, "again", &game)
            .unwrap_err()
            .to_string();
        assert!(taken.contains("CONFLICT") && taken.contains("game"));
        assert!(create_project(&f.db, "x", &f.dir.path().join("missing")).is_err());
    }

    #[test]
    fn an_existing_project_stores_in_one_of_its_folders_or_a_new_one() {
        let f = fixture();
        // An existing workspace of the project.
        let web = f
            .group
            .roots
            .iter()
            .find(|root| root.path.ends_with("web"))
            .unwrap()
            .path
            .clone();
        let (_, store) = use_workspace(&f.db, &f.group, Path::new(&web), false).unwrap();
        assert!(store.base.ends_with("web/creative"));
        assert_eq!(purpose(&f.db, &f.group.id).unwrap(), Purpose::Creative);
        // A new folder added to the project as a workspace.
        let art = f.dir.path().join("art");
        fs::create_dir_all(&art).unwrap();
        assert!(use_workspace(&f.db, &f.group, &art, false).is_err());
        let (group, store) = use_workspace(&f.db, &f.group, &art, true).unwrap();
        assert!(group
            .roots
            .iter()
            .any(|root| Path::new(&root.path) == art.canonicalize().unwrap()));
        assert_eq!(store.base, art.canonicalize().unwrap().join("creative"));
    }

    #[test]
    fn storage_defaults_to_the_workspace_and_can_move_to_another_folder() {
        let f = fixture();
        // The fixture has a workspace (web) and a resource folder (studio).
        let store = storage(&f.db, &f.group).unwrap();
        assert_eq!(store.kind, "workspace");
        assert!(store.base.ends_with("web/creative"));
        let resources = f.group.resource_root().unwrap().path.clone();
        let moved = set_storage(&f.db, &f.group, &resources).unwrap();
        assert_eq!(moved.kind, "resources");
        assert_eq!(
            moved.uncategorized,
            Path::new(&resources).join("creative/未分类")
        );
        assert!(set_storage(&f.db, &f.group, "/not/a/folder/of/it").is_err());
    }

    #[test]
    fn hand_added_image_models_are_checked_and_kept_per_account() {
        let f = fixture();
        let saved = set_account_image_models(
            &f.db,
            "p1",
            &["gpt-image-3".into(), " GPT-IMAGE-3 ".into(), "".into()],
        )
        .unwrap();
        assert_eq!(saved, vec!["gpt-image-3".to_string()]);
        assert_eq!(
            account_image_models(&f.db).unwrap()["p1"],
            json!(["gpt-image-3"])
        );
        assert!(set_account_image_models(&f.db, "p1", &["bad id".into()]).is_err());
        set_account_image_models(&f.db, "p1", &[]).unwrap();
        assert!(account_image_models(&f.db)
            .unwrap()
            .as_object()
            .unwrap()
            .is_empty());
    }

    #[test]
    fn categories_are_folders_that_assets_move_between() {
        let f = fixture();
        assert_eq!(normalize_category(" 角色 / 角色A ").unwrap(), "角色/角色A");
        assert!(normalize_category("../x").is_err());
        assert!(normalize_category("未分类").is_err());
        assert!(normalize_category("scripts/a").is_err());
        let store = storage(&f.db, &f.group).unwrap();

        // Generated into a category folder.
        let job = create_job(
            &f.db,
            &f.group,
            JobInput {
                entry: "form".into(),
                session_id: None,
                provider_id: None,
                model_id: None,
                snapshot: json!({ "prompt": "村庄", "category": "背景/乡村" }),
                count: 1,
            },
        )
        .unwrap();
        let out = output_dir(&f.db, &f.group, "背景/乡村")
            .unwrap()
            .join("a.png");
        assert_eq!(out.parent().unwrap(), store.base.join("背景/乡村"));
        png(&out, 21);
        let job = record_result(
            &f.db,
            &f.group,
            &job.id,
            0,
            Some(&out),
            &FileFacts::default(),
            None,
        )
        .unwrap();
        let id = job.results[0].asset_id.clone().unwrap();
        assert_eq!(
            get_asset(&f.db, &id).unwrap().unwrap().category,
            "背景/乡村"
        );
        let listed: Vec<String> = list_categories(&f.db, &f.group)
            .unwrap()
            .into_iter()
            .map(|c| c.path)
            .collect();
        assert_eq!(listed, vec!["背景".to_string(), "背景/乡村".to_string()]);

        // Moved by drag: the file moves with it.
        create_category(&f.db, &f.group, "角色/角色A").unwrap();
        let moved = move_assets(&f.db, &f.group, &[id.clone()], "角色/角色A").unwrap();
        assert!(moved[0].path.contains("角色/角色A"));
        assert!(Path::new(&moved[0].path).is_file() && !out.exists());

        // Renaming a parent carries children, files and records along.
        rename_category(&f.db, &f.group, "角色", "人物").unwrap();
        let asset = get_asset(&f.db, &id).unwrap().unwrap();
        assert_eq!(asset.category, "人物/角色A");
        assert!(asset.file_exists && asset.path.contains("人物/角色A"));
        assert!(rename_category(&f.db, &f.group, "人物", "人物/子").is_err());

        // Deleting a category moves its images up and drops empty folders.
        delete_category(&f.db, &f.group, "人物").unwrap();
        let asset = get_asset(&f.db, &id).unwrap().unwrap();
        assert_eq!(asset.category, "");
        assert!(asset.file_exists && asset.path.contains("未分类"));
        assert!(!store.base.join("人物").exists());
    }

    #[test]
    fn purpose_defaults_to_code_and_only_creative_is_stored() {
        let f = fixture();
        assert_eq!(purpose(&f.db, &f.group.id).unwrap(), Purpose::Code);
        set_purpose(&f.db, &f.group, Purpose::Creative).unwrap();
        assert_eq!(purpose(&f.db, &f.group.id).unwrap(), Purpose::Creative);
        assert_eq!(purposes(&f.db).unwrap()[&f.group.id], json!("creative"));
        set_purpose(&f.db, &f.group, Purpose::Code).unwrap();
        assert!(purposes(&f.db).unwrap().as_object().unwrap().is_empty());
    }

    #[test]
    fn references_are_copied_in_once_and_survive_the_original() {
        let f = fixture();
        let outside = f.dir.path().join("desk/cat.png");
        png(&outside, 1);
        let first = import_reference(&f.db, &f.group, &outside, &FileFacts::default(), "").unwrap();
        let again = import_reference(&f.db, &f.group, &outside, &FileFacts::default(), "").unwrap();
        assert_eq!(first.id, again.id);
        assert!(first.path.starts_with(&*f.root.to_string_lossy()));
        assert_eq!(first.origin, Origin::Reference);
        fs::remove_file(&outside).unwrap();
        assert!(get_asset(&f.db, &first.id).unwrap().unwrap().file_exists);
    }

    #[test]
    fn a_job_records_each_result_and_settles_partial() {
        let f = fixture();
        let reference_file = f.dir.path().join("ref.png");
        png(&reference_file, 2);
        let reference =
            import_reference(&f.db, &f.group, &reference_file, &FileFacts::default(), "").unwrap();
        let job = job(
            &f,
            vec![ReferenceUse {
                asset_id: reference.id.clone(),
                role: "style".into(),
            }],
            2,
        );
        assert_eq!(job.status, JobStatus::Pending);
        assert_eq!(job.results.len(), 2);
        set_job_status(&f.db, &f.group, &job.id, JobStatus::Running, None).unwrap();

        let out = output_dir(&f.db, &f.group, "").unwrap().join("a.png");
        png(&out, 3);
        let after = record_result(
            &f.db,
            &f.group,
            &job.id,
            0,
            Some(&out),
            &FileFacts::default(),
            None,
        )
        .unwrap();
        assert_eq!(after.status, JobStatus::Running);
        let asset_id = after.results[0].asset_id.clone().unwrap();
        let after = record_result(
            &f.db,
            &f.group,
            &job.id,
            1,
            None,
            &FileFacts::default(),
            Some("IMAGE_HTTP_500"),
        )
        .unwrap();
        assert_eq!(after.status, JobStatus::Partial);

        let links = asset_links(&f.db, &f.group, &asset_id).unwrap();
        assert_eq!(links["uses"][0]["assetId"], json!(reference.id));
        assert_eq!(links["uses"][0]["role"], json!("style"));
        let used_by = asset_links(&f.db, &f.group, &reference.id).unwrap();
        assert_eq!(used_by["usedBy"][0]["assetId"], json!(asset_id));
        assert_eq!(
            get_asset(&f.db, &asset_id).unwrap().unwrap().title,
            "樱花背景"
        );
    }

    #[test]
    fn results_outside_the_project_are_refused() {
        let f = fixture();
        let job = job(&f, vec![], 1);
        let outside = f.dir.path().join("elsewhere.png");
        png(&outside, 4);
        assert!(record_result(
            &f.db,
            &f.group,
            &job.id,
            0,
            Some(&outside),
            &FileFacts::default(),
            None
        )
        .is_err());
    }

    #[test]
    fn a_saved_but_unregistered_result_is_registered_without_regenerating() {
        let f = fixture();
        let job = job(&f, vec![], 1);
        let out = output_dir(&f.db, &f.group, "").unwrap().join("b.png");
        png(&out, 5);
        // As if the app quit between saving the file and registering it.
        f.db.conn()
            .execute(
                "UPDATE mc_creative_job_results SET status = 'saved', path = ?2 WHERE job_id = ?1",
                params![job.id, out.to_string_lossy()],
            )
            .unwrap();
        assert_eq!(interrupt_unfinished(&f.db).unwrap(), 1);
        assert_eq!(reconcile(&f.db, &f.group).unwrap(), 1);
        let job = get_job(&f.db, &job.id).unwrap().unwrap();
        assert_eq!(job.status, JobStatus::Interrupted);
        assert!(job.results[0].asset_id.is_some());
        assert_eq!(reconcile(&f.db, &f.group).unwrap(), 0);
    }

    #[test]
    fn removing_keeps_the_file_and_deleting_removes_it() {
        let f = fixture();
        let job = job(&f, vec![], 1);
        let out = output_dir(&f.db, &f.group, "").unwrap().join("c.png");
        png(&out, 6);
        let job = record_result(
            &f.db,
            &f.group,
            &job.id,
            0,
            Some(&out),
            &FileFacts::default(),
            None,
        )
        .unwrap();
        let id = job.results[0].asset_id.clone().unwrap();
        remove_asset(&f.db, &f.group, &id).unwrap();
        assert!(out.is_file());
        assert!(list_assets(&f.db, &f.group, &AssetFilter::default())
            .unwrap()
            .is_empty());
        restore_asset(&f.db, &f.group, &id).unwrap();
        assert_eq!(
            list_assets(&f.db, &f.group, &AssetFilter::default())
                .unwrap()
                .len(),
            1
        );
        delete_asset_file(&f.db, &f.group, &id).unwrap();
        assert!(!out.exists());
        let asset = get_asset(&f.db, &id).unwrap().unwrap();
        assert!(asset.removed_at.is_some() && !asset.file_exists);
    }

    #[test]
    fn code_drawings_keep_their_script_and_are_classified_apart() {
        let f = fixture();
        let script = f.dir.path().join("pixel_board.py");
        fs::write(&script, "print('draw')").unwrap();
        let image = f.dir.path().join("board.png");
        png(&image, 7);
        let job = register_code_drawing(
            &f.db,
            &f.group,
            &image,
            Some(&script),
            "python3 pixel_board.py",
            None,
            &FileFacts::default(),
            "",
        )
        .unwrap();
        assert_eq!(job.entry, "code");
        assert_eq!(job.status, JobStatus::Done);
        let kept = job.snapshot["script"]["kept"].as_str().unwrap();
        assert!(Path::new(kept).is_file());
        let code = list_assets(
            &f.db,
            &f.group,
            &AssetFilter {
                origin: Some(Origin::Code),
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(code.len(), 1);
        assert!(code[0].path.starts_with(&*f.root.to_string_lossy()));
        assert!(code[0].path.contains("/未分类/"));
        // A drawing left elsewhere in the project is moved into its category.
        let loose = f
            .group
            .roots
            .iter()
            .find(|root| root.path.ends_with("web"))
            .unwrap()
            .path
            .clone();
        let loose = Path::new(&loose).join("red.png");
        png(&loose, 8);
        let moved = register_code_drawing(
            &f.db,
            &f.group,
            &loose,
            None,
            "python3 draw.py",
            None,
            &FileFacts::default(),
            "",
        )
        .unwrap();
        assert!(!loose.exists());
        assert!(moved.results[0]
            .path
            .as_deref()
            .unwrap()
            .contains("/未分类/"));
        assert!(list_assets(
            &f.db,
            &f.group,
            &AssetFilter {
                origin: Some(Origin::Model),
                ..Default::default()
            }
        )
        .unwrap()
        .is_empty());
    }

    #[test]
    fn comparisons_hold_references_and_a_pick_among_them() {
        let f = fixture();
        let job = job(&f, vec![], 2);
        let dir = output_dir(&f.db, &f.group, "").unwrap();
        for index in 0..2 {
            let out = dir.join(format!("d{index}.png"));
            png(&out, 10 + index as u8);
            record_result(
                &f.db,
                &f.group,
                &job.id,
                index,
                Some(&out),
                &FileFacts::default(),
                None,
            )
            .unwrap();
        }
        let ids: Vec<String> = get_job(&f.db, &job.id)
            .unwrap()
            .unwrap()
            .results
            .iter()
            .map(|r| r.asset_id.clone().unwrap())
            .collect();
        assert!(save_comparison(
            &f.db,
            &f.group,
            None,
            ComparisonInput {
                title: "x".into(),
                note: String::new(),
                chosen: None,
                asset_ids: vec![ids[0].clone()]
            }
        )
        .is_err());
        let saved = save_comparison(
            &f.db,
            &f.group,
            None,
            ComparisonInput {
                title: "构图对比".into(),
                note: "第二张光线更好".into(),
                chosen: Some(ids[1].clone()),
                asset_ids: ids.clone(),
            },
        )
        .unwrap();
        assert_eq!(saved.asset_ids, ids);
        assert_eq!(list_comparisons(&f.db, &f.group).unwrap().len(), 1);
        delete_comparison(&f.db, &f.group, &saved.id).unwrap();
        assert!(list_comparisons(&f.db, &f.group).unwrap().is_empty());
    }
}
