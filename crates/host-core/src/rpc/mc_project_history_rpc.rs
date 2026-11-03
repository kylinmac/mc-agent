//! R5.1: bounded, read-only conversations inside the caller's local project.
use super::*;
use crate::db::{ms_to_ts, Database, ProjectGroupRecord};
use crate::sessions::SessionSummary;
use crate::transcripts::history::{self, HistoryRequest};
use serde::Deserialize;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Request {
    session_id: String,
    action: String,
    target_session_id: Option<String>,
    query: Option<String>,
    before: Option<String>,
    offset: Option<usize>,
    limit: Option<usize>,
}

fn denied() -> JsonRpcError {
    rpc_err(
        1003,
        "Conversation is unavailable in this local project",
        "PROJECT_HISTORY_DENIED",
    )
}

fn group_for_session(
    db: &Database,
    id: &str,
) -> Result<(ProjectGroupRecord, SessionSummary), JsonRpcError> {
    let session = sessions::session_summary(db, id)
        .map_err(|e| rpc_err(1000, e.to_string(), "INTERNAL"))?
        .ok_or_else(denied)?;
    let path = session.project_path.as_deref().ok_or_else(denied)?;
    let group = db
        .project_group_for_path(path)
        .map_err(|e| rpc_err(1000, e.to_string(), "INTERNAL"))?
        .ok_or_else(denied)?;
    if group.remote.is_some() {
        return Err(denied());
    }
    Ok((group, session))
}

fn authorize(
    db: &Database,
    caller: &str,
    target: &str,
) -> Result<(String, SessionSummary), JsonRpcError> {
    let (group, _) = group_for_session(db, caller)?;
    let (target_group, session) = group_for_session(db, target)?;
    if group.id != target_group.id {
        return Err(denied());
    }
    Ok((group.id, session))
}

