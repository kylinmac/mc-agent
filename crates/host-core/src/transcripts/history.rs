//! mc-agent bounded history lookup for the model (R21.1,
//! docs/mc-agent/compaction-context-restore.md).
//!
//! After a compaction the model keeps only the summary and a recent tail. This
//! reads the visible transcript behind one checkpoint so the model can recover
//! an exact snippet the summary left out. It is a model-facing projection, not
//! the renderer's `session.get`: no thinking, no page-external parent rows, no
//! attachment bodies, and every read stays at or before the checkpoint.
//!
//! The caller runs this outside the host state lock. A concurrent append, a
//! rewrite (atomic rename) or a deletion is detected the same way the renderer
//! window reader detects it: positions are only used against the one layout
//! snapshot they came from, a stale offset fails the line-kind check and
//! `with_layout_recovery` rebuilds once. Cursors are stable message IDs, never
//! physical offsets, so a later page after a rewrite either resolves the same
//! message or reports the cursor as invalid.

use std::fs::File;
use std::io::BufReader;
use std::path::Path;
use std::time::{Duration, Instant};

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::layout::{with_layout_recovery, TranscriptLayout};
use super::{read_layout_line, transcript_path, CompactionRecord, MessageRecord};

pub const DEFAULT_LIMIT: usize = 20;
pub const MAX_LIMIT: usize = 50;
/// Messages a keyword search may inspect in one call before it stops and
/// hands back a cursor.
pub const MAX_SCAN_MESSAGES: usize = 2_000;
const SCAN_PAGE: usize = 200;
pub const DEFAULT_MESSAGE_CHARS: usize = 4_000;
pub const MAX_MESSAGE_CHARS: usize = 16_000;
/// Total text one call returns; roughly 6K tokens.
pub const MAX_OUTPUT_CHARS: usize = 24_000;
const TOOL_ARGS_CHARS: usize = 600;
const SCAN_TIME_BUDGET: Duration = Duration::from_secs(2);

