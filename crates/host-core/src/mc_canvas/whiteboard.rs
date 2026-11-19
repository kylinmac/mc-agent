//! mc-agent: Excalidraw whiteboard storage (`kind: "whiteboard"`, MC-ADR-0030 / R38)
//! and session-scoped canvas directory lifecycle for temporary conversations.

use anyhow::{anyhow, Context, Result};
use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, HashSet};
use std::fs;
use std::path::Path;

use super::{
    canvas_dir, clean_title, lock, read_canvas, short_id, write_atomic, write_canvas, Canvas,
    CANVAS_DIR, FORMAT, FRAMES_DIR,
};
use crate::db::{now_ms, Database, ProjectGroupRecord};

const WHITEBOARD_FILE: &str = "whiteboard.json";
const FILES_DIR: &str = "files";
const PREVIEW_FILE: &str = "preview.png";

const MAX_WHITEBOARD_ELEMENTS: usize = 2_000;
const MAX_SCENE_BYTES: usize = 4 * 1024 * 1024;
const MAX_FILES_PER_BOARD: usize = 80;
const MAX_DATA_URL_BYTES: usize = 12 * 1024 * 1024;
const MAX_PREVIEW_BYTES: usize = 6 * 1024 * 1024;
const PNG_MAGIC: &[u8; 8] = b"\x89PNG\r\n\x1a\n";

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum CanvasKind {
    #[default]
    Prototype,
    Whiteboard,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WhiteboardScene {
    #[serde(default)]
    pub elements: Vec<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub app_state: Option<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WhiteboardBinaryFile {
    pub id: String,
    pub mime_type: String,
    #[serde(rename = "dataURL")]
    pub data_url: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub created: Option<i64>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WhiteboardLoaded {
    pub canvas: Canvas,
    pub scene: WhiteboardScene,
    pub files: Option<BTreeMap<String, WhiteboardBinaryFile>>,
    pub has_preview: bool,
}

fn valid_file_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 80
        && id.chars().next().is_some_and(|c| c.is_ascii_alphanumeric())
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

fn check_file_id(id: &str) -> Result<()> {
    if valid_file_id(id) {
        Ok(())
    } else {
        Err(anyhow!(
            "INVALID_ARGUMENT: whiteboard file id {id:?} must be 1..=80 ASCII letters, digits, - or _"
        ))
    }
}

/// Synthetic `ProjectGroupRecord` for a temporary conversation outside any project (`session:<id>`).
pub fn session_group_record(session_id: &str) -> Result<ProjectGroupRecord> {
    let clean = session_id.trim();
    if clean.is_empty()
        || clean.len() > 128
        || clean
            .chars()
            .any(|c| c.is_control() || c == '/' || c == '\\')
    {
        return Err(anyhow!("INVALID_ARGUMENT: invalid session id for canvas"));
    }
    Ok(ProjectGroupRecord {
        id: format!("session:{clean}"),
        name: "Session".to_string(),
        primary_path: String::new(),
        roots: Vec::new(),
        created_at: 0,
        updated_at: 0,
        pinned: false,
        last_opened_at: 0,
        legacy: false,
        detached_paths: Vec::new(),
        remote: None,
    })
}

/// Best-effort cleanup of `<data dir>/canvas/p-<sha256("session:<id>")[..32]>` when a session is deleted.
pub fn remove_session_canvases(data_dir: &Path, session_id: &str) {
    let clean = session_id.trim();
    if clean.is_empty() {
        return;
    }
    let key = format!("session:{clean}");
    let folder = format!("p-{}", &hex::encode(Sha256::digest(key.as_bytes()))[..32]);
    let target = data_dir.join(CANVAS_DIR).join(folder);
    let _guard = lock();
    let Ok(meta) = fs::symlink_metadata(&target) else {
        return;
    };
    if meta.file_type().is_symlink() || !meta.is_dir() {
        return;
    }
    let _ = fs::remove_dir_all(&target);
}

pub fn create_with_kind(
    db: &Database,
    group: &ProjectGroupRecord,
    title: &str,
    kind: CanvasKind,
) -> Result<Canvas> {
    let title = clean_title(title)?;
    let _guard = lock();
    let root = super::canvas_root(db, group)?;
    let id = short_id(match kind {
        CanvasKind::Prototype => "c",
        CanvasKind::Whiteboard => "w",
    });
    let dir = root.join(&id);
    let now = now_ms();
    let canvas = Canvas {
        v: FORMAT,
        id,
        title,
        kind,
        version: 1,
        created_at: now,
        updated_at: now,
        elements: Vec::new(),
    };
    match kind {
        CanvasKind::Prototype => {
            fs::create_dir_all(dir.join(FRAMES_DIR))
                .with_context(|| format!("create {}", dir.display()))?;
        }
        CanvasKind::Whiteboard => {
            fs::create_dir_all(dir.join(FILES_DIR))
                .with_context(|| format!("create {}", dir.display()))?;
            let empty_scene = WhiteboardScene::default();
            write_atomic(
                &dir.join(WHITEBOARD_FILE),
                &serde_json::to_vec_pretty(&empty_scene)?,
            )?;
        }
    }
    write_canvas(&dir, &canvas)?;
    Ok(canvas)
}

fn read_scene(dir: &Path) -> Result<WhiteboardScene> {
    let path = dir.join(WHITEBOARD_FILE);
    if !path.exists() {
        return Ok(WhiteboardScene::default());
    }
    if fs::symlink_metadata(&path).is_ok_and(|m| !m.is_file()) {
        return Err(anyhow!(
            "PERMISSION_DENIED: whiteboard scene is not a plain file"
        ));
    }
    let raw = fs::read_to_string(&path).with_context(|| format!("read {}", path.display()))?;
    serde_json::from_str(&raw).map_err(|error| {
        anyhow!(
            "PRECONDITION: {} is not a readable whiteboard scene ({error})",
            path.display()
        )
    })
}

fn read_files(dir: &Path) -> Result<BTreeMap<String, WhiteboardBinaryFile>> {
    let files_dir = dir.join(FILES_DIR);
    let Ok(entries) = fs::read_dir(&files_dir) else {
        return Ok(BTreeMap::new());
    };
    let mut out = BTreeMap::new();
    for entry in entries.flatten() {
        let path = entry.path();
        let Ok(meta) = fs::symlink_metadata(&path) else {
            continue;
        };
        if !meta.is_file() {
            continue;
        }
        let Some(stem) = path.file_stem().and_then(|s| s.to_str()) else {
            continue;
        };
        if path.extension().and_then(|e| e.to_str()) != Some("json") || !valid_file_id(stem) {
            continue;
        }
        if let Ok(raw) = fs::read_to_string(&path) {
            if let Ok(parsed) = serde_json::from_str::<WhiteboardBinaryFile>(&raw) {
                out.insert(parsed.id.clone(), parsed);
            }
        }
    }
    Ok(out)
}

pub fn whiteboard_get(
    db: &Database,
    group: &ProjectGroupRecord,
    id: &str,
    include_files: bool,
) -> Result<WhiteboardLoaded> {
    let dir = canvas_dir(db, group, id)?;
    let canvas = read_canvas(&dir)?;
    if canvas.kind != CanvasKind::Whiteboard {
        return Err(anyhow!(
            "INVALID_ARGUMENT: canvas {id} is a prototype canvas, not a whiteboard"
        ));
    }
    let scene = read_scene(&dir)?;
    let files = if include_files {
        Some(read_files(&dir)?)
    } else {
        None
    };
    let preview_path = dir.join(PREVIEW_FILE);
    let has_preview = fs::symlink_metadata(&preview_path).is_ok_and(|m| m.is_file());
    Ok(WhiteboardLoaded {
        canvas,
        scene,
        files,
        has_preview,
    })
}

fn decode_preview_png(raw: &str) -> Result<Vec<u8>> {
    if raw.trim().is_empty() {
        return Ok(Vec::new());
    }
    let clean = raw
        .trim()
        .strip_prefix("data:image/png;base64,")
        .unwrap_or(raw.trim());
    let bytes = BASE64
        .decode(clean)
        .map_err(|e| anyhow!("INVALID_ARGUMENT: invalid preview PNG base64: {e}"))?;
    if bytes.len() > MAX_PREVIEW_BYTES {
        return Err(anyhow!(
            "INVALID_ARGUMENT: preview PNG exceeds {MAX_PREVIEW_BYTES} bytes"
        ));
    }
    if !bytes.starts_with(PNG_MAGIC) {
        return Err(anyhow!("INVALID_ARGUMENT: preview image must be a PNG"));
    }
    Ok(bytes)
}

pub fn whiteboard_save(
    db: &Database,
    group: &ProjectGroupRecord,
    id: &str,
    base_version: Option<u64>,
    scene: &WhiteboardScene,
    upserted_files: Option<&BTreeMap<String, WhiteboardBinaryFile>>,
    preview_png_base64: Option<&str>,
) -> Result<Canvas> {
    if scene.elements.len() > MAX_WHITEBOARD_ELEMENTS {
        return Err(anyhow!(
            "INVALID_ARGUMENT: whiteboard holds at most {MAX_WHITEBOARD_ELEMENTS} elements"
        ));
    }
    let referenced_files: HashSet<&str> = scene
        .elements
        .iter()
        .filter(|el| el.get("isDeleted").and_then(Value::as_bool) != Some(true))
        .filter_map(|el| el.get("fileId").and_then(Value::as_str))
        .collect();
    if referenced_files.len() > MAX_FILES_PER_BOARD {
        return Err(anyhow!(
            "INVALID_ARGUMENT: at most {MAX_FILES_PER_BOARD} embedded images per whiteboard"
        ));
    }
    let serialized_scene = serde_json::to_vec(scene)?;
    if serialized_scene.len() > MAX_SCENE_BYTES {
        return Err(anyhow!(
            "INVALID_ARGUMENT: whiteboard scene exceeds {MAX_SCENE_BYTES} bytes"
        ));
    }

    let decoded_preview = match preview_png_base64 {
        None => None,
        Some(raw) => Some(decode_preview_png(raw)?),
    };

    if let Some(files) = upserted_files {
        if files.len() > MAX_FILES_PER_BOARD {
            return Err(anyhow!(
                "INVALID_ARGUMENT: at most {MAX_FILES_PER_BOARD} embedded images per whiteboard"
            ));
        }
        for (key, file) in files {
            check_file_id(key)?;
            if file.id != *key {
                return Err(anyhow!(
                    "INVALID_ARGUMENT: whiteboard file id mismatch ({key} vs {})",
                    file.id
                ));
            }
            if !file.mime_type.starts_with("image/") {
                return Err(anyhow!(
                    "INVALID_ARGUMENT: whiteboard file {} must be an image/* mimeType",
                    file.id
                ));
            }
            if !file.data_url.starts_with("data:image/") || file.data_url.len() > MAX_DATA_URL_BYTES
            {
                return Err(anyhow!(
                    "INVALID_ARGUMENT: whiteboard file {} must be a data:image/* URL within size limit",
                    file.id
                ));
            }
        }
    }

    let _guard = lock();
    let dir = canvas_dir(db, group, id)?;
    let mut canvas = read_canvas(&dir)?;
    if canvas.kind != CanvasKind::Whiteboard {
        return Err(anyhow!(
            "INVALID_ARGUMENT: canvas {id} is a prototype canvas, not a whiteboard"
        ));
    }
    if let Some(expected) = base_version {
        if canvas.version != expected {
            return Err(anyhow!(
                "CONFLICT: the whiteboard changed (version {} now, {expected} given); read it again and redo the change",
                canvas.version
            ));
        }
    }

    let files_dir = dir.join(FILES_DIR);
    fs::create_dir_all(&files_dir).with_context(|| format!("create {}", files_dir.display()))?;

    if let Some(files) = upserted_files {
        for (file_id, file) in files {
            let target = files_dir.join(format!("{file_id}.json"));
            write_atomic(&target, &serde_json::to_vec(file)?)?;
        }
    }

    // Prune unreferenced image files when active scene no longer cites them.
    if let Ok(entries) = fs::read_dir(&files_dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if let Some(stem) = path.file_stem().and_then(|s| s.to_str()) {
                let just_upserted = upserted_files.is_some_and(|m| m.contains_key(stem));
                if !referenced_files.contains(stem) && !just_upserted {
                    let _ = fs::remove_file(&path);
                }
            }
        }
    }

    let preview_path = dir.join(PREVIEW_FILE);
    match decoded_preview {
        Some(bytes) if !bytes.is_empty() => {
            write_atomic(&preview_path, &bytes)?;
        }
        // Either caller explicitly cleared preview (`""`) OR mutated the scene
        // without rendering a new PNG (e.g. headless `CanvasWrite` / `sendBoardToWhiteboard`):
        // drop any stale `preview.png` so `CanvasRead` never sees an outdated image.
        Some(_) | None => {
            let _ = fs::remove_file(&preview_path);
        }
    }

    write_atomic(&dir.join(WHITEBOARD_FILE), &serialized_scene)?;
    canvas.version += 1;
    canvas.updated_at = now_ms();
    write_canvas(&dir, &canvas)?;
    Ok(canvas)
}

/// Write or clear `preview.png` for a specific `expected_version` WITHOUT
/// modifying `whiteboard.json` or incrementing `canvas.version`. Returns
/// `Ok(false)` when the whiteboard has already moved past `expected_version`.
pub fn whiteboard_save_preview(
    db: &Database,
    group: &ProjectGroupRecord,
    id: &str,
    expected_version: u64,
    preview_png_base64: &str,
) -> Result<bool> {
    let bytes = decode_preview_png(preview_png_base64)?;
    let _guard = lock();
    let dir = canvas_dir(db, group, id)?;
    let canvas = read_canvas(&dir)?;
    if canvas.kind != CanvasKind::Whiteboard {
        return Err(anyhow!(
            "INVALID_ARGUMENT: canvas {id} is a prototype canvas, not a whiteboard"
        ));
    }
    if canvas.version != expected_version {
        return Ok(false);
    }
    let preview_path = dir.join(PREVIEW_FILE);
    if bytes.is_empty() {
        let _ = fs::remove_file(&preview_path);
    } else {
        write_atomic(&preview_path, &bytes)?;
    }
    Ok(true)
}

pub fn whiteboard_preview(
    db: &Database,
    group: &ProjectGroupRecord,
    id: &str,
) -> Result<Option<String>> {
    let dir = canvas_dir(db, group, id)?;
    let canvas = read_canvas(&dir)?;
    if canvas.kind != CanvasKind::Whiteboard {
        return Ok(None);
    }
    let path = dir.join(PREVIEW_FILE);
    let Ok(meta) = fs::symlink_metadata(&path) else {
        return Ok(None);
    };
    if !meta.is_file() {
        return Err(anyhow!(
            "PERMISSION_DENIED: preview.png is not a plain file"
        ));
    }
    let bytes = fs::read(&path).with_context(|| format!("read {}", path.display()))?;
    if bytes.is_empty() {
        return Ok(None);
    }
    Ok(Some(BASE64.encode(bytes)))
}