pub(super) async fn handle(
    state: &Arc<Mutex<AppState>>,
    params: &Value,
) -> Result<Value, JsonRpcError> {
    let request: Request = serde_json::from_value(params.clone())
        .map_err(|_| rpc_err(1002, "Invalid ProjectHistory arguments", "INVALID_PARAMS"))?;
    let invalid_text = [
        &Some(request.session_id.clone()),
        &request.target_session_id,
        &request.before,
    ]
    .into_iter()
    .flatten()
    .any(|s| s.trim().is_empty() || s.len() > 200);
    if invalid_text
        || request
            .query
            .as_ref()
            .is_some_and(|q| q.chars().count() > 200)
        || request.limit.is_some_and(|n| n == 0 || n > 50)
        || request.offset.unwrap_or(0) > 100_000
    {
        return Err(rpc_err(
            1002,
            "Invalid ProjectHistory bounds",
            "INVALID_PARAMS",
        ));
    }
    match request.action.as_str() {
        "list" => {
            if request.target_session_id.is_some() || request.before.is_some() {
                return Err(rpc_err(
                    1002,
                    "list does not accept a target or message cursor",
                    "INVALID_PARAMS",
                ));
            }
            let st = state.lock().await;
            let (group, _) = group_for_session(&st.db, &request.session_id)?;
            let roots: Vec<_> = group.roots.iter().map(|root| &root.path).collect();
            let roots = serde_json::to_string(&roots)
                .map_err(|e| rpc_err(1000, e.to_string(), "INTERNAL"))?;
            let limit = request.limit.unwrap_or(20).min(20);
            let offset = request.offset.unwrap_or(0);
            let query = request.query.as_deref().unwrap_or("").trim();
            let result = (|| -> anyhow::Result<Vec<Value>> {
                let mut stmt = st.db.conn().prepare_cached(
                    "SELECT s.id, s.title, s.updated_at FROM sessions s
                     JOIN projects p ON p.id = s.project_id
                     WHERE s.deleted_at IS NULL AND s.id != ?1
                       AND p.path IN (SELECT value FROM json_each(?2))
                       AND instr(lower(s.title), lower(?3)) > 0
                     ORDER BY s.updated_at DESC, s.id ASC LIMIT ?4 OFFSET ?5",
                )?;
                let rows = stmt.query_map(rusqlite::params![request.session_id, roots, query, (limit + 1) as i64, offset as i64], |row| {
                    let title: String = row.get(1)?;
                    Ok(json!({"id": row.get::<_, String>(0)?, "title": title.chars().take(200).collect::<String>(), "updatedAt": ms_to_ts(row.get(2)?)}))
                })?.collect::<rusqlite::Result<Vec<_>>>()?;
                Ok(rows)
            })();
            let mut sessions = result.map_err(|e| rpc_err(1000, e.to_string(), "INTERNAL"))?;
            let next_offset = (sessions.len() > limit).then_some(offset + limit);
            sessions.truncate(limit);
            Ok(json!({"projectId":group.id, "sessions":sessions, "nextOffset":next_offset}))
        }
        "read" => {
            if request.offset.is_some() {
                return Err(rpc_err(
                    1002,
                    "read uses before, not offset",
                    "INVALID_PARAMS",
                ));
            }
            let target = request
                .target_session_id
                .ok_or_else(|| rpc_err(1002, "targetSessionId required", "INVALID_PARAMS"))?;
            let (project_id, session, data_dir) = {
                let st = state.lock().await;
                let (project_id, session) = authorize(&st.db, &request.session_id, &target)?;
                (project_id, session, st.db.data_dir().to_path_buf())
            };
            let read = HistoryRequest {
                query: request.query,
                before: request.before,
                limit: request.limit.unwrap_or(history::DEFAULT_LIMIT),
                message_chars: history::DEFAULT_MESSAGE_CHARS,
                ..HistoryRequest::default()
            };
            let read_target = target.clone();
            let response = tokio::task::spawn_blocking(move || {
                history::read_conversation(&data_dir, &read_target, &read)
            })
            .await
            .map_err(|_| rpc_err(1000, "History read task failed", "INTERNAL"))?
            .map_err(|_| {
                rpc_err(
                    1000,
                    "Conversation history could not be read",
                    "HISTORY_READ_FAILED",
                )
            })?;
            let st = state.lock().await;
            let (current_project, _) = authorize(&st.db, &request.session_id, &target)?;
            if current_project != project_id {
                return Err(denied());
            }
            Ok(
                json!({"projectId":project_id, "session":{"id":session.id,"title":session.title.chars().take(200).collect::<String>()}, "history":response}),
            )
        }
        _ => Err(rpc_err(
            1002,
            "action must be list or read",
            "INVALID_PARAMS",
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::transcripts::{append_message, MessageRecord};

    #[tokio::test]
    async fn project_history_lists_titles_reads_other_workspaces_and_denies_outsiders() {
        let dir = tempfile::tempdir().unwrap();
        let a = dir.path().join("a");
        let b = dir.path().join("b");
        let other = dir.path().join("other");
        for path in [&a, &b, &other] {
            std::fs::create_dir_all(path).unwrap();
        }
        let app = AppState::open(dir.path()).unwrap();
        let paths: Vec<_> = [&a, &b]
            .iter()
            .map(|p| p.to_string_lossy().to_string())
            .collect();
        app.db.create_project_group("CDC", &paths).unwrap();
        let make = |title: &str, path: Option<String>| {
            sessions::create_session(
                &app.db,
                Some(title.into()),
                Some("plan".into()),
                None,
                None,
                path,
            )
            .unwrap()
        };
        let caller = make("Organize", Some(paths[0].clone()));
        let target = make("Doris stable branch", Some(paths[1].clone()));
        let second = make("Other notes", Some(paths[1].clone()));
        let outsider = make("Doris private", Some(other.to_string_lossy().to_string()));
        let unbound = make("No project", None);
        let remote_group = app
            .db
            .create_remote_project_group(
                "Remote",
                crate::db::RemoteWorkspace {
                    host_key: "fixture".into(),
                    path: "/workspace".into(),
                },
            )
            .unwrap();
        let remote_session = make("Remote chat", Some(remote_group.primary_path));

        append_message(dir.path(), &target.id, &target.created_at, &MessageRecord {
            id:"decision".into(), role:"user".into(), tool_name:None, is_error:false,
            blocks:json!([{"type":"text","text":"Confirmed CDC requirement"},{"type":"thinking","text":"hidden"}]),
            meta:None, created_at:target.created_at.clone(),
        }).unwrap();
        let state = Arc::new(Mutex::new(app));
        let listed = handle(
            &state,
            &json!({"sessionId":caller.id,"action":"list","query":"doris","limit":1}),
        )
        .await
        .unwrap();
        assert_eq!(listed["sessions"].as_array().unwrap().len(), 1);
        assert_eq!(listed["sessions"][0]["id"], target.id);
        let read = handle(
            &state,
            &json!({"sessionId":caller.id,"action":"read","targetSessionId":target.id}),
        )
        .await
        .unwrap();
        assert_eq!(
            read["history"]["messages"][0]["text"],
            "Confirmed CDC requirement"
        );
        assert_eq!(read["history"]["messages"][0]["role"], "user");
        let first_page = handle(
            &state,
            &json!({"sessionId":caller.id,"action":"list","limit":1}),
        )
        .await
        .unwrap();
        assert_eq!(first_page["nextOffset"], 1);
        let next_page = handle(
            &state,
            &json!({"sessionId":caller.id,"action":"list","limit":1,"offset":1}),
        )
        .await
        .unwrap();
        assert_ne!(
            first_page["sessions"][0]["id"],
            next_page["sessions"][0]["id"]
        );
        assert_eq!(next_page["nextOffset"], Value::Null);

        for id in [&outsider.id, &unbound.id, "missing"] {
            assert!(handle(
                &state,
                &json!({"sessionId":caller.id,"action":"read","targetSessionId":id})
            )
            .await
            .is_err());
        }
        assert!(
            handle(&state, &json!({"sessionId":unbound.id,"action":"list"}))
                .await
                .is_err()
        );
        assert!(handle(
            &state,
            &json!({"sessionId":caller.id,"action":"list","limit":1000})
        )
        .await
        .is_err());
        assert!(handle(
            &state,
            &json!({"sessionId":caller.id,"action":"list","projectId":"forged"})
        )
        .await
        .is_err());

        assert!(handle(
            &state,
            &json!({"sessionId":remote_session.id,"action":"list"})
        )
        .await
        .is_err());
        {
            let st = state.lock().await;
            st.db.conn().execute("UPDATE sessions SET project_id = (SELECT id FROM projects WHERE path = ?1) WHERE id = ?2", rusqlite::params![outsider.project_path, target.id]).unwrap();
            assert!(authorize(&st.db, &caller.id, &target.id).is_err());
        }
        sessions::delete_session(&state.lock().await.db, &target.id).unwrap();
        sessions::delete_session(&state.lock().await.db, &second.id).unwrap();
        assert!(handle(
            &state,
            &json!({"sessionId":caller.id,"action":"read","targetSessionId":target.id})
        )
        .await
        .is_err());
        assert_eq!(
            handle(&state, &json!({"sessionId":caller.id,"action":"list"}))
                .await
                .unwrap()["sessions"],
            json!([])
        );
    }
}
