use crate::db::ts_to_ms;
use crate::transcripts::MessageRecord;
use anyhow::Result;
use rusqlite::params;
use serde_json::Value;

pub(crate) fn dedupe_records(records: Vec<MessageRecord>) -> Vec<MessageRecord> {
    let mut ordered: Vec<MessageRecord> = Vec::with_capacity(records.len());
    let mut by_id: std::collections::HashMap<String, usize> =
        std::collections::HashMap::with_capacity(records.len());
    for record in records {
        match by_id.get(&record.id) {
            Some(&pos) => ordered[pos] = record,
            None => {
                by_id.insert(record.id.clone(), ordered.len());
                ordered.push(record);
            }
        }
    }
    ordered
}

pub(crate) fn record_index_text(record: &MessageRecord) -> Option<String> {
    if record.role == "tool" {
        return None;
    }
    let text = record
        .blocks
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|block| {
            (block.get("type").and_then(Value::as_str) == Some("text"))
                .then(|| block.get("text").and_then(Value::as_str))
                .flatten()
        })
        .collect::<String>();
    (!text.is_empty()).then_some(text)
}

/// Insert one search/index row for a message whose content lives in the
/// transcript file.
pub(crate) fn insert_index_row(
    conn: &rusqlite::Connection,
    session_id: &str,
    seq: i64,
    turn_id: Option<&str>,
    record: &MessageRecord,
    text: Option<&str>,
) -> Result<()> {
    let mut stmt = conn.prepare_cached(
        "INSERT INTO messages (
            id, session_id, turn_id, seq, role, tool_name, is_error, text, created_at,
            streaming
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
    )?;
    stmt.execute(params![
        record.id,
        session_id,
        turn_id,
        seq,
        record.role,
        record.tool_name,
        record.is_error,
        text,
        ts_to_ms(&record.created_at),
        i64::from(record_is_streaming(record)),
    ])?;
    Ok(())
}

/// Whether a record's own metadata marks it as a provisional, streaming
/// assistant row.
///
/// The index stores this answer so the write path can ask "is this message still
/// streaming?" with one indexed lookup. The transcript remains the source of
/// truth: a rebuild recomputes the column from the file.
pub(super) fn record_is_streaming(record: &MessageRecord) -> bool {
    record.role == "assistant"
        && record
            .meta
            .as_ref()
            .and_then(|meta| meta.get("status"))
            .and_then(Value::as_str)
            == Some("streaming")
}
