use super::append::records_and_texts;
use super::index::insert_index_row;
use super::message_codec::{record_to_ui, ui_to_record};
use super::queries::get_session;
use super::recovery::session_created_at;
use super::turns::end_turn_settling;
use super::types::UiMessage;
use crate::db::{ms_to_ts, now_ms, Database};
use crate::transcripts::{self, CompactionRecord, MessageRecord, RevisionRecord};
use anyhow::{anyhow, Result};
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use uuid::Uuid;

pub fn append_compaction(
    db: &Database,
    session_id: &str,
    compaction: &CompactionRecord,
) -> Result<()> {
    if compaction.id.trim().is_empty()
        || compaction.summary.trim().is_empty()
        || compaction.through_message_id.trim().is_empty()
        || compaction.tokens_before < 0
    {
        return Err(anyhow!("invalid compaction record"));
    }
    let session_created = session_created_at(db, session_id)?;
    transcripts::append_compaction(db.data_dir(), session_id, &session_created, compaction)
}

fn compaction_valid_for_records(compaction: &CompactionRecord, records: &[MessageRecord]) -> bool {
    let Some(through_index) = records
        .iter()
        .position(|record| record.id == compaction.through_message_id)
    else {
        return false;
    };
    compaction.first_kept_message_id.as_ref().is_none_or(|id| {
        records
            .iter()
            .position(|record| &record.id == id)
            .is_some_and(|index| index <= through_index)
    })
}

/// Store in full every regenerate family this rewrite is about to drop.
///
/// A branch that is still live is referenced rather than copied, so its
/// reference line only resolves while its root is in the transcript. A rewrite
/// that removes the root — deleting the turn that owns the family, a regenerate
/// or edit that cuts a later family away, a revision switch that restores a
/// prefix from before it — would otherwise leave the file naming a suffix that
/// no longer exists. Every dropped family is written out first, from `before`,
/// exactly as a revision switch writes the branch it pages away from.
///
/// A rewrite that only shortens a live branch is left alone: the reference then
/// describes the transcript as the user just made it, which is the same
/// authority the durable transcript has everywhere else.
///
/// `already_stored` names families the caller has just written itself, so the
/// payload is not written twice.
fn archive_dropped_live_branches(
    db: &Database,
    session_id: &str,
    before: &[UiMessage],
    kept: &[UiMessage],
    already_stored: &[String],
) -> Result<()> {
    for root in dropped_revision_roots(db, session_id, kept, already_stored)? {
        archive_live_branch(db, session_id, &root, before)?;
    }
    Ok(())
}

/// The families indexed for this session whose root `kept` no longer holds: the
/// branches a rewrite from the current transcript would strand. Index rows only,
/// so a rewrite that drops nothing pays no transcript read.
fn dropped_revision_roots(
    db: &Database,
    session_id: &str,
    kept: &[UiMessage],
    already_stored: &[String],
) -> Result<Vec<String>> {
    let conn = db.conn();
    let mut stmt = conn.prepare_cached(
        "SELECT DISTINCT root_user_id FROM message_revisions WHERE session_id = ?1",
    )?;
    let rows = stmt.query_map(params![session_id], |row| row.get::<_, String>(0))?;
    let mut dropped = Vec::new();
    for row in rows {
        let root = row?;
        if already_stored.iter().any(|stored| stored == &root) {
            continue;
        }
        if live_branch_start(kept, &root).is_none() {
            dropped.push(root);
        }
    }
    Ok(dropped)
}

/// Rewrite a session's whole transcript from `messages`, leaving every
/// regenerate family the rewrite would drop stored in full.
pub fn replace_messages(db: &Database, session_id: &str, messages: &[UiMessage]) -> Result<()> {
    rewrite_transcript(db, session_id, messages, &[])
}

