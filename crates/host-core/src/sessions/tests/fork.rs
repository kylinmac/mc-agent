use super::*;

#[test]
fn fork_remaps_each_checkpoint_in_the_chain_on_its_own() {
    let db = test_db();
    let session = create_session(&db, None, None, None, None, None).unwrap();
    let messages = [
        user_msg("u1", "old", "2026-07-28T00:00:00Z"),
        user_msg("u2", "recent", "2026-07-28T00:00:01Z"),
    ];
    for message in &messages {
        append_message(&db, &session.id, message, None).unwrap();
    }
    append_compaction(&db, &session.id, &checkpoint("u1", "u1")).unwrap();
    append_compaction(&db, &session.id, &checkpoint("u2", "u2")).unwrap();

    let ForkSessionResult::Created(full) =
        fork_session_through(&db, &session.id, None, None).unwrap()
    else {
        panic!("expected fork");
    };
    assert_eq!(
        full.compactions
            .iter()
            .map(|record| record.through_message_id.as_str())
            .collect::<Vec<_>>(),
        vec![full.messages[0].id.as_str(), full.messages[1].id.as_str()]
    );

    // A fork that cuts the later anchor keeps the earlier checkpoint.
    let ForkSessionResult::Created(partial) =
        fork_session_through(&db, &session.id, None, Some("u1")).unwrap()
    else {
        panic!("expected fork");
    };
    assert_eq!(partial.compactions.len(), 1);
    assert_eq!(
        partial.compactions[0].through_message_id,
        partial.messages[0].id
    );
}

#[test]
fn fork_copies_only_a_checkpoint_whose_boundary_is_included() {
    let db = test_db();
    let session = create_session(&db, None, None, None, None, None).unwrap();
    let messages = [
        user_msg("u1", "old", "2026-07-28T00:00:00Z"),
        user_msg("u2", "recent", "2026-07-28T00:00:01Z"),
    ];
    for message in &messages {
        append_message(&db, &session.id, message, None).unwrap();
    }
    append_compaction(&db, &session.id, &checkpoint("u2", "u2")).unwrap();

    let ForkSessionResult::Created(before) =
        fork_session_through(&db, &session.id, None, Some("u1")).unwrap()
    else {
        panic!("expected fork");
    };
    assert!(before.compaction.is_none());

    let ForkSessionResult::Created(including) =
        fork_session_through(&db, &session.id, None, Some("u2")).unwrap()
    else {
        panic!("expected fork");
    };
    let copied = including.compaction.unwrap();
    assert_eq!(
        copied.first_kept_message_id.as_deref(),
        Some(including.messages[1].id.as_str())
    );
    assert_eq!(copied.through_message_id, including.messages[1].id);
    assert_ne!(
        copied.id,
        get_session(&db, &session.id)
            .unwrap()
            .unwrap()
            .compaction
            .unwrap()
            .id
    );
}

#[test]
fn fork_index_failure_removes_copied_inputs_and_transcript() {
    let db = test_db();
    let source = create_session(&db, None, None, None, None, None).unwrap();
    let pasted = crate::scratch::session_dir(db.data_dir(), &source.id)
        .unwrap()
        .join("pasted");
    std::fs::create_dir_all(&pasted).unwrap();
    let file = pasted.join("note.txt");
    std::fs::write(&file, "keep source").unwrap();
    append_message(
        &db,
        &source.id,
        &user_msg(
            "input",
            &format!("@{}", file.display()),
            "2025-05-01T00:00:00Z",
        ),
        None,
    )
    .unwrap();
    let files_before = std::fs::read_dir(db.data_dir().join("sessions"))
        .unwrap()
        .count();
    db.conn().execute_batch("CREATE TRIGGER fail_fork BEFORE INSERT ON sessions BEGIN SELECT RAISE(ABORT, 'injected index failure'); END;").unwrap();
    let result = fork_session_through(&db, &source.id, None, None);
    assert!(result.is_err());
    assert_eq!(
        std::fs::read_dir(db.data_dir().join("sessions"))
            .unwrap()
            .count(),
        files_before
    );
    assert_eq!(
        std::fs::read_dir(crate::scratch::base_dir(db.data_dir()))
            .unwrap()
            .count(),
        1
    );
    assert_eq!(std::fs::read_to_string(file).unwrap(), "keep source");
}

