use super::append::{message_owner, namespaced_message_id};
use super::index::{dedupe_records, insert_index_row, record_index_text};
use super::types::{default_permission_mode, default_thinking_level};
use crate::db::{ms_to_ts, now_ms, ts_to_ms, Database};
use crate::transcripts::{self, MessageRecord};
use anyhow::{anyhow, Result};
use rusqlite::{params, OptionalExtension};

fn recovered_session_title(records: &[MessageRecord]) -> String {
    let title = records
        .iter()
        .find(|record| record.role == "user")
        .and_then(record_index_text)
        .map(|text| {
            text.split_whitespace()
                .collect::<Vec<_>>()
                .join(" ")
                .chars()
                .take(48)
                .collect::<String>()
        })
        .unwrap_or_default();
    if title.is_empty() {
        "Recovered session".into()
    } else {
        title
    }
}

fn insert_recovered_session_row(
    tx: &rusqlite::Transaction<'_>,
    session_id: &str,
    title: &str,
    last_seq: i64,
    created_at: i64,
    updated_at: i64,
) -> Result<()> {
    tx.prepare_cached(
        "INSERT INTO sessions (
            id, title, last_seq, thinking_level, permission_mode, created_at, updated_at
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
    )?
    .execute(params![
        session_id,
        title,
        last_seq,
        default_thinking_level(),
        default_permission_mode(),
        created_at,
        updated_at
    ])?;
    Ok(())
}

/// Restore a missing sessions row (and its search index) from an orphaned
/// JSONL transcript. Returns true when a row was inserted (D318).
pub fn restore_orphaned_session(db: &Database, session_id: &str) -> Result<bool> {
    if session_created_at(db, session_id).is_ok() {
        return Ok(false);
    }
    let path = transcripts::transcript_path(db.data_dir(), session_id)?;
    if !path.exists() {
        return Ok(false);
    }
    let read = transcripts::read_transcript_with_compactions(db.data_dir(), session_id)?;
    let mut records = dedupe_records(read.messages);
    let mut remapped = false;
    for record in &mut records {
        if let Some(owner) = message_owner(db, &record.id)? {
            if owner != session_id {
                record.id = namespaced_message_id(session_id, &record.id);
                remapped = true;
            }
        }
    }
    if remapped {
        let header = records
            .first()
            .map(|record| record.created_at.clone())
            .unwrap_or_else(|| ms_to_ts(now_ms()));
        transcripts::write_transcript_with_compactions(
            db.data_dir(),
            session_id,
            &header,
            &records,
            &read.compactions,
        )?;
    }
    let created_at = records
        .first()
        .map(|record| ts_to_ms(&record.created_at))
        .unwrap_or_else(now_ms);
    let updated_at = records
        .last()
        .map(|record| ts_to_ms(&record.created_at))
        .unwrap_or(created_at);
    let title = recovered_session_title(&records);
    let conn = db.conn();
    let tx = conn.unchecked_transaction()?;
    insert_recovered_session_row(
        &tx,
        session_id,
        &title,
        records.len() as i64,
        created_at,
        updated_at,
    )?;
    for (seq, record) in records.iter().enumerate() {
        insert_index_row(
            &tx,
            session_id,
            seq as i64,
            None,
            record,
            record_index_text(record).as_deref(),
        )?;
    }
    tx.commit()?;
    tracing::info!(
        %session_id,
        messages = records.len(),
        "restored orphaned session row from transcript"
    );
    Ok(true)
}

/// Boot sweep: every live transcript whose sessions row is gone is reinserted
/// so the sidebar and the persistence outbox can see it again (D318).
pub fn recover_orphaned_sessions(db: &Database) -> Result<usize> {
    let mut restored = 0;
    for session_id in transcripts::list_transcript_sessions(db.data_dir())? {
        match restore_orphaned_session(db, &session_id) {
            Ok(true) => restored += 1,
            Ok(false) => {}
            Err(error) => {
                tracing::warn!(%session_id, %error, "orphaned session restore failed");
            }
        }
    }
    Ok(restored)
}

pub(super) fn ensure_session_for_append(db: &Database, session_id: &str) -> Result<String> {
    match session_created_at(db, session_id) {
        Ok(created) => Ok(created),
        Err(error) if error.to_string().starts_with("session not found") => {
            if restore_orphaned_session(db, session_id)? {
                return session_created_at(db, session_id);
            }
            let now = now_ms();
            let conn = db.conn();
            let tx = conn.unchecked_transaction()?;
            insert_recovered_session_row(&tx, session_id, "Recovered session", 0, now, now)?;
            tx.commit()?;
            tracing::warn!(
                %session_id,
                "recreated missing session row so a persistence outbox can drain"
            );
            session_created_at(db, session_id)
        }
        Err(error) => Err(error),
    }
}

/// The session's created_at (RFC3339, used as the transcript header stamp) —
/// doubles as the existence check before any transcript file is touched.
pub(super) fn session_created_at(db: &Database, session_id: &str) -> Result<String> {
    let ms: Option<i64> = db
        .conn()
        .prepare_cached("SELECT created_at FROM sessions WHERE id = ?1")?
        .query_row(params![session_id], |r| r.get(0))
        .optional()?;
    ms.map(ms_to_ts)
        .ok_or_else(|| anyhow!("session not found: {session_id}"))
}
