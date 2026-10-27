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

mod assets;
mod comparisons;
mod jobs;
mod schema;

pub use assets::*;
pub use comparisons::*;
pub use jobs::*;
use schema::ensure_schema;

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

/// One group's purpose; `code` unless marked creative.
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
    let root = match chosen {
        // A location the user chose is never swapped for another one: when it
        // is no longer a folder of the project, they choose again.
        Some(folder) => group
            .roots
            .iter()
            .find(|root| root.path == folder)
            .ok_or_else(|| {
                anyhow!(
                    "PRECONDITION: {STORAGE_UNLINKED}: the creative storage folder {folder} is no longer a folder of this project; choose where new creative files go"
                )
            })?,
        // Never chosen: the first workspace, else the first folder.
        None => group
            .roots
            .iter()
            .find(|root| root.kind != crate::db::ProjectGroupRootKind::Resources)
            .or_else(|| group.roots.first())
            .ok_or_else(|| anyhow!("PRECONDITION: the project has no folder"))?,
    };
    // Offline or unreadable: say so rather than write somewhere else.
    if !Path::new(&root.path).is_dir() {
        return Err(anyhow!(
            "PRECONDITION: {STORAGE_UNAVAILABLE}: the creative storage folder {} is not available (disconnected, moved or not readable); reconnect it or choose another location",
            root.path
        ));
    }
    let resources = root.kind == crate::db::ProjectGroupRootKind::Resources;
    Ok(storage_for(Path::new(&root.path), resources))
}

/// Error markers the studio recognises to offer choosing a new location.
pub const STORAGE_UNLINKED: &str = "STORAGE_UNLINKED";
pub const STORAGE_UNAVAILABLE: &str = "STORAGE_UNAVAILABLE";

/// The folder inside the project's resource folder that the studio manages:
/// `creative`, when the project is creative and stores its files there. The
/// resource listing leaves it out (X-CONCEPT-03), so generated images and
/// scripts do not become project documents; anything in it the user
/// confirmed as a resource stays listed.
pub fn managed_resource_subfolder(
    db: &Database,
    group: &ProjectGroupRecord,
) -> Option<&'static str> {
    if purpose(db, &group.id).ok()? != Purpose::Creative {
        return None;
    }
    let store = storage(db, group).ok()?;
    (store.kind == "resources").then_some(WORKSPACE_DIR)
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
    fn a_chosen_storage_folder_is_never_swapped_for_another() {
        let f = fixture();
        let resources = f.group.resource_root().unwrap().path.clone();
        set_storage(&f.db, &f.group, &resources).unwrap();
        // The root order does not matter once chosen.
        let mut reordered = f.group.clone();
        reordered.roots.reverse();
        assert_eq!(storage(&f.db, &reordered).unwrap().kind, "resources");

        // The chosen folder is detached from the project: no fallback to web.
        let mut detached = f.group.clone();
        detached.roots.retain(|root| root.path != resources);
        let error = storage(&f.db, &detached).unwrap_err().to_string();
        assert!(error.contains(STORAGE_UNLINKED), "{error}");
        assert!(
            output_dir(&f.db, &detached, "").is_err(),
            "nothing is written elsewhere"
        );

        // Still linked but offline: an error, not a switch.
        let moved_away = f.dir.path().join("studio-away");
        fs::rename(&resources, &moved_away).unwrap();
        let error = storage(&f.db, &f.group).unwrap_err().to_string();
        assert!(error.contains(STORAGE_UNAVAILABLE), "{error}");
        fs::rename(&moved_away, &resources).unwrap();

        // Choosing again recovers.
        let web = f
            .group
            .roots
            .iter()
            .find(|root| root.path != resources)
            .unwrap()
            .path
            .clone();
        assert_eq!(
            set_storage(&f.db, &detached, &web).unwrap().kind,
            "workspace"
        );
        assert_eq!(storage(&f.db, &detached).unwrap().kind, "workspace");
    }

    #[test]
    fn a_creative_template_lays_out_categories_once_in_an_empty_folder() {
        use crate::resource_templates::TemplateTarget;
        use crate::template_editor::{save, CategoryInput, TemplateInput};
        let f = fixture();
        let home = f.dir.path().join("home");
        let folder = |name: &str| CategoryInput {
            name: name.into(),
            description: String::new(),
        };
        let template = |name: &str, target, folders: Vec<CategoryInput>| TemplateInput {
            name: name.into(),
            description: String::new(),
            categories: folders,
            create: true,
            copy_from: None,
            target: Some(target),
        };
        save(
            &home,
            &template(
                "art",
                TemplateTarget::Creative,
                vec![folder("角色/主角"), folder("场景")],
            ),
        )
        .unwrap();
        // Reserved studio names are refused for creative templates only.
        assert!(save(
            &home,
            &template("bad", TemplateTarget::Creative, vec![folder("未分类")])
        )
        .is_err());

        let laid = apply_creative_template(&f.db, &f.group, &home, "art").unwrap();
        assert_eq!(laid, ["场景", "角色", "角色/主角"]);
        let base = storage(&f.db, &f.group).unwrap().base;
        assert!(base.join("角色/主角").is_dir());
        let listed: Vec<String> = list_categories(&f.db, &f.group)
            .unwrap()
            .into_iter()
            .map(|category| category.path)
            .collect();
        assert!(listed.contains(&"角色/主角".to_string()));

        // Never over existing content, and resource templates do not apply.
        assert!(apply_creative_template(&f.db, &f.group, &home, "art")
            .unwrap_err()
            .to_string()
            .contains("already has content"));
        assert!(apply_creative_template(&f.db, &f.group, &home, "software").is_err());
        assert!(apply_creative_template(&f.db, &f.group, &home, "../x").is_err());
    }

    #[test]
    fn a_project_that_never_chose_keeps_the_default() {
        let f = fixture();
        let mut reordered = f.group.clone();
        reordered.roots.reverse();
        // Default: the first workspace, whatever the order.
        assert_eq!(storage(&f.db, &reordered).unwrap().kind, "workspace");
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