#[derive(Debug, Clone, Default)]
pub struct HistoryRequest {
    /// Checkpoint to read behind; the newest one when absent.
    pub checkpoint_id: Option<String>,
    /// Return messages strictly older than this message.
    pub before: Option<String>,
    /// Return messages centred on this message.
    pub around: Option<String>,
    pub query: Option<String>,
    pub limit: usize,
    pub message_chars: usize,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum HistoryStatus {
    Ok,
    /// The session has no checkpoint (or not the requested one).
    NoCompaction,
    /// The cursor or anchor no longer resolves inside the checkpoint range.
    CursorInvalid,
    /// The anchor is after the checkpoint boundary.
    OutOfRange,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryMessage {
    pub id: String,
    pub role: String,
    pub created_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_name: Option<String>,
    pub text: String,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub truncated: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryResponse {
    pub status: HistoryStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub checkpoint_id: Option<String>,
    pub messages: Vec<HistoryMessage>,
    /// Messages inspected by this call, matching or not.
    pub scanned: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub scanned_from_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub scanned_to_id: Option<String>,
    /// The scan reached the first message of the session.
    pub reached_start: bool,
    /// Pass as `before` to continue with older messages.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub next_before: Option<String>,
    /// The keyword scan stopped on its message, size or time budget.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub scan_limited: bool,
    /// Matching messages were dropped to keep the output under its budget.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub output_truncated: bool,
}

impl HistoryResponse {
    fn status(status: HistoryStatus, checkpoint_id: Option<String>) -> Self {
        Self {
            status,
            checkpoint_id,
            messages: Vec::new(),
            scanned: 0,
            scanned_from_id: None,
            scanned_to_id: None,
            reached_start: false,
            next_before: None,
            scan_limited: false,
            output_truncated: false,
        }
    }
}

pub fn read_history(
    data_dir: &Path,
    session_id: &str,
    request: &HistoryRequest,
) -> Result<HistoryResponse> {
    let path = transcript_path(data_dir, session_id)?;
    if !path.exists() {
        return Ok(HistoryResponse::status(HistoryStatus::NoCompaction, None));
    }
    with_layout_recovery(data_dir, session_id, |layout| {
        read_with_layout(&path, layout, request)
    })
}

fn read_with_layout(
    path: &Path,
    layout: &TranscriptLayout,
    request: &HistoryRequest,
) -> Result<HistoryResponse> {
    let file = match File::open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(HistoryResponse::status(HistoryStatus::NoCompaction, None));
        }
        Err(error) => return Err(error).with_context(|| format!("read {}", path.display())),
    };
    let mut reader = LineReader::new(BufReader::new(file));
    let Some(checkpoint) = find_checkpoint(&mut reader, layout, request.checkpoint_id.as_deref())?
    else {
        return Ok(HistoryResponse::status(
            HistoryStatus::NoCompaction,
            request.checkpoint_id.clone(),
        ));
    };
    let checkpoint_id = Some(checkpoint.id.clone());
    let Some(through) = reader.position_of(layout, &checkpoint.through_message_id, None)? else {
        return Ok(HistoryResponse::status(
            HistoryStatus::CursorInvalid,
            checkpoint_id,
        ));
    };
    let bound = through + 1;
    let limit = request.limit.clamp(1, MAX_LIMIT);
    let message_chars = request.message_chars.clamp(200, MAX_MESSAGE_CHARS);

    let end = if let Some(anchor) = request.around.as_deref() {
        match reader.position_of(layout, anchor, None)? {
            Some(position) if position < bound => (position + limit / 2 + 1).min(bound),
            Some(_) => {
                return Ok(HistoryResponse::status(
                    HistoryStatus::OutOfRange,
                    checkpoint_id,
                ))
            }
            None => {
                return Ok(HistoryResponse::status(
                    HistoryStatus::CursorInvalid,
                    checkpoint_id,
                ))
            }
        }
    } else if let Some(cursor) = request.before.as_deref() {
        match reader.position_of(layout, cursor, Some(bound))? {
            Some(position) => position,
            None => {
                return Ok(HistoryResponse::status(
                    HistoryStatus::CursorInvalid,
                    checkpoint_id,
                ))
            }
        }
    } else {
        bound
    };

    let query = request
        .query
        .as_deref()
        .map(str::trim)
        .filter(|query| !query.is_empty())
        .map(str::to_lowercase);
    let started = Instant::now();
    let mut response = HistoryResponse::status(HistoryStatus::Ok, checkpoint_id);
    // Collected newest first while walking backwards, reversed at the end.
    let mut collected: Vec<HistoryMessage> = Vec::new();
    let mut output_chars = 0usize;
    let mut cursor = end;
    let mut oldest_scanned: Option<String> = None;
    let mut newest_scanned: Option<String> = None;
    'scan: while cursor > 0 {
        let page = if query.is_some() { SCAN_PAGE } else { limit };
        let start = cursor.saturating_sub(page);
        let records = reader.read_messages(layout, start, cursor)?;
        for (position, record) in records.into_iter().rev() {
            if query.is_some() && response.scanned >= MAX_SCAN_MESSAGES
                || started.elapsed() > SCAN_TIME_BUDGET
            {
                response.scan_limited = true;
                break 'scan;
            }
            cursor = position;
            response.scanned += 1;
            if newest_scanned.is_none() {
                newest_scanned = Some(record.id.clone());
            }
            oldest_scanned = Some(record.id.clone());
            let Some(message) = project(record, message_chars) else {
                continue;
            };
            if let Some(query) = &query {
                if !message.text.to_lowercase().contains(query) {
                    continue;
                }
            }
            if output_chars + message.text.len() > MAX_OUTPUT_CHARS && !collected.is_empty() {
                response.output_truncated = true;
                // This message is not returned; the next page starts with it.
                cursor = position + 1;
                break 'scan;
            }
            output_chars += message.text.len();
            collected.push(message);
            if collected.len() >= limit {
                break 'scan;
            }
        }
        if query.is_none() {
            break;
        }
    }
    collected.reverse();
    response.messages = collected;
    response.scanned_from_id = oldest_scanned;
    response.scanned_to_id = newest_scanned;
    response.reached_start = cursor == 0;
    if cursor > 0 {
        // The oldest message this call consumed (or stopped at); older ones
        // follow on the next page.
        response.next_before = reader
            .read_messages(layout, cursor, cursor + 1)?
            .into_iter()
            .next()
            .map(|(_, record)| record.id);
    }
    Ok(response)
}

