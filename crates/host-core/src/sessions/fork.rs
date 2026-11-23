use super::fork_files;
use super::index::{dedupe_records, insert_index_row, record_index_text};
use super::message_codec::record_to_ui;
use super::queries::get_session;
use super::types::{SessionDetail, SessionSummary};
use crate::db::{ms_to_ts, now_ms, Database};
use crate::transcripts::{self, CompactionRecord, MessageRecord};
use anyhow::{anyhow, Result};
use rusqlite::params;
use serde_json::{json, Value};
use uuid::Uuid;

fn collect_tool_call_ids(records: &[MessageRecord]) -> std::collections::HashMap<String, String> {
    let mut ids = std::collections::HashMap::new();
    for record in records {
        let Some(blocks) = record.blocks.as_array() else {
            continue;
        };
        for block in blocks {
            let Some(object) = block.as_object() else {
                continue;
            };
            for key in ["callId", "toolCallId"] {
                if let Some(id) = object.get(key).and_then(Value::as_str) {
                    ids.entry(id.to_string())
                        .or_insert_with(|| Uuid::new_v4().to_string());
                }
            }
        }
    }
    ids
}

pub(super) fn clone_records_for_fork(
    records: Vec<MessageRecord>,
) -> (
    Vec<MessageRecord>,
    std::collections::HashMap<String, String>,
    std::collections::HashMap<String, String>,
) {
    let records = dedupe_records(records);
    let tool_call_ids = collect_tool_call_ids(&records);
    let message_ids = records
        .iter()
        .map(|record| (record.id.clone(), Uuid::new_v4().to_string()))
        .collect::<std::collections::HashMap<_, _>>();
    let cloned = records
        .into_iter()
        .map(|mut record| {
            record.id = message_ids
                .get(&record.id)
                .cloned()
                .unwrap_or_else(|| Uuid::new_v4().to_string());
            if let Some(meta) = record.meta.as_mut().and_then(Value::as_object_mut) {
                if let Some(system) = meta.get_mut("modelSystem").and_then(Value::as_object_mut) {
                    for key in ["beforeMessageId", "afterMessageId"] {
                        if let Some(new_id) = system
                            .get(key)
                            .and_then(Value::as_str)
                            .and_then(|id| message_ids.get(id))
                        {
                            system.insert(key.into(), json!(new_id));
                        } else {
                            system.remove(key);
                        }
                    }
                }
                meta.remove("revisionRootId");
                meta.remove("revisionCount");
                meta.remove("activeRevision");
                if meta.is_empty() {
                    record.meta = None;
                }
            }
            if let Some(blocks) = record.blocks.as_array_mut() {
                for block in blocks {
                    let Some(object) = block.as_object_mut() else {
                        continue;
                    };
                    for key in ["callId", "toolCallId"] {
                        let Some(old_id) = object.get(key).and_then(Value::as_str) else {
                            continue;
                        };
                        if let Some(new_id) = tool_call_ids.get(old_id) {
                            object.insert(key.to_string(), json!(new_id));
                        }
                    }
                    // Review snapshots are owned by the source session's
                    // workspace. Keep the copied diff evidence visible, but
                    // prevent a fork from offering a rollback against a
                    // snapshot it does not own.
                    if object.get("type").and_then(Value::as_str) == Some("tool_call") {
                        if let Some(review) = object
                            .get_mut("result")
                            .and_then(Value::as_object_mut)
                            .and_then(|result| result.get_mut("details"))
                            .and_then(Value::as_object_mut)
                            .and_then(|details| details.get_mut("review"))
                            .and_then(Value::as_object_mut)
                        {
                            review.insert("reversible".into(), Value::Bool(false));
                        }
                    }
                }
            }
            record
        })
        .collect();
    (cloned, message_ids, tool_call_ids)
}

