//! mc-agent: the prototype canvas (docs/mc-agent/prototype-canvas.md, tier A).
//!
//! The agent draws prototypes on it as HTML artboards; the user looks, tries
//! them and comments. A canvas belongs to a project and is a folder of plain
//! files in the app's data folder, outside the user's repository:
//!
//! ```text
//! <data dir>/canvas/<project id>/<canvas id>/
//!   canvas.json            elements, back to front, and a version number
//!   comments.json          comment threads
//!   frames/<board id>.html one HTML fragment per artboard
//!   frames/<board id>.prev.html   the artboard before the agent's last change
//! ```
//!
//! Layout changes are batches of element operations pinned to the version
//! they were made against; a batch made against an older version is refused
//! so the agent and the user never overwrite each other silently. Comments
//! are appended one at a time and need no version.
//!
//! No database table: the canvas list is the folder listing.

mod comments;
pub mod html;

pub use comments::*;

use anyhow::{anyhow, Context, Result};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use crate::db::{now_ms, Database, ProjectGroupRecord};

/// The canvas folder inside the data folder.
pub const CANVAS_DIR: &str = "canvas";
const INDEX_FILE: &str = "canvas.json";
const COMMENTS_FILE: &str = "comments.json";
const FRAMES_DIR: &str = "frames";
const FORMAT: u32 = 1;

const MAX_ELEMENTS: usize = 300;
const MAX_OPS: usize = 100;
const MAX_TITLE: usize = 200;
const MAX_NOTE: usize = 4_000;
const MAX_COORD: f64 = 1_000_000.0;
const MAX_THREADS: usize = 500;
const MAX_MESSAGES: usize = 200;
const MAX_COMMENT: usize = 4_000;
pub const NOTE_COLORS: &[&str] = &[
    "yellow", "blue", "green", "pink", "purple", "orange", "gray",
];

/// Writes to one canvas happen one at a time across every caller.
static CANVAS_LOCK: Mutex<()> = Mutex::new(());

fn lock() -> std::sync::MutexGuard<'static, ()> {
    CANVAS_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

