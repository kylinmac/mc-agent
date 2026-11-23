use super::*;

enum Permission {
    Inherit(Option<String>),
    Selected(String),
}

/// An extension can create a worker, but only the host can resolve its parent's permission.
pub(super) async fn inherited(
    state: &Arc<Mutex<AppState>>,
    params: &Value,
) -> Result<Value, JsonRpcError> {
    create(
        state,
        params,
        Permission::Inherit(permission_parent_param(params)?),
    )
    .await
}

/// This host-only route is called by the desktop UI, paired mobile bridge and
/// RACP controller. Keep it outside the agent proxy and plugin/MCP catalogs.
pub(super) async fn configured(
    state: &Arc<Mutex<AppState>>,
    params: &Value,
) -> Result<Value, JsonRpcError> {
    if !params["inheritPermissionFromSessionId"].is_null() {
        return Err(rpc_err(
            1002,
            "permission selection and inheritance are mutually exclusive",
            "INVALID_PARAMS",
        ));
    }
    let permission = params["permissionMode"]
        .as_str()
        .filter(|mode| sessions::is_valid_permission_mode(mode))
        .ok_or_else(|| rpc_err(1002, "invalid session permissionMode", "INVALID_PARAMS"))?;
    let mode = &params["mode"];
    if !mode.is_null()
        && !mode
            .as_str()
            .is_some_and(|mode| mode == "chat" || sessions::is_valid_mode(mode))
    {
        return Err(rpc_err(1002, "invalid session mode", "INVALID_PARAMS"));
    }
    create(state, params, Permission::Selected(permission.to_owned())).await
}

async fn create(
    state: &Arc<Mutex<AppState>>,
    params: &Value,
    permission: Permission,
) -> Result<Value, JsonRpcError> {
    let thinking_level = thinking_level_param(params)?;
    let string_param = |key: &str| params[key].as_str().map(str::to_owned);
    let isolated_project = if params["isolated"].as_bool() == Some(true) {
        Some(string_param("projectPath").ok_or_else(|| {
            rpc_err(
                1002,
                "an isolated session needs a projectPath",
                "INVALID_PARAMS",
            )
        })?)
    } else {
        None
    };
    let st = state.lock().await;
    if let Some(project) = isolated_project.as_deref() {
        worktree_rpc::ensure_local_project(&st.db, project)?;
    }
    let permission_mode = match permission {
        Permission::Selected(mode) => Some(mode),
        Permission::Inherit(Some(parent_id)) => Some(
            sessions::session_permission_mode(&st.db, &parent_id)
                .map_err(|e| rpc_err(1000, e.to_string(), "INTERNAL"))?
                .ok_or_else(|| rpc_err(1007, "parent session not found", "NOT_FOUND"))?,
        ),
        Permission::Inherit(None) => None,
    };
    // A new project row and its first session are one write. No consumer can
    // observe an intermediate inherited permission, even if creation fails.
    let tx = st
        .db
        .conn()
        .unchecked_transaction()
        .map_err(|e| rpc_err(1000, e.to_string(), "INTERNAL"))?;
    let session = sessions::create_session_with_options(
        &st.db,
        sessions::SessionCreateOptions {
            title: string_param("title"),
            mode: string_param("mode"),
            provider_id: string_param("providerId"),
            model_id: string_param("modelId"),
            project_path: string_param("projectPath"),
            thinking_level,
            permission_mode,
        },
    )
    .map_err(|e| rpc_err(1000, e.to_string(), "INTERNAL"))?;
    let id = session.id.clone();
    let summary = remote_tools::session_value(&st.db, session)?;
    tx.commit()
        .map_err(|e| rpc_err(1000, e.to_string(), "INTERNAL"))?;
    let Some(project) = isolated_project else {
        return Ok(json!({ "session": summary }));
    };
    drop(st);
    let created = worktree_rpc::isolate_new_session(state, &id, &project).await?;
    let st = state.lock().await;
    let session = sessions::session_summary(&st.db, &id)
        .map_err(|e| rpc_err(1000, e.to_string(), "INTERNAL"))?
        .ok_or_else(|| rpc_err(1007, "session not found", "NOT_FOUND"))?;
    Ok(json!({ "session": remote_tools::session_value(&st.db, session)?, "worktree": created }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn selected_permission_is_persisted_and_invalid_creation_leaves_no_row() {
        let dir = tempfile::tempdir().unwrap();
        let mut app = AppState::open(dir.path()).unwrap();
        app.handshook = true;
        let state = Arc::new(Mutex::new(app));
        let (tx, _rx) = mpsc::unbounded_channel();
        for mode in sessions::PERMISSION_MODES {
            let result = handle_request(
                state.clone(),
                "session.createConfigured",
                json!({ "mode": "plan", "permissionMode": mode }),
                tx.clone(),
            )
            .await
            .unwrap();
            let id = result["session"]["id"].as_str().unwrap();
            assert_eq!(result["session"]["permissionMode"], mode);
            assert_eq!(
                sessions::session_permission_mode(&state.lock().await.db, id)
                    .unwrap()
                    .as_deref(),
                Some(mode)
            );
        }
        let project = dir.path().join("new-project");
        let project_count = |st: &AppState| {
            st.db
                .conn()
                .query_row("SELECT COUNT(*) FROM projects", [], |row| {
                    row.get::<_, i64>(0)
                })
                .unwrap()
        };
        let projects_before = project_count(&*state.lock().await);
        for invalid in [
            json!({ "permissionMode": "unknown", "projectPath": project }),
            json!({ "permissionMode": false, "projectPath": project }),
            json!({ "permissionMode": "ask", "mode": "typo", "projectPath": project }),
            json!({ "permissionMode": "auto", "inheritPermissionFromSessionId": "a-parent" }),
        ] {
            let error = handle_request(
                state.clone(),
                "session.createConfigured",
                invalid,
                tx.clone(),
            )
            .await
            .unwrap_err();
            assert_eq!(error.data.unwrap()["errorCode"], "INVALID_PARAMS");
        }
        state.lock().await.db.conn().execute_batch(
            "CREATE TRIGGER fail_create BEFORE INSERT ON sessions BEGIN SELECT RAISE(ABORT, 'rejected'); END;"
        ).unwrap();
        let failed_insert = handle_request(
            state.clone(),
            "session.createConfigured",
            json!({ "permissionMode": "ask", "projectPath": project }),
            tx,
        )
        .await
        .unwrap_err();
        assert!(failed_insert.message.contains("rejected"));
        let st = state.lock().await;
        assert_eq!(
            sessions::list_sessions(&st.db).unwrap().len(),
            sessions::PERMISSION_MODES.len()
        );
        assert_eq!(project_count(&st), projects_before);
    }
}
