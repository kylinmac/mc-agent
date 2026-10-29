//! mc-agent (MC-ADR-0020): Auto mode keeps asking for the guarded commands.
use super::*;

#[tokio::test]
async fn auto_mode_still_asks_for_guarded_commands() {
    let dir = tempfile::tempdir().unwrap();
    let mut app_state = AppState::open(dir.path()).unwrap();
    app_state.handshook = true;
    let state = Arc::new(Mutex::new(app_state));
    let (tx, _rx) = mpsc::unbounded_channel();
    let created = handle_request(
        state.clone(),
        "session.create",
        json!({ "mode": "agent" }),
        tx.clone(),
    )
    .await
    .unwrap();
    let id = created["session"]["id"].as_str().unwrap().to_string();
    handle_request(
        state.clone(),
        "session.configure",
        json!({ "id": id, "mode": "agent", "permissionMode": "auto" }),
        tx.clone(),
    )
    .await
    .unwrap();
    let evaluate = |command: &'static str| {
        let state = state.clone();
        let tx = tx.clone();
        let id = id.clone();
        async move {
            handle_request(
                state,
                "permissions.evaluate",
                json!({ "sessionId": id, "toolName": "Bash", "args": { "command": command } }),
                tx,
            )
            .await
            .unwrap()["decision"]
                .clone()
        }
    };
    assert_eq!(evaluate("git status").await, json!("allow-once"));
    assert_eq!(evaluate("git push --force origin main").await, Value::Null);
    assert_eq!(evaluate("gh pr merge 23").await, Value::Null);
    assert_eq!(
        evaluate("docker run --rm --entrypoint /bin/sh image -c 'find /opt/app -name x'").await,
        json!("allow-once")
    );
    assert_eq!(
        evaluate("javap -c Example | grep -E 'close|shutdown|reboot'").await,
        json!("allow-once")
    );
    assert_eq!(evaluate("rm -rf /tmp/test").await, Value::Null);
    assert_eq!(evaluate("shutdown -h now").await, Value::Null);
    assert_eq!(
        evaluate("grep shutdown commands.txt | xargs -I {} {}").await,
        Value::Null
    );
}
