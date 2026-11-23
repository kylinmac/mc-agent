use super::append::{message_indexed, recover_inflight_message, streaming_assistant_indexed};
use super::types::UiMessage;
use super::usage;
use crate::db::{now_ms, Database};
use crate::notifications::{self, Notification};
use crate::transcripts::{self};
use anyhow::{anyhow, Result};
use rusqlite::{params, OptionalExtension};
use serde_json::Value;
use uuid::Uuid;

pub fn begin_turn(
    db: &Database,
    session_id: &str,
    provider_id: Option<&str>,
    model_id: Option<&str>,
) -> Result<String> {
    let id = Uuid::new_v4().to_string();
    let inserted = db
        .conn()
        .prepare_cached(
            "INSERT INTO turns (id, session_id, provider_id, model_id, started_at)
             SELECT ?1, ?2, ?3, ?4, ?5
             WHERE EXISTS (SELECT 1 FROM sessions WHERE id = ?2)
               AND NOT EXISTS (
                 SELECT 1 FROM turns WHERE session_id = ?2 AND status = 'running'
               )",
        )?
        .execute(params![id, session_id, provider_id, model_id, now_ms()])
        .map_err(|error| {
            let message = error.to_string();
            if message.contains("turns.session_id")
                || message.contains("idx_turns_one_running_session")
            {
                anyhow!("AGENT_BUSY")
            } else {
                error.into()
            }
        })?;
    if inserted == 0 {
        let session_exists: bool = db.conn().query_row(
            "SELECT EXISTS(SELECT 1 FROM sessions WHERE id = ?1)",
            params![session_id],
            |row| row.get(0),
        )?;
        if !session_exists {
            return Err(anyhow!("session not found: {session_id}"));
        }
        return Err(anyhow!("AGENT_BUSY"));
    }
    Ok(id)
}

pub struct EndTurnResult {
    pub updated: bool,
    pub notification: Option<Notification>,
    /// In-flight reply promoted into the transcript by this turn end (D299).
    pub recovered: Option<UiMessage>,
}

/// Test-facing shorthand for `end_turn_settling` without checkpoint recovery.
#[cfg(test)]
pub fn end_turn(
    db: &Database,
    turn_id: &str,
    status: &str,
    error_code: Option<&str>,
    usage: Option<&Value>,
    create_notification: bool,
) -> Result<EndTurnResult> {
    end_turn_settling(
        db,
        turn_id,
        status,
        error_code,
        usage,
        create_notification,
        false,
    )
}

/// `end_turn` that also settles the session's in-flight reply checkpoint
/// (D299). `recover_inflight` promotes a checkpoint whose final row can no
/// longer arrive; it is what a caller passes when the sidecar is gone.
pub fn end_turn_settling(
    db: &Database,
    turn_id: &str,
    status: &str,
    error_code: Option<&str>,
    usage: Option<&Value>,
    create_notification: bool,
    recover_inflight: bool,
) -> Result<EndTurnResult> {
    let status = match status {
        "completed" | "aborted" | "error" => status,
        _ => "completed",
    };
    let existing_usage: Option<String> = db
        .conn()
        .query_row(
            "SELECT usage_json FROM turns WHERE id = ?1",
            params![turn_id],
            |row| row.get(0),
        )
        .optional()?
        .flatten();
    let existing_usage = existing_usage
        .as_deref()
        .map(serde_json::from_str::<Value>)
        .transpose()?;
    let merged_usage = usage.map(|next| usage::merge_usage(existing_usage.as_ref(), next));
    let usage = merged_usage.as_ref().or(existing_usage.as_ref());
    let input_tokens = usage
        .and_then(|u| u.get("inputTokens"))
        .and_then(|v| v.as_i64());
    let output_tokens = usage
        .and_then(|u| u.get("outputTokens"))
        .and_then(|v| v.as_i64());
    let session_id: Option<String> = db
        .conn()
        .prepare_cached("SELECT session_id FROM turns WHERE id = ?1")?
        .query_row(params![turn_id], |r| r.get(0))
        .optional()?;
    let tx = db.conn().unchecked_transaction()?;
    let n = tx
        .prepare_cached(
            "UPDATE turns SET status = ?1, error_code = ?2, ended_at = ?3,
                input_tokens = COALESCE(?4, input_tokens),
                output_tokens = COALESCE(?5, output_tokens),
                usage_json = COALESCE(?6, usage_json)
             WHERE id = ?7 AND status = 'running'",
        )?
        .execute(params![
            status,
            error_code,
            now_ms(),
            input_tokens,
            output_tokens,
            usage.map(|u| u.to_string()),
            turn_id,
        ])?;
    // A replay after startup recovery may complete accounting for a terminal
    // turn, but must never change its settled status or emit another notification.
    if n == 0 && usage.is_some_and(|value| value.get("operations").is_some()) {
        tx.execute(
            "UPDATE turns SET input_tokens = ?1, output_tokens = ?2, usage_json = ?3 WHERE id = ?4",
            params![
                input_tokens,
                output_tokens,
                usage.map(Value::to_string),
                turn_id
            ],
        )?;
    }
    let notification = if n > 0 && create_notification {
        notifications::insert_for_terminal_turn(&tx, turn_id, status, error_code)?
    } else {
        None
    };
    tx.commit()?;
    // Settle the in-flight checkpoint (D299, D327). A caller that knows the
    // reply can never finish (sidecar gone) asks for recovery. A completed or
    // error turn drops the checkpoint only once its final row is indexed —
    // otherwise the outbox may still be draining, and a quit would lose the
    // reply the user already saw. A user stop leaves the checkpoint alone:
    // the aborted final row is still on its way and removes it on arrival,
    // and the boot sweep settles a row that never came.
    let recovered = match session_id.as_deref() {
        Some(session_id) if recover_inflight => recover_inflight_message(db, session_id, true)?,
        Some(session_id) if status != "aborted" => {
            if let Some(inflight) = transcripts::read_inflight(db.data_dir(), session_id)? {
                if message_indexed(db, session_id, &inflight.message.id)?
                    && !streaming_assistant_indexed(db, session_id, &inflight.message.id)?
                {
                    transcripts::remove_inflight(db.data_dir(), session_id)?;
                }
            }
            None
        }
        _ => None,
    };
    Ok(EndTurnResult {
        updated: n > 0,
        notification,
        recovered,
    })
}

// ---- search -----------------------------------------------------------------
