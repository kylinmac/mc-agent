use super::display::record_to_ui_for_display;
use super::index::{dedupe_records, record_index_text};
use super::message_codec::record_to_ui;
use super::message_parents;
use super::types::{normalize_mode, SessionDetail, SessionReadOptions, SessionSummary, UiMessage};
use crate::db::{ms_to_ts, Database};
use crate::transcripts::{self};
use anyhow::Result;
use rusqlite::{params, OptionalExtension};

const SUMMARY_SELECT: &str =
    "SELECT s.id, s.title, s.last_seq, p.path, s.model_id, s.provider_id, s.mode,
            s.thinking_level, s.permission_mode, s.updated_at, s.created_at,
            EXISTS (SELECT 1 FROM task_runs r WHERE r.session_id = s.id) AS scheduled_run
     FROM sessions s LEFT JOIN projects p ON p.id = s.project_id
     WHERE s.deleted_at IS NULL";

pub(crate) fn summary_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<SessionSummary> {
    Ok(SessionSummary {
        id: row.get(0)?,
        title: row.get(1)?,
        message_count: row.get(2)?,
        project_path: row.get(3)?,
        model_id: row.get(4)?,
        provider_id: row.get(5)?,
        mode: row.get(6)?,
        thinking_level: row.get(7)?,
        permission_mode: row.get(8)?,
        updated_at: ms_to_ts(row.get(9)?),
        created_at: ms_to_ts(row.get(10)?),
        // Read by name: search and listing build their own column lists, so the
        // alias keeps this mapper independent of any one query's column order.
        scheduled_run: row.get("scheduled_run")?,
        worktree: None,
    })
}

/// Attach isolated-worktree badges. Sessions without a worktree are untouched.
fn attach_worktrees(db: &Database, summaries: &mut [SessionSummary]) -> Result<()> {
    let mut worktrees = crate::session_worktrees::lifecycle::summaries(db)?;
    if worktrees.is_empty() {
        return Ok(());
    }
    for summary in summaries {
        summary.worktree = worktrees.remove(&summary.id);
    }
    Ok(())
}

// ---- sessions ---------------------------------------------------------------

pub fn list_sessions(db: &Database) -> Result<Vec<SessionSummary>> {
    let sql = format!("{SUMMARY_SELECT} ORDER BY s.updated_at DESC");
    let mut stmt = db.conn().prepare_cached(&sql)?;
    let rows = stmt.query_map([], summary_from_row)?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row?);
    }
    attach_worktrees(db, &mut out)?;
    Ok(out)
}

/// The persisted per-session permission mode, or None for unknown sessions.
pub fn session_permission_mode(db: &Database, id: &str) -> Result<Option<String>> {
    Ok(db
        .conn()
        .prepare_cached("SELECT permission_mode FROM sessions WHERE id = ?1")?
        .query_row(params![id], |row| row.get(0))
        .optional()?)
}

/// Resolve the durable operating mode for authorization. Unknown sessions
/// return None so callers can fail closed instead of trusting sidecar input.
pub fn session_mode(db: &Database, id: &str) -> Result<Option<String>> {
    Ok(db
        .conn()
        .prepare_cached("SELECT mode FROM sessions WHERE id = ?1")?
        .query_row(params![id], |row| row.get::<_, String>(0))
        .optional()?
        .map(|mode| normalize_mode(Some(&mode))))
}

/// Return an up-to-date layout for one session, reusing cached offsets and
/// scanning only what was appended since.
pub(crate) fn session_layout(
    db: &Database,
    session_id: &str,
) -> Result<transcripts::TranscriptLayout> {
    transcripts::layout::session_layout(db.data_dir(), session_id)
}

pub fn get_session(db: &Database, id: &str) -> Result<Option<SessionDetail>> {
    get_session_with_options(db, id, SessionReadOptions::default())
}

/// The session's index row, without touching the transcript.
///
/// `get_session` materializes every message to answer the same question, which
/// made a plain index lookup cost O(transcript bytes). The workspace resolvers
/// ran a full JSONL parse per tool call and per permission evaluation — twice
/// per plan submission — only to read `project_path`, and two of them ran it
/// just to check that the session exists. Everything they need is in
/// `SUMMARY_SELECT`, so this is one indexed row.
pub fn session_summary(db: &Database, id: &str) -> Result<Option<SessionSummary>> {
    let sql = format!("{SUMMARY_SELECT} AND s.id = ?1");
    let mut summary = db
        .conn()
        .prepare_cached(&sql)?
        .query_row(params![id], summary_from_row)
        .optional()?;
    if let Some(summary) = summary.as_mut() {
        attach_worktrees(db, std::slice::from_mut(summary))?;
    }
    Ok(summary)
}

