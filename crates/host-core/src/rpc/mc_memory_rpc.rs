use super::*;

pub(super) fn check_expected(
    expected: &Value,
    current: crate::db::ProjectMemoryRecord,
) -> Result<(), JsonRpcError> {
    let current =
        serde_json::to_value(current).map_err(|e| rpc_err(1000, e.to_string(), "INTERNAL"))?;
    if expected != &current {
        return Err(rpc_err(
            1002,
            "Project memory changed; reload before saving",
            "MEMORY_CONFLICT",
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn memory_writes_reject_stale_snapshots_without_overwriting_newer_notes() {
        let directory = tempfile::tempdir().unwrap();
        let mut app = AppState::open(directory.path()).unwrap();
        app.handshook = true;
        let group = app
            .db
            .create_project_group("Memory", &[directory.path().to_string_lossy().into_owned()])
            .unwrap();
        let state = Arc::new(Mutex::new(app));
        let (tx, _rx) = mpsc::unbounded_channel();
        for (prefix, mut params) in [
            ("project.memory", json!({"path":directory.path()})),
            ("project.group.memory", json!({"groupId":group.id})),
        ] {
            let read = format!("{prefix}.get");
            let write = format!("{prefix}.set");
            let before = handle_request(state.clone(), &read, params.clone(), tx.clone())
                .await
                .unwrap();
            params["expectedMemory"] = before["memory"].clone();
            params["entries"] = json!([{"id":"user", "title":"User", "content":"Keep this"}]);
            let saved = handle_request(state.clone(), &write, params.clone(), tx.clone())
                .await
                .unwrap();
            params["entries"] =
                json!([{"id":"agent-test", "title":"Agent", "content":"Stale replacement"}]);
            let error = handle_request(state.clone(), &write, params.clone(), tx.clone())
                .await
                .unwrap_err();
            assert_eq!(error.data.unwrap()["errorCode"], "MEMORY_CONFLICT");
            let current = handle_request(state.clone(), &read, params.clone(), tx.clone())
                .await
                .unwrap();
            assert_eq!(current, saved);
            params["expectedMemory"] = current["memory"].clone();
            params["entries"] = current["memory"]["entries"].clone();
            params["entries"]
                .as_array_mut()
                .unwrap()
                .push(json!({"id":"agent-test", "title":"Agent", "content":"New note"}));
            let merged = handle_request(state.clone(), &write, params.clone(), tx.clone())
                .await
                .unwrap();
            assert_eq!(merged["memory"]["entries"].as_array().unwrap().len(), 2);
            // Existing callers that intentionally replace the whole document keep working.
            params.as_object_mut().unwrap().remove("expectedMemory");
            params["entries"] = json!([]);
            assert!(handle_request(state.clone(), &write, params, tx.clone())
                .await
                .is_ok());
        }
    }
}
