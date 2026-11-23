use super::append::records_and_texts;
use super::fork::session_has_running_turn;
use super::index::insert_index_row;
use super::queries::get_session;
use super::titles::is_default_title;
use super::types::{
    default_permission_mode, default_thinking_level, is_valid_mode, normalize_mode,
    validate_permission_mode, validate_thinking_level, SessionSummary, UiMessage,
    TITLE_SOURCE_DEFAULT, TITLE_SOURCE_MANUAL,
};
use crate::db::{ms_to_ts, now_ms, ts_to_ms, Database};
use crate::transcripts::{self};
use anyhow::{anyhow, Result};
use rusqlite::params;
use uuid::Uuid;

/// Backwards-compatible session constructor.  New callers that need an
/// explicit thinking level should use [`create_session_with_thinking`].
pub fn create_session(
    db: &Database,
    title: Option<String>,
    mode: Option<String>,
    provider_id: Option<String>,
    model_id: Option<String>,
    project_path: Option<String>,
) -> Result<SessionSummary> {
    create_session_with_thinking(db, title, mode, provider_id, model_id, project_path, None)
}

/// Inputs for creating a durable session. Keeping the optional permission mode
/// in this value lets the host validate and persist the full configuration in
/// one database operation without widening the legacy constructor signature.
#[derive(Debug, Default)]
pub struct SessionCreateOptions {
    pub title: Option<String>,
    pub mode: Option<String>,
    pub provider_id: Option<String>,
    pub model_id: Option<String>,
    pub project_path: Option<String>,
    pub thinking_level: Option<String>,
    pub permission_mode: Option<String>,
}

pub fn create_session_with_thinking(
    db: &Database,
    title: Option<String>,
    mode: Option<String>,
    provider_id: Option<String>,
    model_id: Option<String>,
    project_path: Option<String>,
    thinking_level: Option<String>,
) -> Result<SessionSummary> {
    create_session_with_options(
        db,
        SessionCreateOptions {
            title,
            mode,
            provider_id,
            model_id,
            project_path,
            thinking_level,
            permission_mode: None,
        },
    )
}

/// Create a session with all optional configuration applied atomically.
///
/// Omitting `permission_mode` preserves the historical `inherit` default. The
/// extra input is used by trusted desktop orchestration so a new worker can be
/// created with its parent's permission ceiling in the same host transaction.
pub fn create_session_with_options(
    db: &Database,
    options: SessionCreateOptions,
) -> Result<SessionSummary> {
    let SessionCreateOptions {
        title,
        mode,
        provider_id,
        model_id,
        project_path,
        thinking_level,
        permission_mode,
    } = options;
    let now = now_ms();
    let id = Uuid::new_v4().to_string();
    let title = title.unwrap_or_else(|| "New task".into());
    let title_source = if is_default_title(&title) {
        TITLE_SOURCE_DEFAULT
    } else {
        TITLE_SOURCE_MANUAL
    };
    let mode = normalize_mode(mode.as_deref());
    let thinking_level = thinking_level.unwrap_or_else(default_thinking_level);
    validate_thinking_level(&thinking_level)?;
    let permission_mode = permission_mode.unwrap_or_else(default_permission_mode);
    validate_permission_mode(&permission_mode)?;
    let project_id = match project_path
        .as_deref()
        .filter(|path| !path.trim().is_empty())
    {
        Some(path) => Some(db.ensure_project(path, false)?),
        None => None,
    };
    let project_path = match project_id {
        Some(id) => db.project_path(id)?,
        None => None,
    };
    db.conn()
        .prepare_cached(
            "INSERT INTO sessions (
                id, title, project_id, provider_id, model_id, mode, thinking_level,
                permission_mode, title_source, created_at, updated_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?10)",
        )?
        .execute(params![
            id,
            title,
            project_id,
            provider_id,
            model_id,
            mode,
            thinking_level,
            permission_mode,
            title_source,
            now
        ])?;
    Ok(SessionSummary {
        id,
        title,
        message_count: 0,
        project_path,
        model_id,
        provider_id,
        mode,
        thinking_level,
        permission_mode,
        updated_at: ms_to_ts(now),
        created_at: ms_to_ts(now),
        // The run row that owns this transcript is written after creation.
        scheduled_run: false,
        // A new or forked session starts without a worktree (ADR 0329).
        worktree: None,
    })
}

/// Backwards-compatible configurator.  Omitting the thinking level preserves
/// the current persisted value.
#[allow(dead_code)]
pub fn configure_session(
    db: &Database,
    id: &str,
    mode: &str,
    provider_id: Option<&str>,
    model_id: Option<&str>,
) -> Result<Option<SessionSummary>> {
    configure_session_with_thinking(db, id, mode, provider_id, model_id, None, None)
}

#[allow(clippy::too_many_arguments)]
pub fn configure_session_with_thinking(
    db: &Database,
    id: &str,
    mode: &str,
    provider_id: Option<&str>,
    model_id: Option<&str>,
    thinking_level: Option<&str>,
    permission_mode: Option<&str>,
) -> Result<Option<SessionSummary>> {
    if !(is_valid_mode(mode) || mode == "chat") {
        return Err(anyhow!("mode must be plan or agent"));
    }
    let mode = normalize_mode(Some(mode));
    if let Some(level) = thinking_level {
        validate_thinking_level(level)?;
    }
    if let Some(mode) = permission_mode {
        validate_permission_mode(mode)?;
    }
    crate::plans::gate_session_configure(
        db,
        id,
        &mode,
        provider_id,
        model_id,
        thinking_level,
        permission_mode,
    )?;
    let changed = db
        .conn()
        .prepare_cached(
            "UPDATE sessions
             SET mode = ?2, provider_id = COALESCE(?3, provider_id),
                 model_id = COALESCE(?4, model_id),
                 thinking_level = COALESCE(?5, thinking_level),
                 permission_mode = COALESCE(?6, permission_mode), updated_at = ?7
             WHERE id = ?1",
        )?
        .execute(params![
            id,
            mode,
            provider_id,
            model_id,
            thinking_level,
            permission_mode,
            now_ms()
        ])?;
    if changed == 0 {
        return Ok(None);
    }
    Ok(get_session(db, id)?.map(|detail| detail.summary))
}