// ---- records ----------------------------------------------------------------

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ElementKind {
    Frame,
    Note,
    Title,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Element {
    pub id: String,
    #[serde(rename = "type")]
    pub kind: ElementKind,
    pub x: f64,
    pub y: f64,
    pub w: f64,
    /// 0 for a note or title that grows with its text.
    #[serde(default)]
    pub h: f64,
    /// A frame's name strip.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub title: String,
    /// A note's or title's text.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub text: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
    /// The frame a note is attached to.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub board_id: Option<String>,
    /// A frame's HTML revision, raised on every change of its source.
    #[serde(default)]
    pub rev: u64,
    /// Whether `<id>.prev.html` holds the version before the last change.
    #[serde(default)]
    pub has_prev: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Canvas {
    pub v: u32,
    pub id: String,
    pub title: String,
    pub version: u64,
    pub created_at: i64,
    pub updated_at: i64,
    /// Back to front.
    pub elements: Vec<Element>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CanvasSummary {
    pub id: String,
    pub title: String,
    pub version: u64,
    pub updated_at: i64,
    pub boards: usize,
    pub path: PathBuf,
}

/// An element as an operation describes it; missing ids are generated.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ElementInput {
    #[serde(default)]
    pub id: Option<String>,
    #[serde(rename = "type")]
    pub kind: Option<ElementKind>,
    pub x: Option<f64>,
    pub y: Option<f64>,
    pub w: Option<f64>,
    pub h: Option<f64>,
    pub title: Option<String>,
    pub text: Option<String>,
    /// Empty clears it.
    pub color: Option<String>,
    /// Empty detaches the note.
    pub board_id: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "op", rename_all = "camelCase", deny_unknown_fields)]
pub enum Op {
    /// A new element; a frame needs `html`.
    Add {
        element: ElementInput,
        #[serde(default)]
        html: Option<String>,
    },
    /// Change fields of an element and, for a frame, its source.
    Update {
        id: String,
        #[serde(default)]
        set: ElementInput,
        #[serde(default)]
        html: Option<String>,
    },
    Remove {
        id: String,
    },
    /// Swap a frame's source with the version before its last change.
    Restore {
        id: String,
    },
    /// Bring to the front or send to the back.
    Reorder {
        id: String,
        to: Layer,
    },
}

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Layer {
    Front,
    Back,
}

/// Who changes a frame's source: only the agent's changes keep the previous
/// version, since the user's own edits are undone in the editor.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Actor {
    User,
    Agent { session_id: String },
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Applied {
    pub canvas: Canvas,
    /// The id of each element an `add` created, in operation order.
    pub added: Vec<String>,
    pub warnings: Vec<String>,
}

// ---- paths ------------------------------------------------------------------

fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 40
        && id.chars().next().is_some_and(|c| c.is_ascii_alphanumeric())
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

fn check_id(kind: &str, id: &str) -> Result<()> {
    if valid_id(id) {
        Ok(())
    } else {
        Err(anyhow!(
            "INVALID_ARGUMENT: {kind} id {id:?}: use 1 to 40 letters, digits, - or _, starting with a letter or digit"
        ))
    }
}

fn short_id(prefix: &str) -> String {
    let raw = uuid::Uuid::new_v4().simple().to_string();
    format!("{prefix}{}", &raw[..10])
}

/// `<data dir>/canvas/<project>/`. A project whose id is not a plain name
/// (a folder-only project's is `legacy:<path>`) gets a digest of it instead.
pub fn canvas_root(db: &Database, group: &ProjectGroupRecord) -> Result<PathBuf> {
    let folder = if valid_id(&group.id) {
        group.id.clone()
    } else {
        use sha2::{Digest, Sha256};
        format!(
            "p-{}",
            &hex::encode(Sha256::digest(group.id.as_bytes()))[..32]
        )
    };
    Ok(db.data_dir().join(CANVAS_DIR).join(folder))
}

fn canvas_dir(db: &Database, group: &ProjectGroupRecord, id: &str) -> Result<PathBuf> {
    check_id("canvas", id)?;
    let dir = canvas_root(db, group)?.join(id);
    if !dir.join(INDEX_FILE).is_file() {
        return Err(anyhow!("NOT_FOUND: canvas not found: {id}"));
    }
    Ok(dir)
}

fn frame_path(dir: &Path, board: &str) -> PathBuf {
    dir.join(FRAMES_DIR).join(format!("{board}.html"))
}

fn prev_path(dir: &Path, board: &str) -> PathBuf {
    dir.join(FRAMES_DIR).join(format!("{board}.prev.html"))
}

/// Write through a temporary file and a rename, so a crash never leaves half
/// a file behind.
fn write_atomic(path: &Path, bytes: &[u8]) -> Result<()> {
    let parent = path
        .parent()
        .ok_or_else(|| anyhow!("no parent folder for {}", path.display()))?;
    fs::create_dir_all(parent).with_context(|| format!("create {}", parent.display()))?;
    let temp = parent.join(format!(
        ".{}.{}.tmp",
        path.file_name()
            .map(|n| n.to_string_lossy())
            .unwrap_or_default(),
        uuid::Uuid::new_v4().simple()
    ));
    fs::write(&temp, bytes).with_context(|| format!("write {}", temp.display()))?;
    fs::rename(&temp, path).with_context(|| format!("replace {}", path.display()))?;
    Ok(())
}

fn read_canvas(dir: &Path) -> Result<Canvas> {
    let raw = fs::read_to_string(dir.join(INDEX_FILE))
        .with_context(|| format!("read {}", dir.join(INDEX_FILE).display()))?;
    serde_json::from_str(&raw).map_err(|error| {
        anyhow!(
            "PRECONDITION: {} is not a readable canvas ({error}); fix or remove the file",
            dir.join(INDEX_FILE).display()
        )
    })
}

fn write_canvas(dir: &Path, canvas: &Canvas) -> Result<()> {
    write_atomic(&dir.join(INDEX_FILE), &serde_json::to_vec_pretty(canvas)?)
}

// ---- canvases ---------------------------------------------------------------

pub fn list(db: &Database, group: &ProjectGroupRecord) -> Result<Vec<CanvasSummary>> {
    let root = canvas_root(db, group)?;
    let Ok(entries) = fs::read_dir(&root) else {
        return Ok(Vec::new());
    };
    let mut out = Vec::new();
    for entry in entries.flatten() {
        let dir = entry.path();
        let name = entry.file_name().to_string_lossy().into_owned();
        if !valid_id(&name) || !dir.join(INDEX_FILE).is_file() {
            continue;
        }
        // A canvas file someone broke by hand is left out, not fatal.
        let Ok(canvas) = read_canvas(&dir) else {
            continue;
        };
        out.push(CanvasSummary {
            boards: canvas
                .elements
                .iter()
                .filter(|element| element.kind == ElementKind::Frame)
                .count(),
            id: name,
            title: canvas.title,
            version: canvas.version,
            updated_at: canvas.updated_at,
            path: dir,
        });
    }
    out.sort_by(|a, b| b.updated_at.cmp(&a.updated_at).then(a.id.cmp(&b.id)));
    Ok(out)
}

fn clean_title(raw: &str) -> Result<String> {
    let title = raw.trim();
    if title.is_empty() {
        return Err(anyhow!("INVALID_ARGUMENT: a canvas needs a title"));
    }
    Ok(title.chars().take(MAX_TITLE).collect())
}

pub fn create(db: &Database, group: &ProjectGroupRecord, title: &str) -> Result<Canvas> {
    let title = clean_title(title)?;
    let _guard = lock();
    let root = canvas_root(db, group)?;
    let id = short_id("c");
    let dir = root.join(&id);
    let now = now_ms();
    let canvas = Canvas {
        v: FORMAT,
        id,
        title,
        version: 1,
        created_at: now,
        updated_at: now,
        elements: Vec::new(),
    };
    fs::create_dir_all(dir.join(FRAMES_DIR))
        .with_context(|| format!("create {}", dir.display()))?;
    write_canvas(&dir, &canvas)?;
    Ok(canvas)
}

pub fn get(db: &Database, group: &ProjectGroupRecord, id: &str) -> Result<Canvas> {
    read_canvas(&canvas_dir(db, group, id)?)
}

/// The sources of some (or all) frames, for the agent to read.
pub fn board_sources(
    db: &Database,
    group: &ProjectGroupRecord,
    id: &str,
    boards: Option<&[String]>,
) -> Result<BTreeMap<String, String>> {
    let dir = canvas_dir(db, group, id)?;
    let canvas = read_canvas(&dir)?;
    let mut out = BTreeMap::new();
    for element in canvas
        .elements
        .iter()
        .filter(|element| element.kind == ElementKind::Frame)
    {
        if boards.is_some_and(|wanted| !wanted.contains(&element.id)) {
            continue;
        }
        let source = fs::read_to_string(frame_path(&dir, &element.id)).unwrap_or_default();
        out.insert(element.id.clone(), source);
    }
    if let Some(wanted) = boards {
        if let Some(missing) = wanted.iter().find(|board| !out.contains_key(*board)) {
            return Err(anyhow!("NOT_FOUND: no artboard {missing} on this canvas"));
        }
    }
    Ok(out)
}

pub fn rename(db: &Database, group: &ProjectGroupRecord, id: &str, title: &str) -> Result<Canvas> {
    let title = clean_title(title)?;
    let _guard = lock();
    let dir = canvas_dir(db, group, id)?;
    let mut canvas = read_canvas(&dir)?;
    canvas.title = title;
    canvas.version += 1;
    canvas.updated_at = now_ms();
    write_canvas(&dir, &canvas)?;
    Ok(canvas)
}

/// Delete the canvas folder: its index, artboards and comments. The images it
/// shows stay in the library.
pub fn delete(db: &Database, group: &ProjectGroupRecord, id: &str) -> Result<()> {
    let _guard = lock();
    let dir = canvas_dir(db, group, id)?;
    let root = canvas_root(db, group)?;
    // Never follow a link out of the canvas folder.
    let real = dir.canonicalize()?;
    if !real.starts_with(root.canonicalize()?)
        || fs::symlink_metadata(&dir)?.file_type().is_symlink()
    {
        return Err(anyhow!(
            "PERMISSION_DENIED: the canvas folder is not inside creative/canvas"
        ));
    }
    fs::remove_dir_all(&real).with_context(|| format!("delete {}", real.display()))?;
    Ok(())
}

// ---- operations -------------------------------------------------------------

fn finite(value: f64, label: &str, min: f64, max: f64) -> Result<f64> {
    if value.is_finite() && value >= min && value <= max {
        Ok(value.round())
    } else {
        Err(anyhow!(
            "INVALID_ARGUMENT: {label} must be between {min} and {max}"
        ))
    }
}

fn limits(kind: ElementKind) -> (f64, f64) {
    match kind {
        ElementKind::Frame => (40.0, 8000.0),
        ElementKind::Note => (80.0, 1200.0),
        ElementKind::Title => (80.0, 8000.0),
    }
}

/// Validate and apply one element's fields onto `element`.
fn set_fields(element: &mut Element, input: &ElementInput, frames: &HashSet<String>) -> Result<()> {
    let kind = element.kind;
    if let Some(x) = input.x {
        element.x = finite(x, "x", -MAX_COORD, MAX_COORD)?;
    }
    if let Some(y) = input.y {
        element.y = finite(y, "y", -MAX_COORD, MAX_COORD)?;
    }
    let (min, max) = limits(kind);
    if let Some(w) = input.w {
        element.w = finite(w, "w", min, max)?;
    }
    if let Some(h) = input.h {
        element.h = match kind {
            // Notes and titles may grow with their text.
            ElementKind::Note | ElementKind::Title if h == 0.0 => 0.0,
            _ => finite(h, "h", min.min(40.0), max)?,
        };
    }
    if let Some(title) = &input.title {
        element.title = title.trim().chars().take(MAX_TITLE).collect();
    }
    if let Some(text) = &input.text {
        let limit = if kind == ElementKind::Title {
            MAX_TITLE
        } else {
            MAX_NOTE
        };
        if text.chars().count() > limit {
            return Err(anyhow!(
                "INVALID_ARGUMENT: text is longer than {limit} characters"
            ));
        }
        element.text = text.trim_end().to_string();
    }
    if let Some(color) = &input.color {
        element.color = match color.trim() {
            "" => None,
            color if NOTE_COLORS.contains(&color) => Some(color.to_string()),
            color => {
                return Err(anyhow!(
                    "INVALID_ARGUMENT: color {color:?}: one of {}",
                    NOTE_COLORS.join(", ")
                ))
            }
        };
    }
    if let Some(board) = &input.board_id {
        if kind != ElementKind::Note {
            return Err(anyhow!(
                "INVALID_ARGUMENT: only a note attaches to an artboard"
            ));
        }
        element.board_id = match board.trim() {
            "" => None,
            board if frames.contains(board) => Some(board.to_string()),
            board => return Err(anyhow!("NOT_FOUND: no artboard {board} on this canvas")),
        };
    }
    Ok(())
}

enum FileChange {
    Write {
        board: String,
        html: String,
        keep_prev: bool,
    },
    Restore {
        board: String,
    },
    Remove {
        board: String,
    },
}

/// Apply a batch of operations made against `base_version`. Everything is
/// checked before any file changes; a stale version is refused with the
/// current one so the caller re-reads.
pub fn apply(
    db: &Database,
    group: &ProjectGroupRecord,
    id: &str,
    base_version: u64,
    ops: &[Op],
    actor: &Actor,
) -> Result<Applied> {
    if ops.is_empty() {
        return Err(anyhow!("INVALID_ARGUMENT: no operations"));
    }
    if ops.len() > MAX_OPS {
        return Err(anyhow!(
            "INVALID_ARGUMENT: at most {MAX_OPS} operations at once"
        ));
    }
    let _guard = lock();
    let dir = canvas_dir(db, group, id)?;
    let mut canvas = read_canvas(&dir)?;
    if canvas.version != base_version {
        return Err(anyhow!(
            "CONFLICT: the canvas changed (version {} now, {} given); read it again and redo the change on the current version",
            canvas.version,
            base_version
        ));
    }
    let mut frames: HashSet<String> = canvas
        .elements
        .iter()
        .filter(|element| element.kind == ElementKind::Frame)
        .map(|element| element.id.clone())
        .collect();
    let mut changes: Vec<FileChange> = Vec::new();
    let mut added = Vec::new();
    let mut warnings = Vec::new();
    let keep_prev = matches!(actor, Actor::Agent { .. });
    let position = |canvas: &Canvas, id: &str| {
        canvas
            .elements
            .iter()
            .position(|element| element.id == id)
            .ok_or_else(|| anyhow!("NOT_FOUND: no element {id} on this canvas"))
    };
    for (index, op) in ops.iter().enumerate() {
        let context = |error: anyhow::Error| anyhow!("{error:#} (operation {})", index + 1);
        match op {
            Op::Add {
                element: input,
                html,
            } => (|| -> Result<()> {
                let kind = input
                    .kind
                    .ok_or_else(|| anyhow!("INVALID_ARGUMENT: an added element needs a type"))?;
                let element_id = match &input.id {
                    Some(given) => {
                        check_id("element", given)?;
                        given.clone()
                    }
                    None => short_id(match kind {
                        ElementKind::Frame => "b",
                        ElementKind::Note => "n",
                        ElementKind::Title => "t",
                    }),
                };
                if canvas
                    .elements
                    .iter()
                    .any(|element| element.id == element_id)
                {
                    return Err(anyhow!("CONFLICT: element {element_id} already exists"));
                }
                if canvas.elements.len() >= MAX_ELEMENTS {
                    return Err(anyhow!(
                        "INVALID_ARGUMENT: a canvas holds at most {MAX_ELEMENTS} elements"
                    ));
                }
                let (min, _) = limits(kind);
                let mut element = Element {
                    id: element_id.clone(),
                    kind,
                    x: 0.0,
                    y: 0.0,
                    w: if kind == ElementKind::Note {
                        240.0
                    } else {
                        min.max(320.0)
                    },
                    h: match kind {
                        ElementKind::Note | ElementKind::Title => 0.0,
                        _ => 240.0,
                    },
                    title: String::new(),
                    text: String::new(),
                    color: (kind == ElementKind::Note).then(|| "yellow".to_string()),
                    board_id: None,
                    rev: 0,
                    has_prev: false,
                };
                set_fields(&mut element, input, &frames)?;
                match kind {
                    ElementKind::Frame => {
                        let html = html
                            .as_deref()
                            .ok_or_else(|| anyhow!("INVALID_ARGUMENT: an artboard needs html"))?;
                        let (_, checked) = html::check(html).map_err(|problem| {
                            anyhow!("INVALID_ARGUMENT: artboard {element_id}: {problem}")
                        })?;
                        warnings.extend(
                            checked
                                .warnings
                                .into_iter()
                                .map(|w| format!("{element_id}: {w}")),
                        );
                        element.rev = 1;
                        frames.insert(element_id.clone());
                        changes.push(FileChange::Write {
                            board: element_id.clone(),
                            html: html.to_string(),
                            keep_prev: false,
                        });
                    }
                    _ if html.is_some() => {
                        return Err(anyhow!("INVALID_ARGUMENT: only an artboard has html"))
                    }
                    _ => {}
                }
                canvas.elements.push(element);
                added.push(element_id);
                Ok(())
            })()
            .map_err(context)?,
            Op::Update {
                id: target,
                set,
                html,
            } => (|| -> Result<()> {
                if set.id.is_some() || set.kind.is_some() {
                    return Err(anyhow!(
                        "INVALID_ARGUMENT: an element's id and type cannot change"
                    ));
                }
                let at = position(&canvas, target)?;
                let mut element = canvas.elements[at].clone();
                set_fields(&mut element, set, &frames)?;
                if let Some(html) = html {
                    if element.kind != ElementKind::Frame {
                        return Err(anyhow!("INVALID_ARGUMENT: only an artboard has html"));
                    }
                    let (_, checked) = html::check(html).map_err(|problem| {
                        anyhow!("INVALID_ARGUMENT: artboard {target}: {problem}")
                    })?;
                    warnings.extend(
                        checked
                            .warnings
                            .into_iter()
                            .map(|w| format!("{target}: {w}")),
                    );
                    element.rev += 1;
                    if keep_prev {
                        element.has_prev = true;
                    }
                    changes.push(FileChange::Write {
                        board: target.clone(),
                        html: html.clone(),
                        keep_prev,
                    });
                }
                canvas.elements[at] = element;
                Ok(())
            })()
            .map_err(context)?,
            Op::Remove { id: target } => {
                let at = position(&canvas, target).map_err(context)?;
                let removed = canvas.elements.remove(at);
                if removed.kind == ElementKind::Frame {
                    frames.remove(target);
                    // Notes on it stay where they are, no longer attached.
                    for element in &mut canvas.elements {
                        if element.board_id.as_deref() == Some(target.as_str()) {
                            element.board_id = None;
                        }
                    }
                    changes.push(FileChange::Remove {
                        board: target.clone(),
                    });
                }
            }
            Op::Restore { id: target } => {
                let at = position(&canvas, target).map_err(context)?;
                let element = &mut canvas.elements[at];
                if element.kind != ElementKind::Frame || !element.has_prev {
                    return Err(context(anyhow!(
                        "PRECONDITION: artboard {target} has no previous version"
                    )));
                }
                element.rev += 1;
                changes.push(FileChange::Restore {
                    board: target.clone(),
                });
            }
            Op::Reorder { id: target, to } => {
                let at = position(&canvas, target).map_err(context)?;
                let element = canvas.elements.remove(at);
                match to {
                    Layer::Front => canvas.elements.push(element),
                    Layer::Back => canvas.elements.insert(0, element),
                }
            }
        }
    }
    // Files first, then the index that points at them.
    for change in changes {
        match change {
            FileChange::Write {
                board,
                html,
                keep_prev,
            } => {
                let path = frame_path(&dir, &board);
                if keep_prev && path.is_file() {
                    fs::copy(&path, prev_path(&dir, &board))
                        .with_context(|| format!("keep the previous version of {board}"))?;
                }
                write_atomic(&path, html.as_bytes())?;
            }
            FileChange::Restore { board } => {
                let current = frame_path(&dir, &board);
                let previous = prev_path(&dir, &board);
                let now = fs::read(&current).unwrap_or_default();
                let before = fs::read(&previous)
                    .with_context(|| format!("read the previous version of {board}"))?;
                // Swapped, so restoring again brings the newer version back.
                write_atomic(&current, &before)?;
                write_atomic(&previous, &now)?;
            }
            FileChange::Remove { board } => {
                for path in [frame_path(&dir, &board), prev_path(&dir, &board)] {
                    match fs::remove_file(&path) {
                        Ok(()) => {}
                        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                        Err(error) => {
                            return Err(error).with_context(|| format!("delete {}", path.display()))
                        }
                    }
                }
            }
        }
    }
    if matches!(actor, Actor::Agent { .. }) {
        clear_titles(&mut canvas, &mut warnings);
    }
    canvas.version += 1;
    canvas.updated_at = now_ms();
    write_canvas(&dir, &canvas)?;
    Ok(Applied {
        canvas,
        added,
        warnings,
    })
}

/// The room a title needs above its row: its own line and the artboards'
/// name strips.
const TITLE_CLEARANCE: f64 = 110.0;

/// Move each title up out of the artboards it sits on or just above, so the
/// agent's layout never covers a name strip. Says so in the warnings.
fn clear_titles(canvas: &mut Canvas, warnings: &mut Vec<String>) {
    let frames: Vec<(f64, f64, f64)> = canvas
        .elements
        .iter()
        .filter(|element| element.kind == ElementKind::Frame)
        .map(|element| (element.x, element.x + element.w, element.y))
        .collect();
    for title in canvas
        .elements
        .iter_mut()
        .filter(|element| element.kind == ElementKind::Title)
    {
        let (left, right) = (title.x, title.x + title.w.max(1.0));
        let top = frames
            .iter()
            .filter(|(x0, x1, y)| {
                *x0 < right && left < *x1 && *y > title.y - 40.0 && *y < title.y + TITLE_CLEARANCE
            })
            .map(|(_, _, y)| *y)
            .fold(f64::INFINITY, f64::min);
        if top.is_finite() {
            title.y = top - TITLE_CLEARANCE;
            warnings.push(format!(
                "{}: moved up to y={} so it does not cover the artboards' names; put titles {TITLE_CLEARANCE} px above their row",
                title.id, title.y
            ));
        }
    }
}

// ---- serving and element addresses -------------------------------------------

fn frame_source(dir: &Path, canvas: &Canvas, board: &str) -> Result<(String, u64)> {
    let element = canvas
        .elements
        .iter()
        .find(|element| element.id == board && element.kind == ElementKind::Frame)
        .ok_or_else(|| anyhow!("NOT_FOUND: no artboard {board} on this canvas"))?;
    let path = frame_path(dir, board);
    // An artboard is a file the canvas wrote; a link elsewhere is not served.
    if fs::symlink_metadata(&path).is_ok_and(|meta| !meta.is_file()) {
        return Err(anyhow!(
            "PERMISSION_DENIED: artboard {board} is not a plain file"
        ));
    }
    let source = fs::read_to_string(&path).with_context(|| format!("read artboard {board}"))?;
    Ok((source, element.rev))
}

/// An artboard as the frame shows it: every element numbered.
pub fn board_document(
    db: &Database,
    group: &ProjectGroupRecord,
    id: &str,
    board: &str,
) -> Result<(String, u64)> {
    let dir = canvas_dir(db, group, id)?;
    let canvas = read_canvas(&dir)?;
    let (source, rev) = frame_source(&dir, &canvas, board)?;
    // A file edited by hand may no longer read strictly; it is still shown,
    // just without element numbers.
    let served = match html::parse(&source) {
        Ok(parsed) => html::annotate(&source, &parsed),
        Err(_) => source,
    };
    Ok((served, rev))
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct NodeInfo {
    pub board_id: String,
    /// `<board>#<n>:<path>`.
    pub address: String,
    pub tid: usize,
    pub path: Vec<usize>,
    pub mc_id: Option<String>,
    pub label: Option<String>,
    pub kind: &'static str,
    pub tag: String,
    pub rev: u64,
}

fn node_info(board: &str, rev: u64, node: &html::Node) -> NodeInfo {
    NodeInfo {
        board_id: board.to_string(),
        address: format!("{board}#{}:{}", node.tid, node.path_string()),
        tid: node.tid,
        path: node.path.clone(),
        mc_id: node.mc_id.clone(),
        label: node.label(),
        kind: node.kind(),
        tag: node.tag.clone(),
        rev,
    }
}

/// What the frame's element number `tid` is in the source. The frame only
/// sends the number; the address and label come from here.
pub fn resolve_node(
    db: &Database,
    group: &ProjectGroupRecord,
    id: &str,
    board: &str,
    tid: usize,
) -> Result<NodeInfo> {
    let dir = canvas_dir(db, group, id)?;
    let canvas = read_canvas(&dir)?;
    let (source, rev) = frame_source(&dir, &canvas, board)?;
    let parsed = html::parse(&source).map_err(|error| {
        anyhow!("PRECONDITION: artboard {board} no longer reads strictly: {error}")
    })?;
    let node = parsed
        .addressable(tid)
        .ok_or_else(|| anyhow!("NOT_FOUND: artboard {board} has no element {tid}"))?;
    Ok(node_info(board, rev, node))
}

#[cfg(test)]
mod tests;
