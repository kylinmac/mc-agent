use super::index::{dedupe_records, insert_index_row, record_index_text, record_is_streaming};
use super::message_codec::{record_to_ui, ui_to_record};
use super::model_system;
use super::queries::get_session;
use super::recovery::{ensure_session_for_append, session_created_at};
use super::revisions::replace_messages;
use super::types::UiMessage;
use crate::db::{ms_to_ts, now_ms, ts_to_ms, Database};
use crate::transcripts::{self, MessageRecord};
use anyhow::{anyhow, Result};
use rusqlite::{params, OptionalExtension};
use serde_json::{json, Value};

/// Per-message records plus their extracted index text, in input order.
pub(super) fn records_and_texts(
    messages: &[UiMessage],
) -> (Vec<MessageRecord>, Vec<Option<String>>) {
    let mut records = Vec::with_capacity(messages.len());
    let mut texts = Vec::with_capacity(messages.len());
    for message in messages {
        let (record, text) = ui_to_record(message);
        records.push(record);
        texts.push(text);
    }
    (records, texts)
}

pub fn append_message(
    db: &Database,
    session_id: &str,
    message: &UiMessage,
    turn_id: Option<&str>,
) -> Result<()> {
    model_system::validate(message)?;
    let message = crate::session_collaboration::prepare_append(db, session_id, message, turn_id)?;
    let session_created = ensure_session_for_append(db, session_id)?;
    let (mut record, text) = ui_to_record(&message);
    let had_turn_reference = turn_id.is_some();
    let turn_id = valid_turn_reference(db, session_id, turn_id)?;
    let stale_turn_reference = had_turn_reference && turn_id.is_none();
    // Electron may replay an outbox entry after a host restart. Message ids
    // are globally unique, so an existing row in this session is already the
    // durable result. Provider toolCallIds are not globally unique: a collision
    // with another session is remapped before any transcript write (D444).
    // A steering input reserves its preceding streaming assistant's position;
    // only a terminal assistant snapshot may replace that provisional row.
    if message_indexed(db, session_id, &record.id)? {
        if message.role == "assistant"
            && message.status.as_deref() != Some("streaming")
            && streaming_assistant_indexed(db, session_id, &record.id)?
        {
            let stamped = "UPDATE messages SET text = ?3, is_error = ?4, streaming = 0
                 WHERE session_id = ?1 AND id = ?2";
            if transcripts::update_message(db.data_dir(), session_id, &record)? {
                db.conn().execute(
                    stamped,
                    params![session_id, record.id, text, record.is_error],
                )?;
            } else {
                // The index knows this id but the transcript does not. A device
                // that lost a provisional row's bytes leaves exactly this shape,
                // and the caller is delivering the settled row for it: appending
                // keeps the file the source of truth instead of failing a reply
                // whose only other copy is the checkpoint.
                transcripts::append_message(db.data_dir(), session_id, &session_created, &record)?;
                db.conn().execute(
                    stamped,
                    params![session_id, record.id, text, record.is_error],
                )?;
            }
        } else {
            update_delegation_snapshot(db, session_id, &record)?;
            return Ok(());
        }
    } else {
        if let Some(owner) = message_owner(db, &record.id)? {
            if owner != session_id {
                let original_id = record.id.clone();
                record.id = namespaced_message_id(session_id, &record.id);
                if message_indexed(db, session_id, &record.id)? {
                    update_delegation_snapshot(db, session_id, &record)?;
                    return Ok(());
                }
                // Old hosts wrote JSONL then failed UNIQUE. Replaying that
                // leftover must not append a second remapped line (D444).
                if transcript_contains_id(db, session_id, &original_id)? {
                    return Ok(());
                }
            } else {
                return Ok(());
            }
        }
        let transcript_repaired =
            stale_turn_reference && repair_unindexed_transcript_message(db, session_id, &record)?;
        if !transcript_repaired {
            append_record(
                db,
                session_id,
                &session_created,
                &record,
                text.as_deref(),
                turn_id.as_deref(),
            )?;
        }
    }
    if message.role == "assistant" && message.status.as_deref() == Some("streaming") {
        // Even an empty reservation needs a checkpoint so a crash can settle
        // it as aborted. Later stream checkpoints replace this snapshot.
        let existing = transcripts::read_inflight(db.data_dir(), session_id)?;
        if existing.as_ref().is_none_or(|checkpoint| {
            ts_to_ms(&checkpoint.message.created_at) < ts_to_ms(&record.created_at)
        }) {
            transcripts::write_inflight(
                db.data_dir(),
                session_id,
                &transcripts::InflightRecord {
                    schema: transcripts::INFLIGHT_SCHEMA,
                    session_id: session_id.to_string(),
                    saved_at: ms_to_ts(now_ms()),
                    turn_id: turn_id.clone(),
                    message: record,
                },
            )?;
        }
        return Ok(());
    }
    // The final assistant row supersedes any checkpoint of the same message
    // (D299). A checkpoint for a different id belongs to a newer fragment and
    // stays until its own final row or the turn end settles it.
    if record.role == "assistant" {
        if let Some(inflight) = transcripts::read_inflight(db.data_dir(), session_id)? {
            if inflight.message.id == record.id {
                transcripts::remove_inflight(db.data_dir(), session_id)?;
            }
        }
    }
    Ok(())
}