/// Whether a session row still exists. Used to refuse work that would otherwise
/// outlive its owning session and become unreachable — a background task
/// started after its session was deleted belongs to nobody.
pub fn session_exists(db: &Database, id: &str) -> Result<bool> {
    Ok(db.conn().query_row(
        "SELECT EXISTS(SELECT 1 FROM sessions WHERE id = ?1)",
        params![id],
        |row| row.get(0),
    )?)
}

/// Load a session detail with an optional renderer-facing message window.
/// The uncapped default is intentionally retained for the sidecar and for
/// mutation paths that need the canonical transcript. Renderer callers should
/// request a bounded tail and a display content limit.
pub fn get_session_with_options(
    db: &Database,
    id: &str,
    options: SessionReadOptions,
) -> Result<Option<SessionDetail>> {
    let Some(summary) = session_summary(db, id)? else {
        return Ok(None);
    };

    let bounded = if let Some(raw_limit) = options.message_limit.filter(|limit| *limit > 0) {
        let limit = raw_limit.min(1_000) as usize;
        Some(transcripts::layout::with_layout_recovery(
            db.data_dir(),
            id,
            |layout| {
                let total = layout.message_count();
                let before = if let Some(message_id) = options.message_around.as_deref() {
                    let Some(position) =
                        transcripts::find_message_position(db.data_dir(), id, layout, message_id)?
                    else {
                        return Ok(None);
                    };
                    (position + limit / 2 + 1).min(total)
                } else {
                    match options.message_before {
                        Some(value) => (value.max(0) as usize).min(total),
                        None => total,
                    }
                };
                let start = before.saturating_sub(limit);
                let read = transcripts::read_transcript_window_with_layout(
                    db.data_dir(),
                    id,
                    layout,
                    start,
                    Some(before.saturating_sub(start)),
                )?;
                Ok(Some((
                    dedupe_records(read.messages),
                    read.compactions,
                    Some(start as i64),
                    Some(start > 0),
                    Some(before as i64),
                    Some(before < total),
                )))
            },
        )?)
    } else {
        None
    };
    let (records, compactions, message_start, has_more_before, message_end, has_more_after) =
        match bounded {
            Some(Some(window)) => window,
            Some(None) => return Ok(None),
            None => {
                let read = transcripts::read_transcript_with_compactions(db.data_dir(), id)?;
                (
                    dedupe_records(read.messages),
                    read.compactions,
                    None,
                    None,
                    None,
                    None,
                )
            }
        };
    // Content comes from the transcript file; SQLite only indexes it. A
    // renderer window may additionally request a display cap so a single
    // pasted or tool-produced multi-megabyte message never crosses the UI IPC
    // boundary. The uncapped path remains lossless for model reconstruction.
    let messages: Vec<UiMessage> = match options.content_limit {
        Some(limit) => records
            .into_iter()
            .map(|record| {
                // An explicit search jump must retain the focused message's
                // original text, including hits beyond the normal display cap.
                // Neighbors and tool payloads keep their presentation limits.
                let focused = options.message_around.as_deref() == Some(record.id.as_str())
                    && matches!(record.role.as_str(), "user" | "assistant");
                let content = focused.then(|| record_index_text(&record)).flatten();
                let mut message = record_to_ui_for_display(record, limit);
                if let Some(content) = content {
                    message.content = content;
                }
                message
            })
            .collect(),
        None => records.into_iter().map(record_to_ui).collect(),
    };
    let plan_calls: Vec<&str> = messages
        .iter()
        .filter(|message| {
            matches!(
                message.tool_name.as_deref(),
                Some("SubmitPlan" | "SubmitGoal")
            )
        })
        .filter_map(|message| message.tool_call_id.as_deref())
        .collect();
    let plan_history = crate::plans::history_for_tool_calls(db, id, &plan_calls)?;
    let message_parents = if message_start.is_some() {
        message_parents::read(db, id, &messages, options.content_limit)?
    } else {
        Vec::new()
    };
    let parent_call_id = options.message_around.as_deref().and_then(|target| {
        messages
            .iter()
            .find(|message| message.id == target)
            .and_then(|message| message.parent_tool_call_id.as_deref())
    });
    let navigation_parent = match parent_call_id {
        Some(call_id) => transcripts::layout::with_layout_recovery(db.data_dir(), id, |layout| {
            transcripts::read_tool_call(db.data_dir(), id, layout, call_id)
        })?
        .map(|record| match options.content_limit {
            Some(limit) => record_to_ui_for_display(record, limit),
            None => record_to_ui(record),
        }),
        None => None,
    };
    Ok(Some(SessionDetail {
        summary,
        plan_history,
        navigation_parent,
        message_parents,
        message_start,
        message_end,
        has_more_after,
        has_more_before,
        messages,
        compaction: compactions.last().cloned(),
        compactions,
    }))
}