pub fn delete_session(db: &Database, id: &str) -> Result<bool> {
    let deleted = delete_session_row(db, id)?;
    if deleted {
        remove_deleted_session_files(db, id);
    }
    Ok(deleted)
}

/// Bulk deletion defers filesystem cleanup until its database transaction commits.
pub(crate) fn delete_session_row(db: &Database, id: &str) -> Result<bool> {
    let n = db
        .conn()
        .prepare_cached("DELETE FROM sessions WHERE id = ?1")?
        .execute(params![id])?;
    if n > 0 {
        crate::mc_prompts::clear_session_template(db, id);
    }
    Ok(n > 0)
}

pub(crate) fn remove_deleted_session_files(db: &Database, id: &str) {
    transcripts::remove_session_files(db.data_dir(), id);
    crate::mc_canvas::remove_session_canvases(db.data_dir(), id);
}

/// Outcome of moving a session to a different project.
pub enum MoveSessionProjectResult {
    Moved(Box<SessionSummary>),
    NotFound,
    Busy,
}

/// Move an idle session to another project.
///
/// Only the session's project association and `updated_at` change: transcript,
/// revisions, artifacts, notifications, scratch data, and runtime state belong
/// to the session rather than the project and stay untouched. A session with a
/// running turn is rejected so a live agent never switches instruction roots
/// mid-turn.
pub fn move_session_project(
    db: &Database,
    id: &str,
    project_path: &str,
) -> Result<MoveSessionProjectResult> {
    if get_session(db, id)?.is_none() {
        return Ok(MoveSessionProjectResult::NotFound);
    }
    if session_has_running_turn(db, id)? {
        return Ok(MoveSessionProjectResult::Busy);
    }
    let project_id = db.ensure_project(project_path, false)?;
    db.conn()
        .prepare_cached("UPDATE sessions SET project_id = ?1, updated_at = ?2 WHERE id = ?3")?
        .execute(params![project_id, now_ms(), id])?;
    let Some(moved) = get_session(db, id)? else {
        return Ok(MoveSessionProjectResult::NotFound);
    };
    Ok(MoveSessionProjectResult::Moved(Box::new(moved.summary)))
}

/// Insert a session with caller-provided timestamps and messages in one
/// transaction. Idempotent: if a session with the same id already exists the
/// call is a no-op and returns false.
pub fn import_session(
    db: &Database,
    summary: &SessionSummary,
    messages: &[UiMessage],
) -> Result<bool> {
    validate_thinking_level(&summary.thinking_level)?;
    let mode = normalize_mode(Some(&summary.mode));
    let conn = db.conn();
    let exists: i64 = conn.query_row(
        "SELECT COUNT(*) FROM sessions WHERE id = ?1",
        params![summary.id],
        |row| row.get(0),
    )?;
    if exists > 0 {
        return Ok(false);
    }
    let (records, texts) = records_and_texts(messages);
    transcripts::write_transcript(db.data_dir(), &summary.id, &summary.created_at, &records)?;
    let indexed = (|| -> Result<()> {
        let tx = conn.unchecked_transaction()?;
        let project_id = match summary
            .project_path
            .as_deref()
            .filter(|path| !path.trim().is_empty())
        {
            Some(path) => Some(db.ensure_project(path, false)?),
            None => None,
        };
        let source = summary.id.strip_prefix("import-").map(|rest| {
            for known in ["claude-code", "opencode", "codex", "pi"] {
                if rest.starts_with(&format!("{known}-")) {
                    return known.to_string();
                }
            }
            "external".to_string()
        });
        tx.prepare_cached(
            "INSERT INTO sessions (
                id, title, project_id, provider_id, model_id, mode, thinking_level, source,
                last_seq, created_at, updated_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
        )?
        .execute(params![
            summary.id,
            summary.title,
            project_id,
            summary.provider_id,
            summary.model_id,
            mode,
            summary.thinking_level,
            source,
            records.len() as i64,
            ts_to_ms(&summary.created_at),
            ts_to_ms(&summary.updated_at),
        ])?;
        for (seq, record) in records.iter().enumerate() {
            insert_index_row(
                &tx,
                &summary.id,
                seq as i64,
                None,
                record,
                texts[seq].as_deref(),
            )?;
        }
        tx.commit()?;
        Ok(())
    })();
    if let Err(e) = indexed {
        // Don't leave transcript files behind for a session row that never
        // materialized.
        transcripts::remove_session_files(db.data_dir(), &summary.id);
        return Err(e);
    }
    Ok(true)
}

pub fn session_count(db: &Database) -> Result<i64> {
    Ok(db
        .conn()
        .query_row("SELECT COUNT(*) FROM sessions", [], |row| row.get(0))?)
}

// ---- turns ------------------------------------------------------------------