/// Whether the session's index already carries `message_id`.
pub(super) fn message_indexed(db: &Database, session_id: &str, message_id: &str) -> Result<bool> {
    let existing: Option<i64> = db
        .conn()
        .prepare_cached("SELECT mid FROM messages WHERE id = ?1 AND session_id = ?2")?
        .query_row(params![message_id, session_id], |row| row.get(0))
        .optional()?;
    Ok(existing.is_some())
}

/// Session that currently owns this globally unique message id, if any.
pub(super) fn message_owner(db: &Database, message_id: &str) -> Result<Option<String>> {
    let owner: Option<String> = db
        .conn()
        .prepare_cached("SELECT session_id FROM messages WHERE id = ?1")?
        .query_row(params![message_id], |row| row.get(0))
        .optional()?;
    Ok(owner)
}

pub(super) fn namespaced_message_id(session_id: &str, message_id: &str) -> String {
    format!("{session_id}:{message_id}")
}

/// Whether this session's transcript already holds `message_id`.
///
/// This used to read the whole transcript, which parses every record's block
/// tree to answer a presence question; the transcript store answers it from the
/// id field alone.
fn transcript_contains_id(db: &Database, session_id: &str, message_id: &str) -> Result<bool> {
    transcripts::transcript_contains_id(db.data_dir(), session_id, message_id)
}

fn valid_turn_reference(
    db: &Database,
    session_id: &str,
    turn_id: Option<&str>,
) -> Result<Option<String>> {
    let Some(turn_id) = turn_id else {
        return Ok(None);
    };
    let owner: Option<String> = db
        .conn()
        .prepare_cached("SELECT session_id FROM turns WHERE id = ?1")?
        .query_row(params![turn_id], |row| row.get(0))
        .optional()?;
    if owner.as_deref() == Some(session_id) {
        return Ok(Some(turn_id.to_string()));
    }
    tracing::warn!(
        %session_id,
        %turn_id,
        turn_session_id = owner.as_deref().unwrap_or("(missing)"),
        "omitting invalid turn reference from transcript message"
    );
    Ok(None)
}

/// Reconcile an old outbox replay whose transcript line landed before its
/// SQLite index insert failed. Keep the file as source of truth and restore
/// index sequence from its keep-last, unique-message projection.
fn repair_unindexed_transcript_message(
    db: &Database,
    session_id: &str,
    record: &MessageRecord,
) -> Result<bool> {
    let mut records = dedupe_records(transcripts::read_transcript(db.data_dir(), session_id)?);
    let Some(position) = records.iter().position(|existing| existing.id == record.id) else {
        return Ok(false);
    };
    if !transcripts::update_message(db.data_dir(), session_id, record)? {
        return Ok(false);
    }
    records[position] = record.clone();
    rebuild_session_message_index(db, session_id, &records)?;
    tracing::warn!(
        %session_id,
        message_id = %record.id,
        "reconciled transcript message after an unindexed outbox replay"
    );
    Ok(true)
}