/// Model-facing projection. Returns `None` for rows the model never saw as
/// part of this conversation: delegated sub-agent internals and system rows.
fn project(record: MessageRecord, message_chars: usize) -> Option<HistoryMessage> {
    let meta = record.meta.as_ref();
    if meta
        .and_then(|meta| meta.get("parentToolCallId"))
        .and_then(Value::as_str)
        .is_some()
    {
        return None;
    }
    let blocks = record.blocks.as_array().cloned().unwrap_or_default();
    let text = match record.role.as_str() {
        "user" | "assistant" => {
            let mut parts: Vec<String> = blocks
                .iter()
                .filter(|block| block.get("type").and_then(Value::as_str) == Some("text"))
                .filter_map(|block| block.get("text").and_then(Value::as_str))
                .map(str::to_string)
                .collect();
            for block in &blocks {
                if block.get("type").and_then(Value::as_str) == Some("attachment") {
                    let name = block.get("name").and_then(Value::as_str).unwrap_or("file");
                    parts.push(format!("[attachment: {name}]"));
                }
            }
            parts.join("\n")
        }
        "tool" => {
            let call = blocks
                .iter()
                .find(|block| block.get("type").and_then(Value::as_str) == Some("tool_call"));
            let args = call
                .and_then(|call| call.get("args"))
                .map(|args| clip(&args.to_string(), TOOL_ARGS_CHARS).0)
                .unwrap_or_default();
            let result = call
                .and_then(|call| call.get("result").or_else(|| call.get("text")))
                .map(|value| match value {
                    Value::String(text) => text.clone(),
                    other => other.to_string(),
                })
                .unwrap_or_default();
            format!("args: {args}\nresult: {result}")
        }
        _ => return None,
    };
    let (text, truncated) = clip(&text, message_chars);
    Some(HistoryMessage {
        id: record.id,
        role: record.role,
        created_at: record.created_at,
        tool_name: record.tool_name,
        text,
        truncated,
    })
}

fn clip(text: &str, max_chars: usize) -> (String, bool) {
    match text.char_indices().nth(max_chars) {
        Some((index, _)) => (format!("{}…", &text[..index]), true),
        None => (text.to_string(), false),
    }
}

fn find_checkpoint(
    reader: &mut LineReader,
    layout: &TranscriptLayout,
    checkpoint_id: Option<&str>,
) -> Result<Option<CompactionRecord>> {
    for offset in layout.compaction_offsets.iter().rev() {
        let line = reader.line(*offset, "compaction")?;
        let Ok(record) = serde_json::from_str::<CompactionRecord>(line) else {
            continue;
        };
        match checkpoint_id {
            Some(id) if record.id != id => continue,
            _ => return Ok(Some(record)),
        }
    }
    Ok(None)
}

struct LineReader {
    reader: BufReader<File>,
    raw: Vec<u8>,
    line: String,
}

impl LineReader {
    fn new(reader: BufReader<File>) -> Self {
        Self {
            reader,
            raw: Vec::new(),
            line: String::new(),
        }
    }

    fn line(&mut self, offset: u64, kind: &str) -> Result<&str> {
        read_layout_line(
            &mut self.reader,
            offset,
            kind,
            &mut self.raw,
            &mut self.line,
        )?;
        Ok(self.line.trim())
    }

    /// Last physical position of a message ID (last write wins), optionally
    /// only below `bound`.
    fn position_of(
        &mut self,
        layout: &TranscriptLayout,
        message_id: &str,
        bound: Option<usize>,
    ) -> Result<Option<usize>> {
        #[derive(Deserialize)]
        struct Identity {
            id: String,
        }
        let limit = bound
            .unwrap_or(layout.message_count())
            .min(layout.message_count());
        for position in (0..limit).rev() {
            let line = self.line(layout.message_offsets[position], "message")?;
            if serde_json::from_str::<Identity>(line)
                .is_ok_and(|identity| identity.id == message_id)
            {
                return Ok(Some(position));
            }
        }
        Ok(None)
    }