#[test]
fn fork_copies_referenced_visualizations_so_cards_survive_source_deletion() {
    let db = test_db();
    let source = create_session(&db, Some("Charts".into()), None, None, None, None).unwrap();
    let dir = crate::visualizations::session_dir(db.data_dir(), &source.id).unwrap();
    std::fs::create_dir_all(&dir).unwrap();
    let chart = dir.join("chart.html");
    std::fs::write(&chart, "<p>chart</p>").unwrap();
    std::fs::write(dir.join("unused.html"), "<p>unused</p>").unwrap();
    let text = format!("::visualize{}", json!({"path": chart}));
    append_message(
        &db,
        &source.id,
        &UiMessage {
            role: "assistant".into(),
            ..user_msg("viz-1", &text, "2025-05-01T00:00:00Z")
        },
        None,
    )
    .unwrap();
    let ForkSessionResult::Created(child) =
        fork_session_through(&db, &source.id, None, None).unwrap()
    else {
        panic!("expected child")
    };
    let child_dir = crate::visualizations::session_dir(db.data_dir(), &child.summary.id).unwrap();
    let child_chart = child_dir.join("chart.html");
    assert_eq!(
        child.messages[0].content,
        format!("::visualize{}", json!({"path": child_chart}))
    );
    assert!(!child_dir.join("unused.html").exists());
    delete_session(&db, &source.id).unwrap();
    crate::visualizations::remove_session_dir(db.data_dir(), &source.id);
    assert_eq!(
        std::fs::read_to_string(&child_chart).unwrap(),
        "<p>chart</p>"
    );
}

#[test]
fn fork_preserves_referenced_pasted_files_independently() {
    let db = test_db();
    let source = create_session(&db, Some("Attachments".into()), None, None, None, None).unwrap();
    let scratch = crate::scratch::session_dir(db.data_dir(), &source.id).unwrap();
    let pasted = scratch.join("pasted");
    std::fs::create_dir_all(&pasted).unwrap();
    let first = pasted.join("first note.txt");
    let later = pasted.join("later.png");
    std::fs::write(&first, "original reference bytes").unwrap();
    std::fs::write(&later, b"image bytes").unwrap();
    std::fs::write(pasted.join("unused.txt"), "do not copy").unwrap();
    let first_text = format!("Read @\"{}\"", first.display());
    append_message(
        &db,
        &source.id,
        &user_msg("paste-1", &first_text, "2025-05-01T00:00:00Z"),
        None,
    )
    .unwrap();
    append_message(
        &db,
        &source.id,
        &user_msg(
            "paste-2",
            &format!("@{}", later.display()),
            "2025-05-01T00:00:01Z",
        ),
        None,
    )
    .unwrap();
    let ForkSessionResult::Created(child) =
        fork_session_through(&db, &source.id, None, Some("paste-1")).unwrap()
    else {
        panic!("expected child")
    };
    let child_scratch = crate::scratch::session_dir(db.data_dir(), &child.summary.id).unwrap();
    let child_file = child_scratch.join("pasted").join("first note.txt");
    assert_eq!(
        std::fs::read_to_string(&child_file).unwrap(),
        "original reference bytes"
    );
    assert_eq!(
        child.messages[0].content,
        format!("Read @\"{}\"", child_file.display())
    );
    assert!(!child_scratch.join("pasted/later.png").exists());
    assert!(!child_scratch.join("pasted/unused.txt").exists());
    assert_eq!(
        get_session(&db, &source.id).unwrap().unwrap().messages[0].content,
        first_text
    );
    delete_session(&db, &source.id).unwrap();
    crate::scratch::remove_session_dir(db.data_dir(), &source.id);
    assert_eq!(
        std::fs::read_to_string(&child_file).unwrap(),
        "original reference bytes"
    );
    assert_eq!(
        get_session(&db, &child.summary.id)
            .unwrap()
            .unwrap()
            .messages[0]
            .content,
        child.messages[0].content
    );
    let ForkSessionResult::Created(grandchild) =
        fork_session_through(&db, &child.summary.id, None, None).unwrap()
    else {
        panic!("expected grandchild")
    };
    let grandchild_file = crate::scratch::session_dir(db.data_dir(), &grandchild.summary.id)
        .unwrap()
        .join("pasted")
        .join("first note.txt");
    assert_eq!(
        std::fs::read_to_string(&grandchild_file).unwrap(),
        "original reference bytes"
    );
    assert_eq!(
        grandchild.messages[0].content,
        format!("Read @\"{}\"", grandchild_file.display())
    );
}