fn rebuild_session_message_index(
    db: &Database,
    session_id: &str,
    records: &[MessageRecord],
) -> Result<()> {
    let existing_turns: std::collections::HashMap<String, String> = {
        let mut stmt = db.conn().prepare_cached(
            "SELECT m.id, m.turn_id, t.session_id
             FROM messages m JOIN turns t ON t.id = m.turn_id
             WHERE m.session_id = ?1 AND m.turn_id IS NOT NULL",
        )?;
        let rows = stmt.query_map(params![session_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
            ))
        })?;
        let mut turns = std::collections::HashMap::new();
        for row in rows {
            let (message_id, turn_id, turn_session_id) = row?;
            if turn_session_id == session_id {
                turns.insert(message_id, turn_id);
            }
        }
        turns
    };
    let last_seq = i64::try_from(records.len())
        .map_err(|_| anyhow!("transcript has too many messages to index"))?;
    let conn = db.conn();
    let tx = conn.unchecked_transaction()?;
    tx.prepare_cached("DELETE FROM messages WHERE session_id = ?1")?
        .execute(params![session_id])?;
    for (seq, record) in records.iter().enumerate() {
        let seq =
            i64::try_from(seq).map_err(|_| anyhow!("transcript has too many messages to index"))?;
        let text = record_index_text(record);
        insert_index_row(
            &tx,
            session_id,
            seq,
            existing_turns.get(&record.id).map(String::as_str),
            record,
            text.as_deref(),
        )?;
    }
    let changed = tx
        .prepare_cached("UPDATE sessions SET last_seq = ?1, updated_at = ?2 WHERE id = ?3")?
        .execute(params![last_seq, now_ms(), session_id])?;
    if changed == 0 {
        return Err(anyhow!("session not found while rebuilding message index"));
    }
    tx.commit()?;
    Ok(())
}

/// Whether the last copy of `message_id` is a provisional, streaming assistant
/// row.
///
/// The index row mirrors that copy: it is inserted with the row, the append that
/// lands the terminal snapshot re-stamps it, and an index rebuild recomputes it
/// from the transcript. So this is one indexed lookup instead of a backwards walk
/// over the transcript's message lines, 64 lines per window — the shape that cost
/// 46 ms on a 104 MB transcript once the target sat 512 lines from the tail, and
/// a read of every byte of the file when it sat further, twice per turn.
///
/// A NULL row is a message written before the column existed; those still answer
/// from the transcript, which is why an unrebuilt database behaves exactly as it
/// did before the cache. No row at all means the id has no index entry, which
/// agrees with the transcript's own "the id is not in the file" answer.
pub(super) fn streaming_assistant_indexed(
    db: &Database,
    session_id: &str,
    message_id: &str,
) -> Result<bool> {
    let indexed: Option<(String, Option<i64>)> = db
        .conn()
        .prepare_cached("SELECT role, streaming FROM messages WHERE id = ?1 AND session_id = ?2")?
        .query_row(params![message_id, session_id], |row| {
            Ok((row.get(0)?, row.get(1)?))
        })
        .optional()?;
    match indexed {
        Some((role, Some(streaming))) => Ok(role == "assistant" && streaming != 0),
        Some((_, None)) => streaming_assistant_in_transcript(db, session_id, message_id),
        None => Ok(false),
    }
}

fn streaming_assistant_in_transcript(
    db: &Database,
    session_id: &str,
    message_id: &str,
) -> Result<bool> {
    Ok(indexed_message_record(db, session_id, message_id)?
        .is_some_and(|record| record_is_streaming(&record)))
}

fn indexed_message_record(
    db: &Database,
    session_id: &str,
    message_id: &str,
) -> Result<Option<MessageRecord>> {
    transcripts::layout::with_layout_recovery(db.data_dir(), session_id, |layout| {
        let mut end = layout.message_count();
        while end > 0 {
            let start = end.saturating_sub(64);
            let window = transcripts::read_transcript_window_with_layout(
                db.data_dir(),
                session_id,
                layout,
                start,
                Some(end - start),
            )?;
            if let Some(record) = window
                .messages
                .into_iter()
                .rev()
                .find(|record| record.id == message_id)
            {
                return Ok(Some(record));
            }
            end = start;
        }
        Ok(None)
    })
}

/// Task is already a completed tool call while its delegated work is running.
/// Only its matching terminal result may replace that provisional result; replay
/// must neither reopen a settled delegate nor overwrite another call's metadata.
fn update_delegation_snapshot(
    db: &Database,
    session_id: &str,
    incoming: &MessageRecord,
) -> Result<()> {
    if incoming.role != "tool" || incoming.tool_name.as_deref() != Some("Task") {
        return Ok(());
    }
    let Some(next) = incoming
        .blocks
        .as_array()
        .and_then(|blocks| blocks.iter().find(|block| block["type"] == "tool_call"))
    else {
        return Ok(());
    };
    let details = &next["result"]["details"];
    if !matches!(
        details["status"].as_str(),
        Some("completed" | "stopped" | "aborted" | "failed" | "timed_out")
    ) {
        return Ok(());
    }
    let Some(id) = details["delegationId"].as_str().filter(|id| !id.is_empty()) else {
        return Ok(());
    };
    let Some(mut existing) = indexed_message_record(db, session_id, &incoming.id)? else {
        return Ok(());
    };
    if existing.role != "tool" || existing.tool_name.as_deref() != Some("Task") {
        return Ok(());
    }
    let Some(block) = existing
        .blocks
        .as_array_mut()
        .and_then(|blocks| blocks.iter_mut().find(|block| block["type"] == "tool_call"))
    else {
        return Ok(());
    };
    if block["callId"] != next["callId"]
        || block["result"]["details"]["delegationId"].as_str() != Some(id)
        || block["result"]["details"]["status"] != "running"
    {
        return Ok(());
    }
    block["result"] = next["result"].clone();
    block["text"] = next["text"].clone();
    if !transcripts::update_message(db.data_dir(), session_id, &existing)? {
        return Err(anyhow!(
            "delegation snapshot is missing from its transcript"
        ));
    }
    Ok(())
}