fn remap_value_strings(
    value: &mut Value,
    replacements: &std::collections::HashMap<String, String>,
) {
    match value {
        Value::String(text) => {
            if let Some(replacement) = replacements.get(text) {
                *text = replacement.clone();
            }
        }
        Value::Array(items) => {
            for item in items {
                remap_value_strings(item, replacements);
            }
        }
        Value::Object(object) => {
            for item in object.values_mut() {
                remap_value_strings(item, replacements);
            }
        }
        _ => {}
    }
}

fn clone_compaction_for_fork(
    mut compaction: CompactionRecord,
    message_ids: &std::collections::HashMap<String, String>,
    tool_call_ids: &std::collections::HashMap<String, String>,
) -> Option<CompactionRecord> {
    compaction.first_kept_message_id = compaction
        .first_kept_message_id
        .as_ref()
        .and_then(|id| message_ids.get(id).cloned());
    compaction.through_message_id = message_ids.get(&compaction.through_message_id)?.clone();
    compaction.id = Uuid::new_v4().to_string();
    if let Some(tail) = compaction.retained_tail.as_mut() {
        remap_value_strings(tail, tool_call_ids);
    }
    Some(compaction)
}

/// Create an independent session from the source session's current canonical
/// transcript and referenced pasted inputs. Regenerate revisions, turns,
/// artifacts, notifications, other scratch data, and live runtime state are
/// intentionally not copied.
pub enum ForkSessionResult {
    Created(Box<SessionDetail>),
    NotFound,
    Busy,
}

/// Whether the session currently owns a running turn.
///
/// A running turn owns its project's instructions, tools, and working
/// directory, so moving or deleting that project is refused while it runs.
/// A fork may copy a completed prefix without touching that live ownership.
pub fn session_has_running_turn(db: &Database, id: &str) -> Result<bool> {
    let running: bool = db.conn().query_row(
        "SELECT EXISTS(
            SELECT 1 FROM turns WHERE session_id = ?1 AND status = 'running'
         )",
        params![id],
        |row| row.get(0),
    )?;
    Ok(running)
}