#[test]
fn fork_session_clones_active_transcript_and_configuration() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("pi.sqlite");
    let db = Database::open(&path).unwrap();
    let source = create_session_with_thinking(
        &db,
        Some("Source".into()),
        Some("chat".into()),
        Some("provider-1".into()),
        Some("model-1".into()),
        Some("/tmp/project".into()),
        Some("high".into()),
    )
    .unwrap();
    configure_session_with_thinking(
        &db,
        &source.id,
        "chat",
        Some("provider-1"),
        Some("model-1"),
        Some("high"),
        Some("auto"),
    )
    .unwrap();

    let mut user = user_msg("user-1", "fork this", "2025-05-01T00:00:00Z");
    user.revision_root_id = Some("user-1".into());
    user.revision_count = Some(2);
    user.active_revision = Some(2);
    let mut tool = user_msg("tool-1", "ok", "2025-05-01T00:00:01Z");
    tool.role = "tool".into();
    tool.tool_name = Some("Read".into());
    tool.tool_call_id = Some("call-1".into());
    tool.tool_status = Some("success".into());
    append_message(&db, &source.id, &user, None).unwrap();
    append_message(&db, &source.id, &tool, None).unwrap();
    save_message_revision(&db, &source.id, "user-1", &[user.clone()], true).unwrap();

    let ForkSessionResult::Created(fork) =
        fork_session_through(&db, &source.id, Some("Source (branch)"), None).unwrap()
    else {
        panic!("expected forked session");
    };
    let source_after = get_session(&db, &source.id).unwrap().unwrap();

    assert_ne!(fork.summary.id, source.id);
    assert_eq!(fork.summary.title, "Source (branch)");
    assert_eq!(fork.summary.project_path, source.project_path);
    assert_eq!(fork.summary.provider_id.as_deref(), Some("provider-1"));
    assert_eq!(fork.summary.model_id.as_deref(), Some("model-1"));
    assert_eq!(fork.summary.mode, "plan");
    assert_eq!(fork.summary.thinking_level, "high");
    assert_eq!(fork.summary.permission_mode, "auto");
    assert_eq!(fork.messages.len(), 2);
    assert_eq!(source_after.messages[0].id, "user-1");
    assert_eq!(
        source_after.messages[1].tool_call_id.as_deref(),
        Some("call-1")
    );
    assert_ne!(fork.messages[0].id, source_after.messages[0].id);
    assert_ne!(fork.messages[1].id, source_after.messages[1].id);
    assert_ne!(
        fork.messages[1].tool_call_id,
        source_after.messages[1].tool_call_id
    );
    assert_eq!(fork.messages[0].content, "fork this");
    assert_eq!(fork.messages[0].revision_root_id, None);
    assert_eq!(fork.messages[0].revision_count, None);
    assert_eq!(fork.messages[0].active_revision, None);
    assert!(list_message_revisions(&db, &fork.summary.id, "user-1")
        .unwrap()
        .is_empty());
    assert!(
        !transcripts::revisions_path(db.data_dir(), &fork.summary.id)
            .unwrap()
            .exists()
    );
    assert!(search_messages(&db, "fork", 10)
        .unwrap()
        .iter()
        .any(|hit| hit.session_id == fork.summary.id));

    append_message(
        &db,
        &fork.summary.id,
        &user_msg("child-only", "continue here", "2025-05-01T00:00:02Z"),
        None,
    )
    .unwrap();
    configure_session_with_thinking(
        &db,
        &fork.summary.id,
        "agent",
        Some("provider-2"),
        Some("model-2"),
        Some("off"),
        Some("ask"),
    )
    .unwrap();
    let source_final = get_session(&db, &source.id).unwrap().unwrap();
    let fork_final = get_session(&db, &fork.summary.id).unwrap().unwrap();
    assert_eq!(source_final.messages.len(), 2);
    assert_eq!(source_final.summary.mode, "plan");
    assert_eq!(source_final.summary.model_id.as_deref(), Some("model-1"));
    assert_eq!(fork_final.messages.len(), 3);
    assert_eq!(fork_final.summary.mode, "agent");
    assert_eq!(fork_final.summary.model_id.as_deref(), Some("model-2"));
    assert_eq!(fork_final.summary.thinking_level, "off");
    assert_eq!(fork_final.summary.permission_mode, "ask");

    drop(db);
    let db = Database::open(&path).unwrap();
    let source_reopened = get_session(&db, &source.id).unwrap().unwrap();
    let fork_reopened = get_session(&db, &fork.summary.id).unwrap().unwrap();
    assert_eq!(source_reopened.messages.len(), 2);
    assert_eq!(fork_reopened.messages.len(), 3);
    assert_eq!(fork_reopened.messages[2].content, "continue here");

    assert!(matches!(
        fork_session_through(&db, "missing", None, None).unwrap(),
        ForkSessionResult::NotFound
    ));
    let turn = begin_turn(&db, &source.id, None, None).unwrap();
    assert!(matches!(
        fork_session_through(&db, &source.id, None, None).unwrap(),
        ForkSessionResult::Busy
    ));
    end_turn(&db, &turn, "aborted", None, None, false).unwrap();
    delete_session(&db, &source.id).unwrap();
    assert!(get_session(&db, &source.id).unwrap().is_none());
    assert_eq!(
        get_session(&db, &fork.summary.id)
            .unwrap()
            .unwrap()
            .messages
            .len(),
        3
    );
}

