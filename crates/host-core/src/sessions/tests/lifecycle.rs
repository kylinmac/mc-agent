use super::*;

#[test]
fn append_message_without_a_live_same_session_turn_keeps_the_message() {
    let db = test_db();
    let source = create_session(&db, None, None, None, None, None).unwrap();
    let target = create_session(&db, None, None, None, None, None).unwrap();
    let source_turn = begin_turn(&db, &source.id, None, None).unwrap();
    let missing = user_msg("missing-turn-message", "kept", "2026-07-28T00:00:00Z");
    let cross_session = user_msg(
        "cross-session-turn-message",
        "also kept",
        "2026-07-28T00:00:01Z",
    );

    append_message(&db, &target.id, &missing, Some("missing-turn"))
        .expect("a stale optional turn must not block transcript persistence");
    append_message(&db, &target.id, &cross_session, Some(&source_turn))
        .expect("a turn owned by another session must not block transcript persistence");

    let links: Vec<(String, Option<String>)> = db
        .conn()
        .prepare("SELECT id, turn_id FROM messages WHERE session_id = ?1 ORDER BY seq")
        .unwrap()
        .query_map(params![target.id], |row| Ok((row.get(0)?, row.get(1)?)))
        .unwrap()
        .collect::<rusqlite::Result<_>>()
        .unwrap();
    assert_eq!(
        links,
        vec![(missing.id.clone(), None), (cross_session.id.clone(), None),]
    );
    assert_eq!(
        get_session(&db, &target.id)
            .unwrap()
            .unwrap()
            .messages
            .iter()
            .map(|message| message.id.as_str())
            .collect::<Vec<_>>(),
        vec![missing.id.as_str(), cross_session.id.as_str()]
    );
}

#[test]
fn configure_session_persists_pi_runtime_selection() {
    let db = test_db();
    let session = create_session(&db, None, None, None, None, Some("/tmp/x".into())).unwrap();
    db.conn()
        .execute(
            "INSERT INTO providers (
                id, name, vendor_key, type, protocol, enabled, base_url,
                auth_kind, secret_ref, api_style, default_model_id,
                created_at, updated_at
             ) VALUES (
                'provider-1', 'Provider', 'custom', 'openai_compatible',
                'openai_compatible', 1, NULL, 'none', NULL,
                'chat_completions', 'model-1', 1, 1
             )",
            [],
        )
        .unwrap();

    let configured = configure_session_with_thinking(
        &db,
        &session.id,
        "chat",
        Some("provider-1"),
        Some("model-1"),
        Some("high"),
        None,
    )
    .unwrap()
    .unwrap();

    assert_eq!(configured.mode, "plan");
    assert_eq!(configured.provider_id.as_deref(), Some("provider-1"));
    assert_eq!(configured.model_id.as_deref(), Some("model-1"));
    assert_eq!(configured.thinking_level, "high");
    // Omitting the new field is backwards-compatible and preserves the
    // configured value rather than resetting it to off.
    let preserved = configure_session(&db, &session.id, "chat", None, None)
        .unwrap()
        .unwrap();
    assert_eq!(preserved.thinking_level, "high");
    assert!(configure_session(&db, &session.id, "invalid", None, None).is_err());
    assert!(configure_session_with_thinking(
        &db,
        &session.id,
        "chat",
        None,
        None,
        Some("turbo"),
        None,
    )
    .is_err());
    let omitted =
        configure_session_with_thinking(&db, &session.id, "chat", None, None, Some("omit"), None)
            .unwrap()
            .unwrap();
    assert_eq!(omitted.thinking_level, "omit");
}

#[test]
fn create_session_permission_mode_is_optional_and_validated() {
    let db = test_db();
    let default_session = create_session(&db, None, None, None, None, None).unwrap();
    assert_eq!(default_session.permission_mode, "inherit");

    let worker = create_session_with_options(
        &db,
        SessionCreateOptions {
            title: Some("Worker".into()),
            mode: Some("agent".into()),
            thinking_level: Some("high".into()),
            permission_mode: Some("ask".into()),
            ..Default::default()
        },
    )
    .unwrap();
    assert_eq!(worker.permission_mode, "ask");
    assert_eq!(worker.thinking_level, "high");

    assert!(create_session_with_options(
        &db,
        SessionCreateOptions {
            permission_mode: Some("unrestricted".into()),
            ..Default::default()
        },
    )
    .is_err());
}