    /// Records at physical positions `[start, end)`, in file order. A later
    /// line with the same ID inside the window replaces the earlier one.
    fn read_messages(
        &mut self,
        layout: &TranscriptLayout,
        start: usize,
        end: usize,
    ) -> Result<Vec<(usize, MessageRecord)>> {
        let end = end.min(layout.message_count());
        let mut out: Vec<(usize, MessageRecord)> = Vec::with_capacity(end.saturating_sub(start));
        for position in start..end {
            let line = self.line(layout.message_offsets[position], "message")?;
            let Ok(record) = serde_json::from_str::<MessageRecord>(line) else {
                tracing::warn!("skipping undecodable transcript message in history lookup");
                continue;
            };
            out.retain(|(_, existing)| existing.id != record.id);
            out.push((position, record));
        }
        Ok(out)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::transcripts::{append_compaction, append_message, write_transcript};
    use serde_json::json;

    const CREATED: &str = "2026-10-30T00:00:00Z";

    fn message(id: &str, role: &str, text: &str) -> MessageRecord {
        MessageRecord {
            id: id.into(),
            role: role.into(),
            tool_name: None,
            is_error: false,
            blocks: json!([{ "type": "text", "text": text }, { "type": "thinking", "text": "secret reasoning" }]),
            meta: None,
            created_at: CREATED.into(),
        }
    }

    fn checkpoint(id: &str, through: &str) -> CompactionRecord {
        CompactionRecord {
            id: id.into(),
            summary: "summary".into(),
            first_kept_message_id: None,
            through_message_id: through.into(),
            tokens_before: 1,
            usage: None,
            retained_tail: None,
            details: None,
            provider_id: None,
            model_id: None,
            created_at: CREATED.into(),
        }
    }

    fn seed(dir: &Path, count: usize, through: usize) {
        for index in 0..count {
            append_message(
                dir,
                "s",
                CREATED,
                &message(&format!("m{index}"), "user", &format!("text {index}")),
            )
            .unwrap();
            if index == through {
                append_compaction(dir, "s", CREATED, &checkpoint("c1", &format!("m{index}")))
                    .unwrap();
            }
        }
    }

    fn request() -> HistoryRequest {
        HistoryRequest {
            limit: 5,
            message_chars: DEFAULT_MESSAGE_CHARS,
            ..HistoryRequest::default()
        }
    }

    fn ids(response: &HistoryResponse) -> Vec<&str> {
        response
            .messages
            .iter()
            .map(|message| message.id.as_str())
            .collect()
    }

    #[test]
    fn reports_no_compaction_without_a_checkpoint() {
        let dir = tempfile::tempdir().unwrap();
        append_message(dir.path(), "s", CREATED, &message("m0", "user", "hi")).unwrap();
        let response = read_history(dir.path(), "s", &request()).unwrap();
        assert_eq!(response.status, HistoryStatus::NoCompaction);
        assert!(read_history(dir.path(), "missing", &request())
            .unwrap()
            .messages
            .is_empty());
    }

    #[test]
    fn pages_backwards_from_the_checkpoint_boundary_and_hides_reasoning() {
        let dir = tempfile::tempdir().unwrap();
        seed(dir.path(), 20, 11);
        let first = read_history(dir.path(), "s", &request()).unwrap();
        assert_eq!(first.status, HistoryStatus::Ok);
        assert_eq!(ids(&first), ["m7", "m8", "m9", "m10", "m11"]);
        assert_eq!(first.next_before.as_deref(), Some("m7"));
        assert!(!first.reached_start);
        assert!(first
            .messages
            .iter()
            .all(|message| !message.text.contains("secret reasoning")));
        let second = read_history(
            dir.path(),
            "s",
            &HistoryRequest {
                before: first.next_before.clone(),
                ..request()
            },
        )
        .unwrap();
        assert_eq!(ids(&second), ["m2", "m3", "m4", "m5", "m6"]);
        let last = read_history(
            dir.path(),
            "s",
            &HistoryRequest {
                before: second.next_before.clone(),
                ..request()
            },
        )
        .unwrap();
        assert_eq!(ids(&last), ["m0", "m1"]);
        assert!(last.reached_start);
        assert_eq!(last.next_before, None);
    }

    #[test]
    fn around_never_returns_messages_after_the_boundary() {
        let dir = tempfile::tempdir().unwrap();
        seed(dir.path(), 20, 11);
        let response = read_history(
            dir.path(),
            "s",
            &HistoryRequest {
                around: Some("m11".into()),
                ..request()
            },
        )
        .unwrap();
        assert_eq!(ids(&response), ["m7", "m8", "m9", "m10", "m11"]);
        let after = read_history(
            dir.path(),
            "s",
            &HistoryRequest {
                around: Some("m15".into()),
                ..request()
            },
        )
        .unwrap();
        assert_eq!(after.status, HistoryStatus::OutOfRange);
        assert!(after.messages.is_empty());
        let cursor = read_history(
            dir.path(),
            "s",
            &HistoryRequest {
                before: Some("m15".into()),
                ..request()
            },
        )
        .unwrap();
        assert_eq!(cursor.status, HistoryStatus::CursorInvalid);
    }

    #[test]
    fn keyword_search_distinguishes_no_match_from_an_incomplete_scan() {
        let dir = tempfile::tempdir().unwrap();
        seed(dir.path(), 30, 25);
        let hit = read_history(
            dir.path(),
            "s",
            &HistoryRequest {
                query: Some("TEXT 3".into()),
                ..request()
            },
        )
        .unwrap();
        assert_eq!(ids(&hit), ["m3"]);
        assert!(hit.reached_start && !hit.scan_limited);
        let miss = read_history(
            dir.path(),
            "s",
            &HistoryRequest {
                query: Some("absent".into()),
                ..request()
            },
        )
        .unwrap();
        assert!(miss.messages.is_empty() && miss.reached_start && !miss.scan_limited);
        assert_eq!(miss.scanned, 26);
    }

    #[test]
    fn excludes_subagent_rows_and_clips_large_bodies() {
        let dir = tempfile::tempdir().unwrap();
        let mut nested = message("child", "assistant", "inner work");
        nested.meta = Some(json!({ "parentToolCallId": "call-1" }));
        append_message(
            dir.path(),
            "s",
            CREATED,
            &message("m0", "user", &"x".repeat(5_000)),
        )
        .unwrap();
        append_message(dir.path(), "s", CREATED, &nested).unwrap();
        let tool = MessageRecord {
            id: "t0".into(),
            role: "tool".into(),
            tool_name: Some("Read".into()),
            is_error: false,
            blocks: json!([{ "type": "tool_call", "callId": "call-2", "args": { "path": "/w/a.rs" }, "result": "fn main() {}" }]),
            meta: None,
            created_at: CREATED.into(),
        };
        append_message(dir.path(), "s", CREATED, &tool).unwrap();
        append_compaction(dir.path(), "s", CREATED, &checkpoint("c1", "t0")).unwrap();
        let response = read_history(
            dir.path(),
            "s",
            &HistoryRequest {
                message_chars: 1_000,
                ..request()
            },
        )
        .unwrap();
        assert_eq!(ids(&response), ["m0", "t0"]);
        assert!(response.messages[0].truncated);
        assert!(response.messages[0].text.chars().count() <= 1_001);
        assert!(
            response.messages[1].text.contains("/w/a.rs")
                && response.messages[1].text.contains("fn main")
        );
    }

    #[test]
    fn an_older_checkpoint_keeps_its_own_boundary() {
        let dir = tempfile::tempdir().unwrap();
        seed(dir.path(), 10, 3);
        append_compaction(dir.path(), "s", CREATED, &checkpoint("c2", "m8")).unwrap();
        let newest = read_history(dir.path(), "s", &request()).unwrap();
        assert_eq!(newest.checkpoint_id.as_deref(), Some("c2"));
        assert_eq!(ids(&newest).last(), Some(&"m8"));
        let older = read_history(
            dir.path(),
            "s",
            &HistoryRequest {
                checkpoint_id: Some("c1".into()),
                ..request()
            },
        )
        .unwrap();
        assert_eq!(ids(&older), ["m0", "m1", "m2", "m3"]);
        let gone = read_history(
            dir.path(),
            "s",
            &HistoryRequest {
                checkpoint_id: Some("c9".into()),
                ..request()
            },
        )
        .unwrap();
        assert_eq!(gone.status, HistoryStatus::NoCompaction);
    }

    #[test]
    fn a_rewritten_transcript_invalidates_cursors_instead_of_reusing_offsets() {
        let dir = tempfile::tempdir().unwrap();
        seed(dir.path(), 12, 9);
        let first = read_history(dir.path(), "s", &request()).unwrap();
        let cursor = first.next_before.clone().unwrap();
        // Atomic rewrite with different message IDs and the same checkpoint.
        let replaced: Vec<MessageRecord> = (0..12)
            .map(|index| message(&format!("n{index}"), "user", "new"))
            .collect();
        write_transcript(dir.path(), "s", CREATED, &replaced).unwrap();
        append_compaction(dir.path(), "s", CREATED, &checkpoint("c1", "n9")).unwrap();
        let next = read_history(
            dir.path(),
            "s",
            &HistoryRequest {
                before: Some(cursor),
                ..request()
            },
        )
        .unwrap();
        assert_eq!(next.status, HistoryStatus::CursorInvalid);
        let fresh = read_history(dir.path(), "s", &request()).unwrap();
        assert_eq!(ids(&fresh), ["n5", "n6", "n7", "n8", "n9"]);
    }
}