#[test]
fn completed_reply_fork_during_later_turn_preserves_the_running_source() {
    let db = test_db();
    let source = create_session(&db, Some("Source".into()), None, None, None, None).unwrap();
    let first = begin_turn(&db, &source.id, None, None).unwrap();
    let mut reply = user_msg("reply", "finished reply", "2025-05-01T00:00:01Z");
    reply.role = "assistant".into();
    append_message(
        &db,
        &source.id,
        &user_msg("first", "first prompt", "2025-05-01T00:00:00Z"),
        Some(&first),
    )
    .unwrap();
    append_message(&db, &source.id, &reply, Some(&first)).unwrap();
    end_turn(&db, &first, "completed", None, None, false).unwrap();
    let running = begin_turn(&db, &source.id, None, None).unwrap();
    // Admission can precede persistence of the next user row.
    let ForkSessionResult::Created(early) =
        fork_session_through(&db, &source.id, None, Some("reply")).unwrap()
    else {
        panic!("completed history should fork during a later turn");
    };
    assert_eq!(early.messages.len(), 2);
    append_message(
        &db,
        &source.id,
        &user_msg("second", "second prompt", "2025-05-01T00:00:02Z"),
        Some(&running),
    )
    .unwrap();
    let mut current = reply.clone();
    current.id = "current".into();
    current.content = "intermediate completed response in a running tool loop".into();
    append_message(&db, &source.id, &current, Some(&running)).unwrap();
    let before = get_session(&db, &source.id).unwrap().unwrap();
    let ForkSessionResult::Created(child) =
        fork_session_through(&db, &source.id, None, Some("reply")).unwrap()
    else {
        panic!("completed history should fork while the source streams");
    };
    assert_eq!(child.messages.len(), 2);
    assert_eq!(child.messages[1].content, "finished reply");
    assert_ne!(child.messages[1].id, "reply");
    assert!(session_has_running_turn(&db, &source.id).unwrap());
    assert!(!session_has_running_turn(&db, &child.summary.id).unwrap());
    assert_eq!(
        get_session(&db, &source.id)
            .unwrap()
            .unwrap()
            .messages
            .len(),
        before.messages.len()
    );
    for anchor in [
        None,
        Some(""),
        Some("first"),
        Some("second"),
        Some("current"),
    ] {
        assert!(matches!(
            fork_session_through(&db, &source.id, None, anchor).unwrap(),
            ForkSessionResult::Busy
        ));
    }
    assert!(matches!(
        fork_session_through(&db, &source.id, None, Some("missing")).unwrap(),
        ForkSessionResult::NotFound
    ));
    // The original turn can still finish after the child was published.
    current.id = "final".into();
    current.content = "source finished independently".into();
    append_message(&db, &source.id, &current, Some(&running)).unwrap();
    end_turn(&db, &running, "completed", None, None, false).unwrap();
    assert_eq!(
        get_session(&db, &source.id)
            .unwrap()
            .unwrap()
            .messages
            .len(),
        5
    );
    assert_eq!(
        get_session(&db, &child.summary.id)
            .unwrap()
            .unwrap()
            .messages
            .len(),
        2
    );
    // A child has no copied turn ids, but its completed history remains forkable.
    let child_turn = begin_turn(&db, &child.summary.id, None, None).unwrap();
    assert!(matches!(
        fork_session_through(&db, &child.summary.id, None, Some(&child.messages[1].id)).unwrap(),
        ForkSessionResult::Created(_)
    ));
    end_turn(&db, &child_turn, "aborted", None, None, false).unwrap();
}