/// Create an independent session from the source transcript, optionally
/// stopping after one message. Message-scoped forks use this to keep later
/// turns out of the child while preserving the same cache/runtime isolation as
/// a full session fork.
pub fn fork_session_through(
    db: &Database,
    source_id: &str,
    title: Option<&str>,
    through_message_id: Option<&str>,
) -> Result<ForkSessionResult> {
    let Some(source) = get_session(db, source_id)? else {
        return Ok(ForkSessionResult::NotFound);
    };
    let running = session_has_running_turn(db, source_id)?;
    let anchor = through_message_id
        .map(str::trim)
        .filter(|id| !id.is_empty());
    if running && anchor.is_none() {
        return Ok(ForkSessionResult::Busy);
    }
    let mut source_records =
        dedupe_records(transcripts::read_transcript(db.data_dir(), source_id)?);
    if let Some(message_id) = anchor {
        let Some(position) = source_records
            .iter()
            .position(|record| record.id == message_id)
        else {
            return Ok(ForkSessionResult::NotFound);
        };
        if running {
            let record = &source_records[position];
            // An assistant message can be complete while its tool loop is still
            // running. Reject any prefix containing rows owned by a live turn,
            // not merely a streaming anchor. The RPC holds the host state lock
            // across this check and publication, including transcript appends.
            let settled_prefix: bool = db.conn().query_row(
                "SELECT EXISTS (
                    SELECT 1 FROM messages anchor
                    WHERE anchor.session_id = ?1 AND anchor.id = ?2
                    AND NOT EXISTS (
                        SELECT 1 FROM messages m JOIN turns t ON t.id = m.turn_id
                        WHERE m.session_id = ?1 AND t.status = 'running'
                          AND m.seq <= anchor.seq
                    )
                 )",
                params![source_id, message_id],
                |row| row.get(0),
            )?;
            if record.role != "assistant"
                || record.is_error
                || !matches!(
                    record
                        .meta
                        .as_ref()
                        .and_then(|meta| meta.get("status"))
                        .and_then(Value::as_str),
                    None | Some("complete")
                )
                || record
                    .meta
                    .as_ref()
                    .and_then(|meta| meta.get("error"))
                    .is_some_and(|error| !error.is_null())
                || !settled_prefix
            {
                return Ok(ForkSessionResult::Busy);
            }
        }
        source_records.truncate(position + 1);
    }
    let source_compactions = transcripts::read_compactions(db.data_dir(), source_id)?;
    let (mut records, message_ids, tool_call_ids) = clone_records_for_fork(source_records);
    // Each checkpoint is remapped on its own: a message-scoped fork can cut the
    // anchor of a later checkpoint while the earlier ones stay intact.
    let mut compactions: Vec<CompactionRecord> = source_compactions
        .into_iter()
        .filter_map(|record| clone_compaction_for_fork(record, &message_ids, &tool_call_ids))
        .collect();
    let id = Uuid::new_v4().to_string();
    let files = fork_files::preserve(
        db.data_dir(),
        source_id,
        &id,
        &mut records,
        &mut compactions,
    )?;
    let visualization_files = fork_files::preserve_visualizations(
        db.data_dir(),
        source_id,
        &id,
        &mut records,
        &mut compactions,
    )?;
    let texts = records.iter().map(record_index_text).collect::<Vec<_>>();
    let now = now_ms();
    let created_at = ms_to_ts(now);
    let requested_title = title.map(str::trim).filter(|value| !value.is_empty());
    let title = requested_title
        .map(|value| value.chars().take(100).collect::<String>())
        .unwrap_or_else(|| format!("{} (branch)", source.summary.title));
    if let Err(error) = transcripts::write_transcript_with_compactions(
        db.data_dir(),
        &id,
        &created_at,
        &records,
        &compactions,
    ) {
        transcripts::remove_session_files(db.data_dir(), &id);
        return Err(error);
    }
    let indexed = (|| -> Result<()> {
        let tx = db.conn().unchecked_transaction()?;
        let inserted = tx
            .prepare_cached(
                "INSERT INTO sessions (
                    id, title, project_id, provider_id, model_id, mode, thinking_level,
                    permission_mode, source, pinned, last_seq, created_at, updated_at
                 )
                 SELECT ?1, ?2, project_id, provider_id, model_id, mode, thinking_level,
                        permission_mode, NULL, 0, ?3, ?4, ?4
                 FROM sessions WHERE id = ?5",
            )?
            .execute(params![id, title, records.len() as i64, now, source_id])?;
        if inserted == 0 {
            return Err(anyhow!("session not found: {source_id}"));
        }
        for (seq, record) in records.iter().enumerate() {
            insert_index_row(&tx, &id, seq as i64, None, record, texts[seq].as_deref())?;
        }
        tx.commit()?;
        Ok(())
    })();
    if let Err(error) = indexed {
        transcripts::remove_session_files(db.data_dir(), &id);
        return Err(error);
    }
    files.commit();
    visualization_files.commit();

    let summary = SessionSummary {
        id,
        title,
        message_count: records.len() as i64,
        project_path: source.summary.project_path,
        model_id: source.summary.model_id,
        provider_id: source.summary.provider_id,
        mode: source.summary.mode,
        thinking_level: source.summary.thinking_level,
        permission_mode: source.summary.permission_mode,
        updated_at: created_at.clone(),
        created_at,
        // A fork is the user's own conversation, not the automation's transcript.
        scheduled_run: false,
        // A new or forked session starts without a worktree (ADR 0329).
        worktree: None,
    };
    let messages = records.into_iter().map(record_to_ui).collect();
    Ok(ForkSessionResult::Created(Box::new(SessionDetail {
        summary,
        plan_history: Vec::new(),
        navigation_parent: None,
        message_parents: Vec::new(),
        message_start: None,
        message_end: None,
        has_more_after: None,
        has_more_before: None,
        messages,
        compaction: compactions.last().cloned(),
        compactions,
    })))
}