/// Append one canonical record: transcript line first, then the index row.
fn append_record(
    db: &Database,
    session_id: &str,
    session_created: &str,
    record: &MessageRecord,
    text: Option<&str>,
    turn_id: Option<&str>,
) -> Result<()> {
    // File first: the transcript is the source of truth. A crash before the
    // index commit costs one derived row (self-healed by the next rewrite),
    // never message content.
    transcripts::append_message(db.data_dir(), session_id, session_created, record)?;
    let conn = db.conn();
    let tx = conn.unchecked_transaction()?;
    let now = now_ms();
    let seq: Option<i64> = tx
        .prepare_cached(
            "UPDATE sessions SET last_seq = last_seq + 1, updated_at = ?2
             WHERE id = ?1 RETURNING last_seq",
        )?
        .query_row(params![session_id, now], |r| r.get(0))
        .optional()?;
    let Some(seq) = seq else {
        return Err(anyhow!("session not found: {session_id}"));
    };
    insert_index_row(&tx, session_id, seq - 1, turn_id, record, text)?;
    tx.commit()?;
    Ok(())
}

/// Checkpoint the assistant message currently streaming for `session_id`
/// (D299). The checkpoint is a single atomically replaced file beside the
/// transcript, never a transcript line, so a long reply does not bloat the
/// file with one copy per checkpoint. An empty message is not worth keeping;
/// a message whose final row already landed must not be resurrected by a
/// checkpoint that was still in flight when the row was appended.
pub fn save_inflight_message(
    db: &Database,
    session_id: &str,
    turn_id: Option<&str>,
    message: &UiMessage,
) -> Result<bool> {
    session_created_at(db, session_id)?;
    if message.role != "assistant" {
        return Err(anyhow!("in-flight checkpoint must be an assistant message"));
    }
    let has_text = !message.content.trim().is_empty()
        || message
            .thinking
            .as_deref()
            .is_some_and(|thinking| !thinking.trim().is_empty());
    if !has_text {
        return Ok(false);
    }
    if message_indexed(db, session_id, &message.id)?
        && !streaming_assistant_indexed(db, session_id, &message.id)?
    {
        transcripts::remove_inflight(db.data_dir(), session_id)?;
        return Ok(false);
    }
    let (record, _) = ui_to_record(message);
    transcripts::write_inflight(
        db.data_dir(),
        session_id,
        &transcripts::InflightRecord {
            schema: transcripts::INFLIGHT_SCHEMA,
            session_id: session_id.to_string(),
            turn_id: turn_id.map(str::to_string),
            saved_at: ms_to_ts(now_ms()),
            message: record,
        },
    )?;
    Ok(true)
}

