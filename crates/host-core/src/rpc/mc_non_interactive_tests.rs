//! mc-agent (R21.2): compaction file restore reads with `nonInteractive`;
//! allowed reads run, anything that would need approval is skipped without
//! creating a request.

use super::*;

async fn session(
    workspace: &std::path::Path,
    data: &std::path::Path,
) -> (Arc<Mutex<AppState>>, String) {
    let mut app = AppState::open(data).unwrap();
    app.handshook = true;
    let state = Arc::new(Mutex::new(app));
    let (tx, _rx) = mpsc::unbounded_channel();
    let created = handle_request(
        state.clone(),
        "session.create",
        json!({ "projectPath": workspace }),
        tx.clone(),
    )
    .await
    .unwrap();
    let id = created["session"]["id"].as_str().unwrap().to_string();
    handle_request(
        state.clone(),
        "session.configure",
        json!({ "id": id, "mode": "agent", "permissionMode": "ask" }),
        tx,
    )
    .await
    .unwrap();
    (state, id)
}

#[tokio::test]
async fn skips_reads_that_would_prompt_and_runs_allowed_ones() {
    let workspace_dir = tempfile::tempdir().unwrap();
    let outside_dir = tempfile::tempdir().unwrap();
    let data = tempfile::tempdir().unwrap();
    // Temp dirs can sit behind a symlink (macOS /var); use real paths.
    let workspace = workspace_dir.path().canonicalize().unwrap();
    let outside = outside_dir.path().canonicalize().unwrap();
    std::fs::write(workspace.join("inside.txt"), "inside text").unwrap();
    std::fs::write(outside.join("secret.txt"), "outside text").unwrap();
    let (state, id) = session(&workspace, data.path()).await;
    let (tx, mut rx) = mpsc::unbounded_channel();

    let inside = handle_request(
        state.clone(),
        "tools.execute",
        json!({ "sessionId": id, "toolCallId": "restore-1", "toolName": "Read",
            "args": { "path": workspace.join("inside.txt") }, "mode": "agent", "nonInteractive": true }),
        tx.clone(),
    )
    .await
    .unwrap();
    assert_eq!(inside["ok"], true, "{inside}");
    assert!(inside.to_string().contains("inside text"));

    let skipped = handle_request(
        state.clone(),
        "tools.execute",
        json!({ "sessionId": id, "toolCallId": "restore-2", "toolName": "Read",
            "args": { "path": outside.join("secret.txt") }, "mode": "agent", "nonInteractive": true }),
        tx.clone(),
    )
    .await
    .unwrap();
    assert_eq!(skipped["errorCode"], "APPROVAL_REQUIRED", "{skipped}");
    assert!(!skipped.to_string().contains("outside text"));
    while let Ok(frame) = rx.try_recv() {
        assert!(
            !frame.contains("permissions.request"),
            "no approval may be requested: {frame}"
        );
    }
    // The tool call ID is free again: the skipped call left no registration.
    let again = handle_request(
        state,
        "tools.execute",
        json!({ "sessionId": id, "toolCallId": "restore-2", "toolName": "Read",
            "args": { "path": workspace.join("inside.txt") }, "mode": "agent", "nonInteractive": true }),
        tx,
    )
    .await
    .unwrap();
    assert_eq!(again["ok"], true, "{again}");
}