/// Rewrite the transcript and reseat the index rows.
///
/// `already_stored` names families the caller stored on its own way here, so
/// [`archive_dropped_live_branches`] does not write them a second time.
fn rewrite_transcript(
    db: &Database,
    session_id: &str,
    messages: &[UiMessage],
    already_stored: &[String],
) -> Result<()> {
    // The guard writes from the OLD transcript, so it has to read it before the
    // rewrite below replaces it — and only when a family is actually dropped.
    if !dropped_revision_roots(db, session_id, messages, already_stored)?.is_empty() {
        if let Some(detail) = get_session(db, session_id)? {
            archive_dropped_live_branches(
                db,
                session_id,
                &detail.messages,
                messages,
                already_stored,
            )?;
        }
    }
    rewrite_transcript_body(db, session_id, messages)
}

/// The rewrite itself, with no regard for the revisions the caller drops.
fn rewrite_transcript_body(db: &Database, session_id: &str, messages: &[UiMessage]) -> Result<()> {
    let session_created = session_created_at(db, session_id)?;
    crate::session_collaboration::validate_replacement(db, session_id, messages)?;
    let (records, texts) = records_and_texts(messages);
    let compactions: Vec<CompactionRecord> =
        transcripts::read_compactions(db.data_dir(), session_id)?
            .into_iter()
            .filter(|record| compaction_valid_for_records(record, &records))
            .collect();
    transcripts::write_transcript_with_compactions(
        db.data_dir(),
        session_id,
        &session_created,
        &records,
        &compactions,
    )?;
    let conn = db.conn();
    // A rewrite reseats every index row, so the turn each surviving message was
    // produced in has to be carried across it. Dropping it here cost the whole
    // session its turn/token attribution on any regenerate.
    let mut owning_turns: std::collections::HashMap<String, String> =
        std::collections::HashMap::new();
    {
        let mut stmt = conn.prepare_cached(
            "SELECT id, turn_id FROM messages
             WHERE session_id = ?1 AND turn_id IS NOT NULL",
        )?;
        let rows = stmt.query_map(params![session_id], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?;
        for row in rows {
            let (id, turn_id) = row?;
            owning_turns.insert(id, turn_id);
        }
    }
    let tx = conn.unchecked_transaction()?;
    tx.prepare_cached("DELETE FROM messages WHERE session_id = ?1")?
        .execute(params![session_id])?;
    for (seq, record) in records.iter().enumerate() {
        insert_index_row(
            &tx,
            session_id,
            seq as i64,
            owning_turns.get(&record.id).map(String::as_str),
            record,
            texts[seq].as_deref(),
        )?;
    }
    tx.prepare_cached("UPDATE sessions SET last_seq = ?1, updated_at = ?2 WHERE id = ?3")?
        .execute(params![records.len() as i64, now_ms(), session_id])?;
    tx.commit()?;
    Ok(())
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TruncateRevisionMeta {
    pub root_user_id: String,
    pub revision_count: i64,
    pub active_revision: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TruncateFromResult {
    pub ok: bool,
    pub kept_count: i64,
    pub discarded_count: i64,
    pub aborted_turn_id: Option<String>,
    pub revision: Option<TruncateRevisionMeta>,
}

/// Cut the live transcript at a named message (or a count) under the RPC lock.
///
/// Regenerating from Electron used to ship the kept prefix back through
/// `session.replaceMessages`. That JSON-RPC line is one NDJSON record, so an
/// 80 MB transcript both exceeds the 64 MiB stdin cap and races the 130 s
/// client deadline. This call reads, archives the discarded tail, and rewrites
/// the prefix inside host-core. No transcript snapshot crosses the process
/// boundary.
pub fn truncate_from(
    db: &Database,
    session_id: &str,
    from_message_id: Option<&str>,
    truncate_before: Option<i64>,
) -> Result<TruncateFromResult> {
    let Some(detail) = get_session(db, session_id)? else {
        return Err(anyhow!("NOT_FOUND: session not found"));
    };
    let messages = detail.messages;
    let cut = match from_message_id.map(str::trim).filter(|id| !id.is_empty()) {
        Some(message_id) => messages
            .iter()
            .position(|message| message.id == message_id)
            .ok_or_else(|| anyhow!("NOT_FOUND: truncateFromMessageId is not in this session"))?,
        None => match truncate_before {
            Some(count) if count >= 0 => (count as usize).min(messages.len()),
            Some(_) => {
                return Err(anyhow!(
                    "INVALID_PARAMS: truncateBefore must be non-negative"
                ));
            }
            None => {
                return Err(anyhow!(
                    "INVALID_PARAMS: fromMessageId or truncateBefore required"
                ));
            }
        },
    };
    let discarded = &messages[cut..];
    if discarded
        .first()
        .is_some_and(|message| message.session_message.is_some())
    {
        return Err(anyhow!(
            "PERMISSION_DENIED: session messages cannot be edited or regenerated"
        ));
    }
    let kept = &messages[..cut];

    let aborted_turn_id = abort_running_turn(db, session_id)?;
    let revision = archive_discarded_regenerate_branch(db, session_id, discarded)?;
    // The regenerate root's branch is already stored above; every OTHER family
    // the cut takes away is not, and the guard in `rewrite_transcript` stores
    // those. Skipping the one that is done keeps it from being written twice.
    let already_stored: Vec<String> = revision
        .iter()
        .map(|meta| meta.root_user_id.clone())
        .collect();
    rewrite_transcript(db, session_id, kept, &already_stored)?;
    let _ = transcripts::remove_inflight(db.data_dir(), session_id);
    Ok(TruncateFromResult {
        ok: true,
        kept_count: kept.len() as i64,
        discarded_count: discarded.len() as i64,
        aborted_turn_id,
        revision,
    })
}

fn abort_running_turn(db: &Database, session_id: &str) -> Result<Option<String>> {
    let turn_id: Option<String> = db
        .conn()
        .prepare_cached("SELECT id FROM turns WHERE session_id = ?1 AND status = 'running'")?
        .query_row(params![session_id], |row| row.get(0))
        .optional()?;
    let Some(turn_id) = turn_id else {
        return Ok(None);
    };
    end_turn_settling(
        db,
        &turn_id,
        "aborted",
        Some("TURN_ABORTED"),
        None,
        false,
        false,
    )?;
    Ok(Some(turn_id))
}

/// Archive the discarded regenerate tail the way Electron main used to, but
/// without copying the branch across the JSON-RPC pipe.
///
/// The tail is about to be cut out of the transcript, so this always writes the
/// payload in full: a live reference would stop resolving the moment
/// `truncate_from` replaces the file.
fn archive_discarded_regenerate_branch(
    db: &Database,
    session_id: &str,
    discarded: &[UiMessage],
) -> Result<Option<TruncateRevisionMeta>> {
    let Some(root_user) = discarded
        .iter()
        .find(|message| message.role == "user" && !message.id.trim().is_empty())
    else {
        return Ok(None);
    };
    if discarded.is_empty() {
        return Ok(None);
    }
    let stable_root = root_user
        .revision_root_id
        .as_deref()
        .map(str::trim)
        .filter(|id| !id.is_empty())
        .unwrap_or(root_user.id.as_str())
        .to_string();
    let existing = list_message_revisions(db, session_id, &stable_root)?;
    let stamped = root_user.active_revision.unwrap_or(0);
    let target = if stamped > 0 {
        existing
            .iter()
            .find(|revision| revision.revision_index == stamped)
    } else {
        existing.iter().find(|revision| revision.is_active)
    };
    if let Some(target) = target {
        refresh_message_revision(
            db,
            session_id,
            &stable_root,
            target.revision_index,
            discarded,
        )?;
    } else {
        save_message_revision(db, session_id, &stable_root, discarded, false)?;
    }
    let count = list_message_revisions(db, session_id, &stable_root)?.len() as i64;
    Ok(Some(TruncateRevisionMeta {
        root_user_id: stable_root,
        revision_count: count + 1,
        active_revision: count + 1,
    }))
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MessageRevisionSummary {
    pub revision_index: i64,
    pub is_active: bool,
    pub created_at: String,
    pub message_count: i64,
}

/// Persist a discarded (or current) regenerate branch for a user root turn.
/// The branch payload goes to the append-only revisions file; SQLite keeps
/// the index row (identity, ordering, active flag, count).
pub fn save_message_revision(
    db: &Database,
    session_id: &str,
    root_user_id: &str,
    messages: &[UiMessage],
    make_active: bool,
) -> Result<MessageRevisionSummary> {
    if root_user_id.trim().is_empty() {
        return Err(anyhow!("rootUserId required"));
    }
    if messages.is_empty() {
        return Err(anyhow!("messages required"));
    }
    let conn = db.conn();
    let next_index: i64 = conn
        .query_row(
            "SELECT COALESCE(MAX(revision_index), 0) + 1
             FROM message_revisions
             WHERE session_id = ?1 AND root_user_id = ?2",
            params![session_id, root_user_id],
            |row| row.get(0),
        )
        .unwrap_or(1);
    let created = now_ms();
    let (records, _) = records_and_texts(messages);
    let turns = owning_turns_for(db, session_id, messages)?;
    transcripts::append_revision(
        db.data_dir(),
        session_id,
        &RevisionRecord {
            root_user_id: root_user_id.to_string(),
            revision_index: next_index,
            created_at: ms_to_ts(created),
            messages: records,
            compactions: Some(transcripts::read_compactions(db.data_dir(), session_id)?),
            turns,
        },
    )?;
    let tx = conn.unchecked_transaction()?;
    if make_active {
        tx.prepare_cached(
            "UPDATE message_revisions
             SET is_active = 0
             WHERE session_id = ?1 AND root_user_id = ?2",
        )?
        .execute(params![session_id, root_user_id])?;
    }
    let id = Uuid::new_v4().to_string();
    tx.prepare_cached(
        "INSERT INTO message_revisions (
            id, session_id, root_user_id, revision_index, is_active, message_count, created_at
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
    )?
    .execute(params![
        id,
        session_id,
        root_user_id,
        next_index,
        if make_active { 1 } else { 0 },
        messages.len() as i64,
        created
    ])?;
    tx.commit()?;
    Ok(MessageRevisionSummary {
        revision_index: next_index,
        is_active: make_active,
        created_at: ms_to_ts(created),
        message_count: messages.len() as i64,
    })
}

/// Owning turn per message id, for the messages of one branch. The turn is
/// index-row state, so an archived branch carries it explicitly.
fn owning_turns_for(
    db: &Database,
    session_id: &str,
    messages: &[UiMessage],
) -> Result<HashMap<String, String>> {
    let mut stmt = db.conn().prepare_cached(
        "SELECT id, turn_id FROM messages
         WHERE session_id = ?1 AND turn_id IS NOT NULL",
    )?;
    let rows = stmt.query_map(params![session_id], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
    })?;
    let mut all: HashMap<String, String> = HashMap::new();
    for row in rows {
        let (id, turn_id) = row?;
        all.insert(id, turn_id);
    }
    Ok(messages
        .iter()
        .filter_map(|message| {
            all.remove(&message.id)
                .map(|turn_id| (message.id.clone(), turn_id))
        })
        .collect())
}

/// Re-archive an existing revision with the branch as it stands now.
///
/// A branch keeps growing after its first archive: every later prompt appends
/// to it, and error-ended turns never reach the agent_end archive at all. The
/// revisions file is append-only and `read_revision` takes the last record for
/// a (root, index) pair, so a refresh is one more line plus a count update, and
/// the DB stamp (identity, ordering, active flag) is untouched.
pub fn refresh_message_revision(
    db: &Database,
    session_id: &str,
    root_user_id: &str,
    revision_index: i64,
    messages: &[UiMessage],
) -> Result<MessageRevisionSummary> {
    if messages.is_empty() {
        return Err(anyhow!("messages required"));
    }
    let conn = db.conn();
    let (is_active, created): (i64, i64) = conn
        .query_row(
            "SELECT is_active, created_at FROM message_revisions
             WHERE session_id = ?1 AND root_user_id = ?2 AND revision_index = ?3",
            params![session_id, root_user_id, revision_index],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?
        .ok_or_else(|| anyhow!("revision not found"))?;
    let (records, _) = records_and_texts(messages);
    let turns = owning_turns_for(db, session_id, messages)?;
    transcripts::append_revision(
        db.data_dir(),
        session_id,
        &RevisionRecord {
            root_user_id: root_user_id.to_string(),
            revision_index,
            created_at: ms_to_ts(created),
            messages: records,
            compactions: Some(transcripts::read_compactions(db.data_dir(), session_id)?),
            turns,
        },
    )?;
    conn.prepare_cached(
        "UPDATE message_revisions SET message_count = ?4
         WHERE session_id = ?1 AND root_user_id = ?2 AND revision_index = ?3",
    )?
    .execute(params![
        session_id,
        root_user_id,
        revision_index,
        messages.len() as i64
    ])?;
    Ok(MessageRevisionSummary {
        revision_index,
        is_active: is_active != 0,
        created_at: ms_to_ts(created),
        message_count: messages.len() as i64,
    })
}

/// Record a branch that is still live as revision `revision_index` of its user
/// root, without copying its messages: while the branch is live the transcript
/// *is* the payload, so the file gets its identity and turn attribution, and
/// the index row gets the count the pager reads.
///
/// The line is written before the index transaction, like every other
/// transcript write, so a crash between the two costs an index row rather than
/// content.
fn save_live_branch_revision(
    db: &Database,
    session_id: &str,
    root_user_id: &str,
    revision_index: i64,
    branch: &[UiMessage],
) -> Result<MessageRevisionSummary> {
    let conn = db.conn();
    let existing: Option<(i64, bool)> = conn
        .query_row(
            "SELECT created_at, is_active FROM message_revisions
             WHERE session_id = ?1 AND root_user_id = ?2 AND revision_index = ?3",
            params![session_id, root_user_id, revision_index],
            |row| Ok((row.get(0)?, row.get::<_, i64>(1)? != 0)),
        )
        .optional()?;
    let created = existing.map_or_else(now_ms, |(created, _)| created);
    let is_active = existing.is_none_or(|(_, is_active)| is_active);
    transcripts::append_live_revision(
        db.data_dir(),
        session_id,
        &transcripts::LiveRevisionRecord {
            root_user_id: root_user_id.to_string(),
            revision_index,
            created_at: ms_to_ts(created),
        },
    )?;
    let tx = conn.unchecked_transaction()?;
    if existing.is_some() {
        tx.prepare_cached(
            "UPDATE message_revisions SET message_count = ?4
             WHERE session_id = ?1 AND root_user_id = ?2 AND revision_index = ?3",
        )?
        .execute(params![
            session_id,
            root_user_id,
            revision_index,
            branch.len() as i64
        ])?;
    } else {
        tx.prepare_cached(
            "UPDATE message_revisions SET is_active = 0
             WHERE session_id = ?1 AND root_user_id = ?2",
        )?
        .execute(params![session_id, root_user_id])?;
        tx.prepare_cached(
            "INSERT INTO message_revisions (
                id, session_id, root_user_id, revision_index, is_active, message_count, created_at
             ) VALUES (?1, ?2, ?3, ?4, 1, ?5, ?6)",
        )?
        .execute(params![
            Uuid::new_v4().to_string(),
            session_id,
            root_user_id,
            revision_index,
            branch.len() as i64,
            created
        ])?;
    }
    tx.commit()?;
    Ok(MessageRevisionSummary {
        revision_index,
        is_active,
        created_at: ms_to_ts(created),
        message_count: branch.len() as i64,
    })
}

/// Where a revision family starts in the live transcript: the root itself, or
/// (after a regenerate gave the live prompt a new id) the first user message
/// stamped with that family key.
pub(super) fn live_branch_start(messages: &[UiMessage], root_user_id: &str) -> Option<usize> {
    messages
        .iter()
        .position(|message| message.id == root_user_id)
        .or_else(|| {
            messages.iter().position(|message| {
                message.role == "user" && message.revision_root_id.as_deref() == Some(root_user_id)
            })
        })
}

/// Write the live branch of `root_user_id` back over the revision it belongs to
/// before a switch replaces it. Anything appended since the last archive
/// (later prompts, error-ended turns that never hit agent_end) would otherwise
/// vanish the moment the user pages away and back.
///
/// This is also what turns a live reference back into a stored payload: while
/// the branch is live the revisions file holds no copy of it, and this call
/// writes one before the switch below takes the branch away.
///
/// Returns the branch start in `live` when the family is present at all.
fn archive_live_branch(
    db: &Database,
    session_id: &str,
    root_user_id: &str,
    live: &[UiMessage],
) -> Result<Option<usize>> {
    let Some(start) = live_branch_start(live, root_user_id) else {
        return Ok(None);
    };
    let branch = &live[start..];
    if branch.is_empty() {
        return Ok(Some(start));
    }
    let existing = list_message_revisions(db, session_id, root_user_id)?;
    // The stamp on the live root names the variant this branch is. It beats
    // the DB active flag, which only moves on agent_end: after a regenerate
    // whose turn failed, the DB still points at the previous variant, and
    // refreshing that would bury the previous branch under this one.
    let stamped = live[start].active_revision.unwrap_or(0);
    let target = if stamped > 0 {
        existing
            .iter()
            .find(|revision| revision.revision_index == stamped)
    } else {
        existing.iter().find(|revision| revision.is_active)
    }
    .map(|revision| revision.revision_index);
    match target {
        Some(index) => {
            refresh_message_revision(db, session_id, root_user_id, index, branch)?;
        }
        None => {
            // Stamped but never archived (or never stamped at all): the live
            // tail is a variant of its own.
            save_message_revision(db, session_id, root_user_id, branch, true)?;
        }
    }
    Ok(Some(start))
}

pub fn list_message_revisions(
    db: &Database,
    session_id: &str,
    root_user_id: &str,
) -> Result<Vec<MessageRevisionSummary>> {
    let mut stmt = db.conn().prepare_cached(
        "SELECT revision_index, is_active, created_at, message_count
         FROM message_revisions
         WHERE session_id = ?1 AND root_user_id = ?2
         ORDER BY revision_index ASC",
    )?;
    let rows = stmt.query_map(params![session_id, root_user_id], |row| {
        Ok(MessageRevisionSummary {
            revision_index: row.get(0)?,
            is_active: row.get::<_, i64>(1)? != 0,
            created_at: ms_to_ts(row.get(2)?),
            message_count: row.get(3)?,
        })
    })?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row?);
    }
    Ok(out)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActiveRevisionSave {
    pub root_user_id: String,
    pub revision_count: i64,
    pub active_revision: i64,
    /// False when the branch was already archived and only the stamp was refreshed.
    pub archived: bool,
    /// The user root as it now stands on disk, for the renderer's pager.
    pub root: UiMessage,
}

/// Archive the branch that just finished as the active revision of its user
/// root, then stamp that root with the pager metadata.
///
/// This exists as one host call on purpose. Doing it from the app process meant
/// `session.get` -> `session.replaceMessages`, and that round trip raced the
/// same turn's final assistant message still draining the app's persistence
/// outbox: the stale snapshot went back to disk and deleted the answer. Here the
/// read, the archive and the stamp all happen under the RPC lock, and the stamp
/// rewrites one line instead of the whole transcript.
///
/// Returns `None` when the latest user turn owns no regenerate history, which is
/// every session that was never regenerated.
pub fn save_active_branch_revision(
    db: &Database,
    session_id: &str,
) -> Result<Option<ActiveRevisionSave>> {
    let Some(detail) = get_session(db, session_id)? else {
        return Ok(None);
    };
    let mut messages = detail.messages;
    let Some(root_index) = messages
        .iter()
        .rposition(|message| message.role == "user" && message.revision_count.is_some())
    else {
        return Ok(None);
    };
    let root_user_id = messages[root_index]
        .revision_root_id
        .clone()
        .unwrap_or_else(|| messages[root_index].id.clone());

    let existing = list_message_revisions(db, session_id, &root_user_id)?;
    let desired_active = messages[root_index].active_revision.unwrap_or(0);
    let already_archived = existing
        .iter()
        .any(|revision| revision.revision_index == desired_active);
    let branch = &messages[root_index..];
    // The branch is still live, so the transcript already holds its payload and
    // this records a reference to it. Refreshing a stored copy here is what made
    // the file quadratic: the copy grew with the branch, so a session that ran N
    // turns wrote O(N²) bytes to restate what the transcript already said. A
    // branch leaves the transcript only through `archive_live_branch` or
    // `archive_discarded_regenerate_branch`, and both write the full copy first.
    let mut active = if already_archived {
        save_live_branch_revision(db, session_id, &root_user_id, desired_active, branch)?;
        desired_active
    } else {
        let next = existing
            .iter()
            .map(|revision| revision.revision_index)
            .max()
            .unwrap_or(0)
            + 1;
        save_live_branch_revision(db, session_id, &root_user_id, next, branch)?;
        next
    };
    let archived = !already_archived;
    let total = list_message_revisions(db, session_id, &root_user_id)?.len() as i64;
    if active < 1 {
        active = total;
    }

    let root = &mut messages[root_index];
    root.revision_root_id = Some(root_user_id.clone());
    root.revision_count = Some(total);
    root.active_revision = Some(active);
    let (record, _) = ui_to_record(root);
    transcripts::update_message(db.data_dir(), session_id, &record)?;
    Ok(Some(ActiveRevisionSave {
        root_user_id,
        revision_count: total,
        active_revision: active,
        archived,
        root: root.clone(),
    }))
}

/// Activate a stored revision: replace the live transcript with prefix + branch.
/// `prefix` is every message before the root user turn, as the renderer sees
/// it; the durable transcript wins over it whenever the family is found there.
pub fn activate_message_revision(
    db: &Database,
    session_id: &str,
    root_user_id: &str,
    revision_index: i64,
    prefix: &[UiMessage],
) -> Result<Vec<UiMessage>> {
    let session_created = session_created_at(db, session_id)?;
    {
        let conn = db.conn();
        let known: i64 = conn.query_row(
            "SELECT COUNT(*) FROM message_revisions
             WHERE session_id = ?1 AND root_user_id = ?2 AND revision_index = ?3",
            params![session_id, root_user_id, revision_index],
            |row| row.get(0),
        )?;
        if known == 0 {
            return Err(anyhow!("revision not found"));
        }
    }
    // The switch below throws the live branch away. Archive it first, from the
    // durable transcript rather than the renderer's copy, so every message that
    // landed since the last archive survives the round trip.
    let live = get_session(db, session_id)?
        .map(|detail| detail.messages)
        .unwrap_or_default();
    let live_start = archive_live_branch(db, session_id, root_user_id, &live)?;
    let prefix: &[UiMessage] = match live_start {
        Some(start) => &live[..start],
        None => prefix,
    };

    let payload =
        transcripts::read_revision(db.data_dir(), session_id, root_user_id, revision_index)?
            .ok_or_else(|| anyhow!("revision payload missing from revisions file"))?;
    let archived_turns = payload.turns().clone();
    let (branch, archived_compactions): (Vec<UiMessage>, _) = match payload {
        transcripts::RevisionPayload::Stored(record) => (
            record.messages.into_iter().map(record_to_ui).collect(),
            record.compactions,
        ),
        // The branch never left the transcript, so its messages are the live
        // suffix rooted at its user turn — the same slice `archive_live_branch`
        // measured one call ago, and the reason no copy of it is on disk.
        transcripts::RevisionPayload::Live(record) => {
            // The line names the family it belongs to; the slice below is only
            // that family's if the two agree.
            if record.root_user_id != root_user_id || record.revision_index != revision_index {
                return Err(anyhow!(
                    "revision payload names {}/{} not {root_user_id}/{revision_index}",
                    record.root_user_id,
                    record.revision_index
                ));
            }
            let start = live_start.ok_or_else(|| {
                anyhow!("revision payload missing from transcript for {root_user_id}")
            })?;
            (live.get(start..).unwrap_or_default().to_vec(), None)
        }
    };

    let conn = db.conn();
    let total: i64 = conn.query_row(
        "SELECT COUNT(*) FROM message_revisions
         WHERE session_id = ?1 AND root_user_id = ?2",
        params![session_id, root_user_id],
        |row| row.get(0),
    )?;
    // rebuild live messages = prefix + branch
    let mut combined = Vec::with_capacity(prefix.len() + branch.len());
    combined.extend_from_slice(prefix);
    combined.extend(branch);
    // Stamp revision meta on the branch's user root. After regenerate the live
    // prompt id may differ from the stable family key, so prefer an exact id
    // match and fall back to the first user message in the restored branch.
    let root_pos = combined
        .iter()
        .position(|m| m.id == root_user_id)
        .or_else(|| {
            combined
                .iter()
                .skip(prefix.len())
                .position(|m| m.role == "user")
                .map(|rel| prefix.len() + rel)
        });
    if let Some(pos) = root_pos {
        if let Some(root) = combined.get_mut(pos) {
            root.revision_root_id = Some(root_user_id.to_string());
            root.revision_count = Some(total);
            root.active_revision = Some(revision_index);
        }
    }

    let (records, texts) = records_and_texts(&combined);
    // Restore the target branch's own checkpoint chain. Reading only the live
    // transcript loses it permanently after a round trip through a short branch.
    // Legacy archives have no snapshot; retain the previous anchor-filtered
    // fallback for them. An explicit empty snapshot must not borrow another
    // branch's summary, even when their message ids happen to match.
    let compactions = match archived_compactions {
        Some(records) => records,
        None => transcripts::read_compactions(db.data_dir(), session_id)?,
    };
    let compactions: Vec<CompactionRecord> = compactions
        .into_iter()
        .filter(|record| compaction_valid_for_records(record, &records))
        .collect();
    // The switch drops everything the restored variant does not contain. Any
    // other family whose root is in that prefix was referenced rather than
    // copied while it was live, so it has to be stored in full before the
    // transcript stops holding it. The target family was archived above.
    archive_dropped_live_branches(
        db,
        session_id,
        &live,
        &combined,
        &[root_user_id.to_string()],
    )?;
    transcripts::write_transcript_with_compactions(
        db.data_dir(),
        session_id,
        &session_created,
        &records,
        &compactions,
    )?;
    // Reseating the index rows must carry each surviving message's owning turn
    // across, or the whole session loses its turn/token attribution on switch.
    let mut owning_turns: HashMap<String, String> = HashMap::new();
    {
        let mut stmt = conn.prepare_cached(
            "SELECT id, turn_id FROM messages
             WHERE session_id = ?1 AND turn_id IS NOT NULL",
        )?;
        let rows = stmt.query_map(params![session_id], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?;
        for row in rows {
            let (id, turn_id) = row?;
            owning_turns.insert(id, turn_id);
        }
    }
    // Restored messages left the index with the branch; their turns come back
    // from the archive. A live row's own turn is never overridden.
    for (id, turn_id) in archived_turns {
        owning_turns.entry(id).or_insert(turn_id);
    }
    let tx = conn.unchecked_transaction()?;
    tx.prepare_cached(
        "UPDATE message_revisions
         SET is_active = CASE WHEN revision_index = ?3 THEN 1 ELSE 0 END
         WHERE session_id = ?1 AND root_user_id = ?2",
    )?
    .execute(params![session_id, root_user_id, revision_index])?;
    tx.prepare_cached("DELETE FROM messages WHERE session_id = ?1")?
        .execute(params![session_id])?;
    for (seq, record) in records.iter().enumerate() {
        insert_index_row(
            &tx,
            session_id,
            seq as i64,
            owning_turns.get(&record.id).map(String::as_str),
            record,
            texts[seq].as_deref(),
        )?;
    }
    tx.prepare_cached("UPDATE sessions SET last_seq = ?1, updated_at = ?2 WHERE id = ?3")?
        .execute(params![records.len() as i64, now_ms(), session_id])?;
    tx.commit()?;
    Ok(combined)
}