/// Settle the session's in-flight checkpoint once its turn can no longer
/// finish on its own (D299, D327). The checkpoint is removed when the final
/// row already landed; otherwise it is promoted into the transcript. A
/// completed turn whose outbox append never arrived is promoted as
/// `complete`; every other leftover is `aborted`. Returns the promoted
/// message so the caller can echo it to the renderer.
pub fn recover_inflight_message(
    db: &Database,
    session_id: &str,
    include_completed: bool,
) -> Result<Option<UiMessage>> {
    let Some(inflight) = transcripts::read_inflight(db.data_dir(), session_id)? else {
        return Ok(None);
    };
    let session_created = match session_created_at(db, session_id) {
        Ok(created) => created,
        // The session is gone; its checkpoint was an orphan.
        Err(_) => {
            transcripts::remove_inflight(db.data_dir(), session_id)?;
            return Ok(None);
        }
    };
    // The file decides here, not the index. A device that lost a settled row's
    // bytes can leave the index claiming the reply is finished while the
    // transcript still holds the provisional row -- and that provisional row is
    // what makes the checkpoint the durable copy of the reply. An index row whose
    // transcript row is gone counts as provisional too, because the checkpoint is
    // then the only copy left.
    let indexed = message_indexed(db, session_id, &inflight.message.id)?;
    let provisional = streaming_assistant_in_transcript(db, session_id, &inflight.message.id)?
        || (indexed && streaming_assistant_indexed(db, session_id, &inflight.message.id)?);
    if indexed && !provisional {
        transcripts::remove_inflight(db.data_dir(), session_id)?;
        return Ok(None);
    }
    if indexed && provisional {
        // Line the cache up with the file before the promotion below, which asks
        // the index whether this id is still the provisional row.
        db.conn().execute(
            "UPDATE messages SET streaming = 1 WHERE session_id = ?1 AND id = ?2",
            params![session_id, inflight.message.id],
        )?;
    }
    // A leftover checkpoint whose final row never landed is the durable
    // reply. Boot skips `completed` turns so the outbox can still append the
    // finished row first (D327). A later pass with `include_completed`
    // promotes whatever the outbox did not land as `complete`. Mid-stream
    // loss and sidecar-loss recovery stay aborted.
    let turn_status: Option<String> = match inflight.turn_id.as_deref() {
        Some(turn_id) => db
            .conn()
            .prepare_cached("SELECT status FROM turns WHERE id = ?1")?
            .query_row(params![turn_id], |r| r.get(0))
            .optional()?,
        None => None,
    };
    let completed = turn_status.as_deref() == Some("completed");
    if completed && !include_completed {
        return Ok(None);
    }
    transcripts::remove_inflight(db.data_dir(), session_id)?;
    let promoted_status = if completed { "complete" } else { "aborted" };
    let mut record = inflight.message;
    let mut meta = match record.meta.take() {
        Some(Value::Object(map)) => map,
        _ => serde_json::Map::new(),
    };
    meta.insert("status".into(), json!(promoted_status));
    record.meta = Some(Value::Object(meta));
    let text = record_index_text(&record);
    if indexed {
        append_message(
            db,
            session_id,
            &record_to_ui(record.clone()),
            inflight.turn_id.as_deref(),
        )?;
    } else {
        append_record(
            db,
            session_id,
            &session_created,
            &record,
            text.as_deref(),
            inflight.turn_id.as_deref(),
        )?;
    }
    Ok(Some(record_to_ui(record)))
}

/// Boot sweep companion to `Database::boot_maintenance` (D299, D327): every
/// checkpoint left behind by a quit or crash is promoted or discarded before
/// the first client request can read its session. A leftover whose turn
/// already completed is promoted as `complete`.
pub fn recover_inflight_messages(
    db: &Database,
    include_completed: bool,
) -> Result<Vec<(String, UiMessage)>> {
    let mut recovered = Vec::new();
    for session_id in transcripts::list_inflight_sessions(db.data_dir())? {
        match recover_inflight_message(db, &session_id, include_completed) {
            Ok(Some(message)) => recovered.push((session_id, message)),
            Ok(None) => {}
            Err(error) => {
                tracing::warn!(%session_id, %error, "in-flight reply recovery failed");
            }
        }
    }
    Ok(recovered)
}

/// Persist the rollback state on the tool message that owns a review snapshot.
/// The tool result remains the message-local source of truth after restart.
pub fn update_tool_review_state(
    db: &Database,
    session_id: &str,
    message_id: &str,
    snapshot_id: &str,
    state: &str,
) -> Result<bool> {
    let Some(detail) = get_session(db, session_id)? else {
        return Ok(false);
    };
    let mut messages = detail.messages;
    let mut changed = false;
    for message in &mut messages {
        if message.id != message_id || message.role != "tool" {
            continue;
        }
        let Some(tool_result) = message.tool_result.as_mut().and_then(Value::as_object_mut) else {
            continue;
        };
        let Some(details) = tool_result
            .get_mut("details")
            .and_then(Value::as_object_mut)
        else {
            continue;
        };
        let Some(review) = details.get_mut("review").and_then(Value::as_object_mut) else {
            continue;
        };
        if review.get("snapshotId").and_then(Value::as_str) != Some(snapshot_id) {
            continue;
        }
        review.insert("state".into(), Value::String(state.to_string()));
        changed = true;
        break;
    }
    if changed {
        replace_messages(db, session_id, &messages)?;
    }
    Ok(changed)
}
