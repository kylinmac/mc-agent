//! mc-agent `session.historyRead` (R21.1, docs/mc-agent/compaction-context-restore.md).
//!
//! Reached only through the agent sidecar's host proxy, which admits it for a
//! session the embedding host launched into that sidecar. The renderer has no
//! route to it. The state lock is held only to confirm the session exists and
//! to copy the data directory; the transcript is read on a blocking thread so a
//! long scan never stalls other requests that need the lock.

use super::*;
use crate::transcripts::history::{self, HistoryRequest};

fn optional_string(params: &Value, key: &str) -> Option<String> {
    params
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn bounded(params: &Value, key: &str, default: usize) -> Result<usize, JsonRpcError> {
    match params.get(key) {
        None | Some(Value::Null) => Ok(default),
        Some(value) => value
            .as_u64()
            .filter(|value| *value > 0)
            .map(|value| value as usize)
            .ok_or_else(|| {
                rpc_err(
                    1002,
                    format!("{key} must be a positive integer"),
                    "INVALID_PARAMS",
                )
            }),
    }
}

pub(super) async fn handle(
    state: &Arc<Mutex<AppState>>,
    params: &Value,
) -> Result<Value, JsonRpcError> {
    let session_id = optional_string(params, "sessionId")
        .ok_or_else(|| rpc_err(1002, "sessionId required", "INVALID_PARAMS"))?;
    let request = HistoryRequest {
        checkpoint_id: optional_string(params, "checkpointId"),
        before: optional_string(params, "before"),
        around: optional_string(params, "around"),
        query: optional_string(params, "query"),
        limit: bounded(params, "limit", history::DEFAULT_LIMIT)?,
        message_chars: bounded(params, "messageChars", history::DEFAULT_MESSAGE_CHARS)?,
    };
    if request.before.is_some() && request.around.is_some() {
        return Err(rpc_err(
            1002,
            "use before or around, not both",
            "INVALID_PARAMS",
        ));
    }
    let data_dir = {
        let st = state.lock().await;
        if sessions::session_summary(&st.db, &session_id)
            .map_err(|e| rpc_err(1000, e.to_string(), "INTERNAL"))?
            .is_none()
        {
            return Err(rpc_err(1007, "session not found", "NOT_FOUND"));
        }
        st.db.data_dir().to_path_buf()
    };
    let response = tokio::task::spawn_blocking(move || {
        history::read_history(&data_dir, &session_id, &request)
    })
    .await
    .map_err(|e| rpc_err(1000, e.to_string(), "INTERNAL"))?
    .map_err(|e| rpc_err(1000, e.to_string(), "INTERNAL"))?;
    serde_json::to_value(response).map_err(|e| rpc_err(1000, e.to_string(), "INTERNAL"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::transcripts::{append_compaction, append_message, CompactionRecord, MessageRecord};

    #[tokio::test]
    async fn reads_behind_the_checkpoint_and_rejects_unknown_sessions() {
        let directory = tempfile::tempdir().unwrap();
        let mut app = AppState::open(directory.path()).unwrap();
        app.handshook = true;
        let session = sessions::create_session(
            &app.db,
            Some("History".into()),
            Some("agent".into()),
            None,
            None,
            None,
        )
        .unwrap();
        let data_dir = app.db.data_dir().to_path_buf();
        let created = session.created_at.clone();
        for index in 0..3 {
            append_message(
                &data_dir,
                &session.id,
                &created,
                &MessageRecord {
                    id: format!("m{index}"),
                    role: "user".into(),
                    tool_name: None,
                    is_error: false,
                    blocks: json!([{ "type": "text", "text": format!("note {index}") }]),
                    meta: None,
                    created_at: created.clone(),
                },
            )
            .unwrap();
        }
        append_compaction(
            &data_dir,
            &session.id,
            &created,
            &CompactionRecord {
                id: "c1".into(),
                summary: "s".into(),
                first_kept_message_id: None,
                through_message_id: "m1".into(),
                tokens_before: 1,
                usage: None,
                retained_tail: None,
                details: None,
                provider_id: None,
                model_id: None,
                created_at: created.clone(),
            },
        )
        .unwrap();
        let state = Arc::new(Mutex::new(app));
        let (tx, _rx) = mpsc::unbounded_channel();
        let result = handle_request(
            state.clone(),
            "session.historyRead",
            json!({ "sessionId": session.id, "limit": 10 }),
            tx.clone(),
        )
        .await
        .unwrap();
        assert_eq!(result["status"], "ok");
        assert_eq!(result["checkpointId"], "c1");
        let ids: Vec<&str> = result["messages"]
            .as_array()
            .unwrap()
            .iter()
            .map(|message| message["id"].as_str().unwrap())
            .collect();
        assert_eq!(ids, ["m0", "m1"]);
        let missing = handle_request(
            state.clone(),
            "session.historyRead",
            json!({ "sessionId": "nope" }),
            tx.clone(),
        )
        .await;
        assert!(missing.is_err());
        let both = handle_request(
            state,
            "session.historyRead",
            json!({ "sessionId": session.id, "before": "m1", "around": "m0" }),
            tx,
        )
        .await;
        assert!(both.is_err());
    }
}