#[test]
fn message_scoped_fork_stops_at_selected_assistant_response() {
    let db = test_db();
    let source = create_session(&db, Some("Source".into()), None, None, None, None).unwrap();
    let mut assistant_a = user_msg("assistant-a", "first response", "2025-05-01T00:00:01Z");
    assistant_a.role = "assistant".into();
    let mut assistant_b = user_msg("assistant-b", "second response", "2025-05-01T00:00:03Z");
    assistant_b.role = "assistant".into();
    for message in [
        user_msg("user-a", "first prompt", "2025-05-01T00:00:00Z"),
        assistant_a,
        user_msg("user-b", "second prompt", "2025-05-01T00:00:02Z"),
        assistant_b,
    ] {
        append_message(&db, &source.id, &message, None).unwrap();
    }

    let ForkSessionResult::Created(fork) = fork_session_through(
        &db,
        &source.id,
        Some("Response branch"),
        Some("assistant-a"),
    )
    .unwrap() else {
        panic!("expected message-scoped fork");
    };

    assert_eq!(fork.messages.len(), 2);
    assert_eq!(fork.messages[0].content, "first prompt");
    assert_eq!(fork.messages[1].content, "first response");
    assert_ne!(fork.messages[1].id, "assistant-a");
    assert_eq!(
        get_session(&db, &source.id)
            .unwrap()
            .unwrap()
            .messages
            .len(),
        4
    );
    assert!(matches!(
        fork_session_through(&db, &source.id, None, Some("missing")).unwrap(),
        ForkSessionResult::NotFound
    ));
}