#[test]
fn create_session_returns_canonical_project_path() {
    let dir = tempfile::tempdir().unwrap();
    let project = dir.path().join("project");
    std::fs::create_dir_all(&project).unwrap();
    let db = Database::open(&dir.path().join("test.sqlite")).unwrap();
    let spelling_with_trailing_slash = format!("{}/", project.display());

    let session = create_session(
        &db,
        None,
        None,
        None,
        None,
        Some(spelling_with_trailing_slash),
    )
    .unwrap();

    let canonical = simple_canonicalize(&project)
        .unwrap()
        .to_string_lossy()
        .replace('\\', "/");
    assert_eq!(session.project_path.as_deref(), Some(canonical.as_str()));
    assert_eq!(
        get_session(&db, &session.id)
            .unwrap()
            .unwrap()
            .summary
            .project_path
            .as_deref(),
        Some(canonical.as_str())
    );
}

#[test]
fn import_session_is_idempotent_and_preserves_timestamps() {
    let db = test_db();
    let summary = SessionSummary {
        id: "import-claude-code-abc".into(),
        title: "Imported".into(),
        message_count: 1,
        project_path: Some("/tmp/proj".into()),
        model_id: None,
        provider_id: None,
        mode: "agent".into(),
        thinking_level: "off".into(),
        permission_mode: "inherit".into(),
        // Ownership is derived from `task_runs`, so an import is never one.
        scheduled_run: false,
        worktree: None,
        created_at: "2025-01-01T00:00:00Z".into(),
        updated_at: "2025-01-02T00:00:00Z".into(),
    };
    let messages = vec![user_msg("m1", "hello", "2025-01-01T00:00:01Z")];

    assert!(import_session(&db, &summary, &messages).unwrap());
    // Re-import of the same id is skipped.
    assert!(!import_session(&db, &summary, &messages).unwrap());

    let detail = get_session(&db, &summary.id).unwrap().unwrap();
    // Timestamps are stored as ms and re-emitted as RFC3339: compare instants.
    assert_eq!(
        ts_to_ms(&detail.summary.created_at),
        ts_to_ms("2025-01-01T00:00:00Z")
    );
    assert_eq!(
        ts_to_ms(&detail.summary.updated_at),
        ts_to_ms("2025-01-02T00:00:00Z")
    );
    assert_eq!(detail.summary.project_path.as_deref(), Some("/tmp/proj"));
    assert_eq!(detail.messages.len(), 1);
    assert_eq!(detail.messages[0].content, "hello");
    let projects = db.list_projects().unwrap();
    assert_eq!(projects.len(), 1);
    assert_eq!(projects[0].path, "/tmp/proj");

    let source: Option<String> = db
        .conn()
        .query_row(
            "SELECT source FROM sessions WHERE id = ?1",
            params![summary.id],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(source.as_deref(), Some("claude-code"));
}

#[test]
fn import_materializes_unique_projects_but_keeps_pathless_sessions_temporary() {
    let db = test_db();
    let base = SessionSummary {
        id: "import-codex-one".into(),
        title: "Imported".into(),
        message_count: 0,
        project_path: Some("/tmp/project/".into()),
        model_id: None,
        provider_id: None,
        mode: "agent".into(),
        thinking_level: "off".into(),
        permission_mode: "inherit".into(),
        // Ownership is derived from `task_runs`, so an import is never one.
        scheduled_run: false,
        worktree: None,
        created_at: "2025-01-01T00:00:00Z".into(),
        updated_at: "2025-01-01T00:00:00Z".into(),
    };
    assert!(import_session(&db, &base, &[]).unwrap());

    let mut same_project = base.clone();
    same_project.id = "import-codex-two".into();
    same_project.project_path = Some("/tmp/project".into());
    assert!(import_session(&db, &same_project, &[]).unwrap());

    let mut temporary = base.clone();
    temporary.id = "import-codex-temporary".into();
    temporary.project_path = Some("   ".into());
    assert!(import_session(&db, &temporary, &[]).unwrap());

    let projects = db.list_projects().unwrap();
    assert_eq!(projects.len(), 1);
    assert_eq!(projects[0].path, "/tmp/project");
    assert_eq!(
        get_session(&db, &temporary.id)
            .unwrap()
            .unwrap()
            .summary
            .project_path,
        None
    );
}

#[test]
fn append_message_remaps_ids_owned_by_another_session() {
    let db = test_db();
    let first = create_session(&db, None, None, None, None, None).unwrap();
    let second = create_session(&db, None, None, None, None, None).unwrap();
    let colliding = user_msg("call_421522", "first", "2026-09-16T15:42:41Z");
    append_message(&db, &first.id, &colliding, None).unwrap();
    append_message(&db, &second.id, &colliding, None).unwrap();

    let first_detail = get_session(&db, &first.id).unwrap().unwrap();
    let second_detail = get_session(&db, &second.id).unwrap().unwrap();
    assert_eq!(first_detail.messages[0].id, "call_421522");
    assert_eq!(
        second_detail.messages[0].id,
        format!("{}:call_421522", second.id)
    );
    assert_eq!(second_detail.messages[0].content, "first");

    append_message(&db, &second.id, &colliding, None).unwrap();
    assert_eq!(
        get_session(&db, &second.id)
            .unwrap()
            .unwrap()
            .messages
            .len(),
        1
    );
    assert_eq!(
        transcripts::read_transcript(db.data_dir(), &second.id)
            .unwrap()
            .len(),
        1
    );
}

#[test]
fn delete_session_removes_transcript_files() {
    let db = test_db();
    let session = create_session(&db, None, None, None, None, None).unwrap();
    let root = user_msg("m1", "x", "2025-05-01T00:00:00Z");
    append_message(&db, &session.id, &root, None).unwrap();
    save_message_revision(&db, &session.id, "m1", &[root], true).unwrap();
    let transcript = transcripts::transcript_path(db.data_dir(), &session.id).unwrap();
    let revisions = transcripts::revisions_path(db.data_dir(), &session.id).unwrap();
    assert!(transcript.exists());
    assert!(revisions.exists());

    assert!(delete_session(&db, &session.id).unwrap());
    assert!(!transcript.exists());
    assert!(!revisions.exists());
}

#[test]
fn missing_session_row_is_restored_from_transcript() {
    let db = test_db();
    let session = create_session(&db, Some("Keep me".into()), None, None, None, None).unwrap();
    append_message(
        &db,
        &session.id,
        &user_msg("u1", "hello world", "2025-05-01T00:00:00Z"),
        None,
    )
    .unwrap();
    append_message(
        &db,
        &session.id,
        &user_msg("u2", "second", "2025-05-01T00:00:01Z"),
        None,
    )
    .unwrap();
    db.conn()
        .execute("DELETE FROM sessions WHERE id = ?1", params![session.id])
        .unwrap();
    assert!(get_session(&db, &session.id).unwrap().is_none());

    assert!(restore_orphaned_session(&db, &session.id).unwrap());
    let restored = get_session(&db, &session.id).unwrap().unwrap();
    assert_eq!(restored.messages.len(), 2);
    assert_eq!(restored.messages[0].content, "hello world");
    assert_eq!(restored.summary.title, "hello world");
    assert_eq!(restored.summary.message_count, 2);
    assert!(!restore_orphaned_session(&db, &session.id).unwrap());
}

#[test]
fn append_recreates_a_missing_session_row_so_the_outbox_can_drain() {
    let db = test_db();
    let session = create_session(&db, None, None, None, None, None).unwrap();
    append_message(
        &db,
        &session.id,
        &user_msg("u1", "first", "2025-05-01T00:00:00Z"),
        None,
    )
    .unwrap();
    db.conn()
        .execute("DELETE FROM sessions WHERE id = ?1", params![session.id])
        .unwrap();
    append_message(
        &db,
        &session.id,
        &user_msg("u2", "queued", "2025-05-01T00:00:01Z"),
        None,
    )
    .unwrap();
    let restored = get_session(&db, &session.id).unwrap().unwrap();
    assert_eq!(restored.messages.len(), 2);
    assert_eq!(restored.messages[1].content, "queued");
}

#[test]
fn append_creates_a_stub_session_when_the_transcript_is_also_gone() {
    let db = test_db();
    let id = "11111111-2222-4333-8444-555555555555";
    append_message(
        &db,
        id,
        &user_msg("u1", "from outbox", "2025-05-01T00:00:00Z"),
        None,
    )
    .unwrap();
    let restored = get_session(&db, id).unwrap().unwrap();
    assert_eq!(restored.summary.title, "Recovered session");
    assert_eq!(restored.messages[0].content, "from outbox");
}

#[test]
fn get_session_dedupes_retried_file_lines_keep_last() {
    let db = test_db();
    let session = create_session(&db, None, None, None, None, None).unwrap();
    append_message(
        &db,
        &session.id,
        &user_msg("m1", "old", "2025-05-01T00:00:00Z"),
        None,
    )
    .unwrap();
    // Simulate a retried append whose first file line lost its index
    // transaction: the same id lands twice and the newest line wins.
    let (record, _) = ui_to_record(&user_msg("m1", "new", "2025-05-01T00:00:01Z"));
    transcripts::append_message(db.data_dir(), &session.id, "2025-05-01T00:00:00Z", &record)
        .unwrap();

    let detail = get_session(&db, &session.id).unwrap().unwrap();
    assert_eq!(detail.messages.len(), 1);
    assert_eq!(detail.messages[0].content, "new");
}

#[test]
fn turns_lifecycle() {
    let db = test_db();
    let session = create_session(&db, None, None, None, None, None).unwrap();
    let turn = begin_turn(&db, &session.id, Some("p1"), Some("m1")).unwrap();
    let ended = end_turn(
        &db,
        &turn,
        "completed",
        None,
        Some(&json!({ "inputTokens": 10, "outputTokens": 20 })),
        true,
    )
    .unwrap();
    assert!(ended.updated);
    assert_eq!(ended.notification.unwrap().kind, "task.completed");
    // Ending twice is a no-op.
    let duplicate = end_turn(&db, &turn, "completed", None, None, true).unwrap();
    assert!(!duplicate.updated);
    assert!(duplicate.notification.is_none());
    let (status, input, output): (String, i64, i64) = db
        .conn()
        .query_row(
            "SELECT status, input_tokens, output_tokens FROM turns WHERE id = ?1",
            params![turn],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .unwrap();
    assert_eq!(status, "completed");
    assert_eq!((input, output), (10, 20));
}

#[test]
fn begin_turn_rejects_a_second_running_turn_with_agent_busy() {
    let db = test_db();
    let session = create_session(&db, None, None, None, None, None).unwrap();
    let first = begin_turn(&db, &session.id, None, None).unwrap();

    let error = begin_turn(&db, &session.id, None, None).unwrap_err();
    assert_eq!(error.to_string(), "AGENT_BUSY");

    end_turn(&db, &first, "aborted", None, None, false).unwrap();
    assert!(begin_turn(&db, &session.id, None, None).is_ok());
}

#[test]
fn move_session_project_reassigns_only_the_project_and_rejects_running_turns() {
    let db = test_db();
    let source = std::env::temp_dir().join(format!("pi-move-source-{}", Uuid::new_v4()));
    let target = std::env::temp_dir().join(format!("pi-move-target-{}", Uuid::new_v4()));
    std::fs::create_dir_all(&source).unwrap();
    std::fs::create_dir_all(&target).unwrap();
    let session = create_session(
        &db,
        Some("Move me".into()),
        Some("agent".into()),
        Some("provider".into()),
        Some("model".into()),
        Some(source.to_string_lossy().to_string()),
    )
    .unwrap();

    // The host stores the same canonical spelling it derives here: resolved,
    // with forward slashes.
    let target_path = crate::db::canonical_project_path(&target.to_string_lossy())
        .expect("canonical project path");
    let moved = move_session_project(&db, &session.id, &target.to_string_lossy()).unwrap();
    let MoveSessionProjectResult::Moved(summary) = moved else {
        panic!("an idle session must move to the requested project");
    };
    assert_eq!(summary.project_path.as_deref(), Some(target_path.as_str()));
    // Title, provider, model, and message count stay with the session.
    assert_eq!(summary.title, "Move me");
    assert_eq!(summary.provider_id.as_deref(), Some("provider"));
    assert_eq!(summary.model_id.as_deref(), Some("model"));
    assert_eq!(summary.message_count, 0);

    // A running turn blocks the move so the live agent cannot switch
    // instruction roots mid-turn.
    let turn = begin_turn(&db, &session.id, None, None).unwrap();
    assert!(matches!(
        move_session_project(&db, &session.id, &source.to_string_lossy()).unwrap(),
        MoveSessionProjectResult::Busy
    ));
    end_turn(&db, &turn, "aborted", None, None, false).unwrap();
    assert!(matches!(
        move_session_project(&db, &session.id, &source.to_string_lossy()).unwrap(),
        MoveSessionProjectResult::Moved(_)
    ));

    assert!(matches!(
        move_session_project(&db, "missing-session", &source.to_string_lossy()).unwrap(),
        MoveSessionProjectResult::NotFound
    ));
    assert!(move_session_project(&db, &session.id, "   ").is_err());
}

#[test]
fn aborted_turn_does_not_create_notification() {
    let db = test_db();
    let session = create_session(&db, None, None, None, None, None).unwrap();
    let turn = begin_turn(&db, &session.id, None, None).unwrap();

    let ended = end_turn(&db, &turn, "aborted", None, None, true).unwrap();

    assert!(ended.updated);
    assert!(ended.notification.is_none());
    let notification_count: i64 = db
        .conn()
        .query_row("SELECT COUNT(*) FROM notifications", [], |row| row.get(0))
        .unwrap();
    assert_eq!(notification_count, 0);
}

#[test]
fn visible_turn_does_not_create_notification() {
    let db = test_db();
    let session = create_session(&db, None, None, None, None, None).unwrap();
    let turn = begin_turn(&db, &session.id, None, None).unwrap();

    let ended = end_turn(&db, &turn, "completed", None, None, false).unwrap();

    assert!(ended.updated);
    assert!(ended.notification.is_none());
    let (status, notification_count): (String, i64) = db
        .conn()
        .query_row(
            "SELECT t.status, COUNT(n.id)
             FROM turns t
             LEFT JOIN notifications n ON n.turn_id = t.id
             WHERE t.id = ?1
             GROUP BY t.status",
            params![turn],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    assert_eq!(status, "completed");
    assert_eq!(notification_count, 0);
}

#[test]
fn replace_messages_preserves_owning_turn_ids() {
    let db = test_db();
    let session = create_session(&db, None, None, None, None, None).unwrap();
    let turn = begin_turn(&db, &session.id, Some("p1"), Some("m1")).unwrap();
    let kept = user_msg("a", "one", "2025-05-01T00:00:00Z");
    append_message(&db, &session.id, &kept, Some(&turn)).unwrap();
    append_message(
        &db,
        &session.id,
        &user_msg("b", "two", "2025-05-01T00:00:01Z"),
        Some(&turn),
    )
    .unwrap();

    replace_messages(&db, &session.id, &[kept]).unwrap();
    let owning: Option<String> = db
        .conn()
        .query_row(
            "SELECT turn_id FROM messages WHERE session_id = ?1 AND id = 'a'",
            params![session.id],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(owning.as_deref(), Some(turn.as_str()));
}

#[test]
fn completed_turn_end_drops_checkpoint_once_the_final_row_landed() {
    let db = test_db();
    let session = create_session(&db, None, None, None, None, None).unwrap();
    let turn = begin_turn(&db, &session.id, None, None).unwrap();
    assert!(save_inflight_message(
        &db,
        &session.id,
        Some(&turn),
        &streaming_assistant("a1", "partial")
    )
    .unwrap());
    let mut final_row = streaming_assistant("a1", "partial and complete");
    final_row.status = Some("complete".into());
    append_message(&db, &session.id, &final_row, Some(&turn)).unwrap();

    let ended = end_turn_settling(&db, &turn, "completed", None, None, false, false).unwrap();
    assert!(ended.updated);
    assert!(ended.recovered.is_none());
    assert!(!transcripts::inflight_path(db.data_dir(), &session.id)
        .unwrap()
        .exists());
    let messages = get_session(&db, &session.id).unwrap().unwrap().messages;
    assert_eq!(messages.len(), 1);
    assert_eq!(messages[0].content, "partial and complete");
    assert_eq!(messages[0].status.as_deref(), Some("complete"));
}

#[test]
fn delete_session_removes_the_checkpoint_file() {
    let db = test_db();
    let session = create_session(&db, None, None, None, None, None).unwrap();
    assert!(save_inflight_message(
        &db,
        &session.id,
        None,
        &streaming_assistant("a1", "partial")
    )
    .unwrap());
    let path = transcripts::inflight_path(db.data_dir(), &session.id).unwrap();
    assert!(path.exists());
    assert!(delete_session(&db, &session.id).unwrap());
    assert!(!path.exists());
    assert!(recover_inflight_messages(&db, true).unwrap().is_empty());
}
