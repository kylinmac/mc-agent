//! Comment threads on a canvas, anchored to an element, a point on an
//! artboard or a point on the page; kept in `comments.json`.

use anyhow::{anyhow, Result};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::Path;

use super::*;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum AnchorKind {
    Element,
    Board,
    Canvas,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Anchor {
    pub kind: AnchorKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub board_id: Option<String>,
    /// Element anchors: what the element was when the comment was made.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub address: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mc_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rev: Option<u64>,
    /// Inside the artboard for element and board anchors, canvas coordinates
    /// for canvas anchors. An element anchor that is lost falls back here.
    pub x: f64,
    pub y: f64,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Author {
    User,
    Agent,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Message {
    pub id: String,
    pub author: Author,
    pub text: String,
    pub at: i64,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ThreadStatus {
    Open,
    Resolved,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Thread {
    pub id: String,
    pub anchor: Anchor,
    pub status: ThreadStatus,
    /// The conversation the thread was sent to; only it may answer.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_session: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
    pub messages: Vec<Message>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
struct CommentsFile {
    v: u32,
    version: u64,
    threads: Vec<Thread>,
}

/// Where an element anchor is now.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Located {
    /// `ok`: the element was found; `moved`: it is not where it was and the
    /// comment shows on its artboard instead; `boardMissing`: the artboard
    /// was removed; `canvas`/`board`: not an element anchor.
    pub state: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub node: Option<NodeInfo>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ThreadView {
    #[serde(flatten)]
    pub thread: Thread,
    pub located: Located,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Comments {
    pub version: u64,
    pub threads: Vec<ThreadView>,
}

fn read_comments(dir: &Path) -> Result<CommentsFile> {
    let path = dir.join(COMMENTS_FILE);
    match fs::read_to_string(&path) {
        Ok(raw) => serde_json::from_str(&raw).map_err(|error| {
            anyhow!(
                "PRECONDITION: {} is not readable ({error}); fix or remove the file",
                path.display()
            )
        }),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(CommentsFile {
            v: FORMAT,
            ..CommentsFile::default()
        }),
        Err(error) => Err(error).with_context(|| format!("read {}", path.display())),
    }
}

fn write_comments(dir: &Path, file: &mut CommentsFile) -> Result<()> {
    file.v = FORMAT;
    file.version += 1;
    write_atomic(&dir.join(COMMENTS_FILE), &serde_json::to_vec_pretty(file)?)
}

/// Find an element anchor again: by `data-mc-id`, else by its address when
/// the label still matches; never on a different element.
fn locate(anchor: &Anchor, boards: &BTreeMap<String, (u64, Option<html::Parsed>)>) -> Located {
    let Some(board) = anchor.board_id.as_deref() else {
        return Located {
            state: "canvas",
            node: None,
        };
    };
    let Some((rev, parsed)) = boards.get(board) else {
        return Located {
            state: "boardMissing",
            node: None,
        };
    };
    if anchor.kind == AnchorKind::Board {
        return Located {
            state: "board",
            node: None,
        };
    }
    let found = parsed.as_ref().and_then(|parsed| {
        anchor
            .mc_id
            .as_deref()
            .and_then(|id| parsed.by_mc_id(id))
            .or_else(|| {
                let (tid, path) = anchor
                    .address
                    .as_deref()
                    .and_then(|address| address.split_once('#'))
                    .and_then(|(_, rest)| html::parse_address(rest))?;
                parsed
                    .by_address(tid, &path)
                    .filter(|node| node.label() == anchor.label)
            })
    });
    match found {
        Some(node) => Located {
            state: "ok",
            node: Some(node_info(board, *rev, node)),
        },
        None => Located {
            state: "moved",
            node: None,
        },
    }
}

fn views(dir: &Path, file: CommentsFile) -> Result<Comments> {
    let canvas = read_canvas(dir)?;
    let mut boards = BTreeMap::new();
    for element in canvas
        .elements
        .iter()
        .filter(|element| element.kind == ElementKind::Frame)
    {
        let parsed = fs::read_to_string(frame_path(dir, &element.id))
            .ok()
            .and_then(|source| html::parse(&source).ok());
        boards.insert(element.id.clone(), (element.rev, parsed));
    }
    Ok(Comments {
        version: file.version,
        threads: file
            .threads
            .into_iter()
            .map(|thread| ThreadView {
                located: locate(&thread.anchor, &boards),
                thread,
            })
            .collect(),
    })
}

pub fn comments(db: &Database, group: &ProjectGroupRecord, id: &str) -> Result<Comments> {
    let dir = canvas_dir(db, group, id)?;
    views(&dir, read_comments(&dir)?)
}

/// Where a new comment goes, as the caller says it: an element by its
/// number in the served frame, a point on an artboard, or a canvas point.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AnchorInput {
    pub kind: AnchorKind,
    #[serde(default)]
    pub board_id: Option<String>,
    #[serde(default)]
    pub node: Option<usize>,
    /// For the agent: an element by its `data-mc-id` instead of a number.
    #[serde(default)]
    pub mc_id: Option<String>,
    #[serde(default)]
    pub x: f64,
    #[serde(default)]
    pub y: f64,
}

fn clean_comment(text: &str) -> Result<String> {
    let text = text.trim();
    if text.is_empty() {
        return Err(anyhow!("INVALID_ARGUMENT: the comment is empty"));
    }
    if text.chars().count() > MAX_COMMENT {
        return Err(anyhow!(
            "INVALID_ARGUMENT: a comment is at most {MAX_COMMENT} characters"
        ));
    }
    Ok(text.to_string())
}

fn resolve_anchor(dir: &Path, input: &AnchorInput) -> Result<Anchor> {
    let x = finite(input.x, "x", -MAX_COORD, MAX_COORD)?;
    let y = finite(input.y, "y", -MAX_COORD, MAX_COORD)?;
    let mut anchor = Anchor {
        kind: input.kind,
        board_id: None,
        address: None,
        mc_id: None,
        label: None,
        rev: None,
        x,
        y,
    };
    if input.kind == AnchorKind::Canvas {
        return Ok(anchor);
    }
    let board = input
        .board_id
        .as_deref()
        .ok_or_else(|| anyhow!("INVALID_ARGUMENT: the comment needs boardId"))?;
    let canvas = read_canvas(dir)?;
    let (source, rev) = frame_source(dir, &canvas, board)?;
    anchor.board_id = Some(board.to_string());
    anchor.rev = Some(rev);
    if input.kind == AnchorKind::Element {
        let parsed = html::parse(&source).map_err(|error| {
            anyhow!("PRECONDITION: artboard {board} no longer reads strictly: {error}")
        })?;
        let node = match (&input.mc_id, input.node) {
            (Some(id), _) => parsed.by_mc_id(id).ok_or_else(|| {
                anyhow!(
                    "NOT_FOUND: artboard {board} has no {} {id}",
                    html::ID_ATTRIBUTE
                )
            })?,
            (None, Some(tid)) => parsed
                .addressable(tid)
                .ok_or_else(|| anyhow!("NOT_FOUND: artboard {board} has no element {tid}"))?,
            (None, None) => {
                return Err(anyhow!(
                    "INVALID_ARGUMENT: an element comment needs node or mcId"
                ))
            }
        };
        let info = node_info(board, rev, node);
        anchor.address = Some(info.address);
        anchor.mc_id = info.mc_id;
        anchor.label = info.label;
    }
    Ok(anchor)
}

fn message(author: Author, text: String) -> Message {
    Message {
        id: short_id("m"),
        author,
        text,
        at: now_ms(),
    }
}

/// Start a thread. One the agent starts is its own to answer.
pub fn add_comment(
    db: &Database,
    group: &ProjectGroupRecord,
    id: &str,
    anchor: &AnchorInput,
    text: &str,
    actor: &Actor,
) -> Result<(String, Comments)> {
    let text = clean_comment(text)?;
    let _guard = lock();
    let dir = canvas_dir(db, group, id)?;
    let mut file = read_comments(&dir)?;
    if file.threads.len() >= MAX_THREADS {
        return Err(anyhow!(
            "INVALID_ARGUMENT: a canvas holds at most {MAX_THREADS} threads; delete resolved ones"
        ));
    }
    let anchor = resolve_anchor(&dir, anchor)?;
    let now = now_ms();
    let (author, agent_session) = match actor {
        Actor::User => (Author::User, None),
        Actor::Agent { session_id } => (Author::Agent, Some(session_id.clone())),
    };
    let thread_id = short_id("t");
    file.threads.push(Thread {
        id: thread_id.clone(),
        anchor,
        status: ThreadStatus::Open,
        agent_session,
        created_at: now,
        updated_at: now,
        messages: vec![message(author, text)],
    });
    write_comments(&dir, &mut file)?;
    Ok((thread_id, views(&dir, file)?))
}

/// Change one thread. The agent may only touch threads sent to its own
/// conversation.
fn with_thread(
    db: &Database,
    group: &ProjectGroupRecord,
    id: &str,
    thread_id: &str,
    actor: &Actor,
    change: impl FnOnce(&mut Thread) -> Result<()>,
) -> Result<Comments> {
    let _guard = lock();
    let dir = canvas_dir(db, group, id)?;
    let mut file = read_comments(&dir)?;
    let thread = file
        .threads
        .iter_mut()
        .find(|thread| thread.id == thread_id)
        .ok_or_else(|| anyhow!("NOT_FOUND: no comment thread {thread_id}"))?;
    if let Actor::Agent { session_id } = actor {
        if thread.agent_session.as_deref() != Some(session_id.as_str()) {
            return Err(anyhow!(
                "PERMISSION_DENIED: thread {thread_id} was not sent to this conversation; read it, but do not answer or resolve it"
            ));
        }
    }
    change(thread)?;
    thread.updated_at = now_ms();
    write_comments(&dir, &mut file)?;
    views(&dir, file)
}

pub fn reply(
    db: &Database,
    group: &ProjectGroupRecord,
    id: &str,
    thread_id: &str,
    text: &str,
    actor: &Actor,
) -> Result<Comments> {
    let text = clean_comment(text)?;
    let author = match actor {
        Actor::User => Author::User,
        Actor::Agent { .. } => Author::Agent,
    };
    with_thread(db, group, id, thread_id, actor, |thread| {
        if thread.messages.len() >= MAX_MESSAGES {
            return Err(anyhow!(
                "INVALID_ARGUMENT: a thread holds at most {MAX_MESSAGES} messages"
            ));
        }
        thread.messages.push(message(author, text));
        Ok(())
    })
}

pub fn set_status(
    db: &Database,
    group: &ProjectGroupRecord,
    id: &str,
    thread_id: &str,
    status: ThreadStatus,
    actor: &Actor,
) -> Result<Comments> {
    with_thread(db, group, id, thread_id, actor, |thread| {
        thread.status = status;
        Ok(())
    })
}

/// Send a thread to a conversation; later replies come from it.
pub fn assign(
    db: &Database,
    group: &ProjectGroupRecord,
    id: &str,
    thread_id: &str,
    session_id: &str,
) -> Result<Comments> {
    let session = session_id.trim();
    if session.is_empty() || session.len() > 200 {
        return Err(anyhow!("INVALID_ARGUMENT: sessionId required"));
    }
    with_thread(db, group, id, thread_id, &Actor::User, |thread| {
        thread.agent_session = Some(session.to_string());
        thread.status = ThreadStatus::Open;
        Ok(())
    })
}

pub fn delete_thread(
    db: &Database,
    group: &ProjectGroupRecord,
    id: &str,
    thread_id: &str,
) -> Result<Comments> {
    let _guard = lock();
    let dir = canvas_dir(db, group, id)?;
    let mut file = read_comments(&dir)?;
    let before = file.threads.len();
    file.threads.retain(|thread| thread.id != thread_id);
    if file.threads.len() == before {
        return Err(anyhow!("NOT_FOUND: no comment thread {thread_id}"));
    }
    write_comments(&dir, &mut file)?;
    views(&dir, file)
}
