use rusqlite::params;
use serde_json::json;
use uuid::Uuid;

use crate::db::{ts_to_ms, Database};

use crate::transcripts::{self, CompactionRecord};

use super::append::streaming_assistant_indexed;
use super::index::record_is_streaming;
use super::recovery::session_created_at;
use super::revisions::live_branch_start;
use super::titles::is_default_title;

mod display;
mod fork;
mod index;
mod lifecycle;
mod messages;
mod recovery;
mod revisions;
mod titles;
mod usage;

use super::*;

use crate::workspace::simple_canonicalize;

pub(super) fn test_db() -> Database {
    let dir = std::env::temp_dir().join(format!("pi-desktop-test-{}", Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    Database::open(&dir.join("test.sqlite")).unwrap()
}

pub(super) fn user_msg(id: &str, content: &str, ts: &str) -> UiMessage {
    UiMessage {
        id: id.into(),
        role: "user".into(),
        content: content.into(),
        command: None,
        skill_mentions: None,
        attachments: None,
        voice_origin: None,
        steering: None,
        created_at: ts.into(),
        thinking: None,
        status: None,
        model_id: None,
        provider_id: None,
        usage: None,
        response_duration_ms: None,
        response_output_tokens: None,
        stop_reason: None,
        error: None,
        revision_root_id: None,
        revision_count: None,
        active_revision: None,
        tool_name: None,
        tool_call_id: None,
        tool_status: None,
        tool_args: None,
        tool_result: None,
        tool_completed_at: None,
        tool_duration_ms: None,
        is_error: None,
        parent_tool_call_id: None,
        nested_parent_tool_call_id: None,
        agent_name: None,
        hosted_search: None,
        model_system: None,
        session_message: None,
    }
}

/// A failed transcript device flush must not leave an index row that makes
/// replay of the same append a no-op.
#[cfg(unix)]
#[tokio::test]
async fn a_failed_transcript_flush_can_be_retried_without_a_phantom_index() {
    use std::os::unix::fs::symlink;

    let db = test_db();
    let session = create_session(&db, None, None, None, None, None).unwrap();
    let transcript_path = transcripts::transcript_path(db.data_dir(), &session.id).unwrap();
    if transcript_path.exists() {
        std::fs::remove_file(&transcript_path).unwrap();
    }
    std::fs::create_dir_all(transcript_path.parent().unwrap()).unwrap();
    symlink("/dev/null", &transcript_path).unwrap();

    let message = user_msg("retry-after-flush-failure", "body", "2025-05-01T00:00:00Z");
    let (written, committed) =
        transcripts::commit_writes_of(async { append_message(&db, &session.id, &message, None) })
            .await;
    assert!(
        written.is_err() || committed.is_err(),
        "the append must report the device flush failure"
    );

    std::fs::remove_file(&transcript_path).unwrap();
    let (retried, committed) =
        transcripts::commit_writes_of(async { append_message(&db, &session.id, &message, None) })
            .await;
    retried.expect("retry should append after the device recovers");
    committed.expect("retry should commit its durable transcript line");

    let records = transcripts::read_transcript(db.data_dir(), &session.id).unwrap();
    let index_count: i64 = db
        .conn()
        .query_row(
            "SELECT COUNT(*) FROM messages WHERE session_id = ?1 AND id = ?2",
            params![session.id, message.id],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(
        records
            .iter()
            .filter(|record| record.id == message.id)
            .count(),
        1,
        "the canonical transcript should hold the retried message once"
    );
    assert_eq!(
        index_count, 1,
        "the index should hold the retried message once"
    );
}

pub(super) fn checkpoint(first: &str, through: &str) -> CompactionRecord {
    CompactionRecord {
        id: Uuid::new_v4().to_string(),
        summary: "durable summary".into(),
        first_kept_message_id: Some(first.into()),
        through_message_id: through.into(),
        tokens_before: 120_000,
        usage: None,
        retained_tail: Some(json!([{
            "role": "user",
            "content": "recent",
            "timestamp": 1
        }])),
        details: None,
        provider_id: Some("provider-1".into()),
        model_id: Some("model-1".into()),
        created_at: "2026-07-28T00:00:03Z".into(),
    }
}

pub(super) fn streaming_assistant(id: &str, content: &str) -> UiMessage {
    let mut message = user_msg(id, content, "2025-05-01T00:00:01Z");
    message.role = "assistant".into();
    message.status = Some("streaming".into());
    message.thinking = Some("still thinking".into());
    message
}

pub(super) fn streaming_flag(db: &Database, id: &str) -> Option<i64> {
    db.conn()
        .query_row(
            "SELECT streaming FROM messages WHERE id = ?1",
            params![id],
            |row| row.get(0),
        )
        .unwrap()
}

pub(super) fn messages_have_streaming_column(db: &Database) -> bool {
    db.conn()
        .query_row(
            "SELECT EXISTS(
               SELECT 1 FROM pragma_table_info('messages') WHERE name = 'streaming'
             )",
            [],
            |row| row.get(0),
        )
        .unwrap()
}
