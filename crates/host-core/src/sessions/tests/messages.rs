use super::*;

#[test]
fn subagent_attribution_roundtrips() {
    let db = test_db();
    let session = create_session(&db, None, None, None, None, Some("/tmp/x".into())).unwrap();
    let mut assistant = user_msg("m1", "Found it.", "2025-05-01T00:00:00Z");
    assistant.role = "assistant".into();
    assistant.parent_tool_call_id = Some("task-1".into());
    assistant.agent_name = Some("explorer".into());
    append_message(&db, &session.id, &assistant, None).unwrap();

    let mut tool = user_msg("m2", "ok", "2025-05-01T00:00:01Z");
    tool.role = "tool".into();
    tool.tool_name = Some("Read".into());
    tool.tool_call_id = Some("child-read".into());
    tool.tool_status = Some("success".into());
    tool.parent_tool_call_id = Some("task-1".into());
    tool.agent_name = Some("explorer".into());
    append_message(&db, &session.id, &tool, None).unwrap();

    let detail = get_session(&db, &session.id).unwrap().unwrap();
    for message in &detail.messages {
        assert_eq!(message.parent_tool_call_id.as_deref(), Some("task-1"));
        assert_eq!(message.agent_name.as_deref(), Some("explorer"));
    }
    // A row without attribution stays unattributed rather than inheriting one.
    append_message(
        &db,
        &session.id,
        &user_msg("m3", "next", "2025-05-01T00:00:02Z"),
        None,
    )
    .unwrap();
    let detail = get_session(&db, &session.id).unwrap().unwrap();
    assert_eq!(detail.messages[2].parent_tool_call_id, None);
    assert_eq!(detail.messages[2].agent_name, None);
}

#[test]
fn append_and_roundtrip_tool_message() {
    let db = test_db();
    let session = create_session(&db, None, None, None, None, Some("/tmp/x".into())).unwrap();
    assert_eq!(session.message_count, 0);
    append_message(
        &db,
        &session.id,
        &user_msg("m1", "写一个文件", "2025-05-01T00:00:00Z"),
        None,
    )
    .unwrap();
    let tool = UiMessage {
        id: "m2".into(),
        role: "tool".into(),
        content: "ok".into(),
        command: None,
        skill_mentions: None,
        attachments: None,
        voice_origin: None,
        steering: None,
        created_at: "2025-05-01T00:00:02Z".into(),
        thinking: None,
        status: Some("complete".into()),
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
        tool_name: Some("Write".into()),
        tool_call_id: Some("c1".into()),
        tool_status: Some("success".into()),
        tool_args: Some(json!({ "path": "a.txt" })),
        tool_result: Some(json!({ "ok": true })),
        tool_completed_at: Some("2025-05-01T00:00:03Z".into()),
        tool_duration_ms: Some(1_000),
        is_error: None,
        parent_tool_call_id: None,
        nested_parent_tool_call_id: None,
        agent_name: None,
        hosted_search: None,
        model_system: None,
        session_message: None,
    };
    append_message(&db, &session.id, &tool, None).unwrap();
    // Host recovery may replay the Electron persistence outbox; a message
    // id must make that replay a no-op.
    append_message(&db, &session.id, &tool, None).unwrap();

    let detail = get_session(&db, &session.id).unwrap().unwrap();
    assert_eq!(detail.messages.len(), 2);
    assert_eq!(detail.summary.message_count, 2);
    let m2 = &detail.messages[1];
    assert_eq!(m2.role, "tool");
    assert_eq!(m2.tool_name.as_deref(), Some("Write"));
    assert_eq!(m2.tool_call_id.as_deref(), Some("c1"));
    assert_eq!(m2.tool_status.as_deref(), Some("success"));
    assert_eq!(m2.tool_args, Some(json!({ "path": "a.txt" })));
    assert_eq!(m2.tool_result, Some(json!({ "ok": true })));
    assert_eq!(
        m2.tool_completed_at.as_deref(),
        Some("2025-05-01T00:00:03Z")
    );
    assert_eq!(m2.tool_duration_ms, Some(1_000));
    assert_eq!(m2.content, "ok");
    assert_eq!(m2.status.as_deref(), Some("complete"));

    let mut review_tool = tool.clone();
    review_tool.tool_result = Some(json!({
        "ok": true,
        "details": {
            "root": "workspace",
            "review": {
                "snapshotId": "snapshot-1",
                "state": "active"
            }
        }
    }));
    replace_messages(
        &db,
        &session.id,
        &[
            user_msg("m1", "写一个文件", "2025-05-01T00:00:00Z"),
            review_tool,
        ],
    )
    .unwrap();
    assert!(update_tool_review_state(&db, &session.id, "m2", "snapshot-1", "rolledBack",).unwrap());
    let updated = get_session(&db, &session.id).unwrap().unwrap();
    assert_eq!(updated.summary.message_count, 2);
    assert_eq!(
        updated.messages[1].tool_result,
        Some(json!({
            "ok": true,
            "details": {
                "root": "workspace",
                "review": {
                    "snapshotId": "snapshot-1",
                    "state": "rolledBack"
                }
            }
        }))
    );

    // seq allocation is monotonic per session.
    let last_seq: i64 = db
        .conn()
        .query_row(
            "SELECT last_seq FROM sessions WHERE id = ?1",
            params![session.id],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(last_seq, 2);
}

#[test]
fn delegation_settlement_updates_only_its_running_snapshot() {
    let db = test_db();
    let first = create_session(&db, None, None, None, None, None).unwrap();
    let second = create_session(&db, None, None, None, None, None).unwrap();
    let mut task = user_msg("task-shared-id", "partial", "2026-10-05T00:00:00Z");
    task.role = "tool".into();
    task.tool_name = Some("Task".into());
    task.tool_call_id = Some(task.id.clone());
    task.tool_args = Some(json!({"agent": "explorer"}));
    task.tool_result =
        Some(json!({"details": {"delegationId": "delegate-A", "status": "running"}}));
    append_message(&db, &first.id, &task, None).unwrap();
    append_message(&db, &second.id, &task, None).unwrap();
    let mut stopped = task.clone();
    stopped.tool_result =
        Some(json!({"details": {"delegationId": "delegate-A", "status": "stopped"}}));
    stopped.tool_args = Some(json!({"agent": "changed"}));
    append_message(&db, &second.id, &stopped, None).unwrap();
    // Late replay cannot reopen a settled delegation, including namespaced IDs.
    append_message(&db, &second.id, &task, None).unwrap();
    let read = |id: &str| get_session(&db, id).unwrap().unwrap().messages;
    assert_eq!(read(&second.id).len(), 1);
    assert_eq!(read(&second.id)[0].tool_result, stopped.tool_result);
    assert_eq!(read(&second.id)[0].tool_args, task.tool_args);
    assert_eq!(read(&first.id)[0].tool_result, task.tool_result);
    let mut foreign = stopped.clone();
    foreign.tool_result =
        Some(json!({"details": {"delegationId": "different", "status": "stopped"}}));
    append_message(&db, &first.id, &foreign, None).unwrap();
    assert_eq!(read(&first.id)[0].tool_result, task.tool_result);
    append_message(&db, &first.id, &stopped, None).unwrap();
    append_message(&db, &first.id, &task, None).unwrap();
    assert_eq!(read(&first.id)[0].tool_result, stopped.tool_result);
}

#[test]
fn append_message_does_not_duplicate_a_unique_failed_jsonl_leftover() {
    let db = test_db();
    let first = create_session(&db, None, None, None, None, None).unwrap();
    let second = create_session(&db, None, None, None, None, None).unwrap();
    let colliding = user_msg("call_421522", "leftover", "2026-09-16T15:42:41Z");
    append_message(&db, &first.id, &colliding, None).unwrap();
    let (record, _) = ui_to_record(&colliding);
    transcripts::append_message(db.data_dir(), &second.id, &second.created_at, &record).unwrap();
    append_message(&db, &second.id, &colliding, None).unwrap();
    assert_eq!(
        transcripts::read_transcript(db.data_dir(), &second.id)
            .unwrap()
            .len(),
        1
    );
    assert_eq!(
        get_session(&db, &second.id)
            .unwrap()
            .unwrap()
            .messages
            .len(),
        1
    );
}

#[test]
fn user_attachments_roundtrip_as_canonical_blocks() {
    let db = test_db();
    let session = create_session(&db, None, None, None, None, None).unwrap();
    let mut user = user_msg("image-1", "这是什么", "2025-05-01T00:00:00Z");
    user.attachments = Some(vec![MessageAttachment {
        kind: "image".into(),
        name: "image.png".into(),
        reference: "attachments/abc123".into(),
        mime_type: Some("image/png".into()),
        size: Some(42),
        text: None,
        inline_path: Some("@/scratch/pasted/image.png".into()),
    }]);

    append_message(&db, &session.id, &user, None).unwrap();

    let detail = get_session(&db, &session.id).unwrap().unwrap();
    assert_eq!(detail.messages[0].attachments, user.attachments);
    assert_eq!(detail.messages[0].content, "这是什么");

    let record = transcripts::read_transcript(db.data_dir(), &session.id)
        .unwrap()
        .into_iter()
        .find(|record| record.id == user.id)
        .expect("attachment message record");
    let blocks = record.blocks;
    assert_eq!(blocks[1]["type"], "attachment");
    assert_eq!(blocks[1]["ref"], "attachments/abc123");
    assert_eq!(blocks[1]["inlinePath"], "@/scratch/pasted/image.png");
    assert!(blocks[1].get("data").is_none());
}

#[test]
fn a_window_over_a_duplicated_id_stays_complete_and_reaches_the_head() {
    // Physical lines can exceed distinct messages: a retried append leaves
    // one id on two lines and reads dedupe keep-last. A window is therefore
    // allowed to return fewer messages than its limit, and what matters is
    // that paging still covers every message exactly once.
    let db = test_db();
    let session = create_session(&db, None, None, None, None, None).unwrap();
    for index in 0..4 {
        append_message(
            &db,
            &session.id,
            &user_msg(
                &format!("m{index}"),
                &format!("body {index}"),
                "2025-05-01T00:00:00Z",
            ),
            None,
        )
        .unwrap();
    }
    // Duplicate an *older* line so the duplicate pair straddles a page edge.
    let (record, _) = ui_to_record(&user_msg("m1", "body 1 retried", "2025-05-01T00:00:01Z"));
    transcripts::append_message(db.data_dir(), &session.id, "2025-05-01T00:00:00Z", &record)
        .unwrap();

    let mut collected: Vec<String> = Vec::new();
    let mut before: Option<i64> = None;
    loop {
        let page = get_session_with_options(
            &db,
            &session.id,
            SessionReadOptions {
                message_around: None,
                message_before: before,
                message_limit: Some(2),
                content_limit: None,
            },
        )
        .unwrap()
        .unwrap();
        let mut ids: Vec<String> = page.messages.iter().map(|m| m.id.clone()).collect();
        ids.append(&mut collected);
        collected = ids;
        let start = page.message_start.unwrap();
        if start == 0 || page.has_more_before != Some(true) {
            break;
        }
        before = Some(start);
    }
    // Every message stays reachable by paging, which is the guarantee that
    // matters: the pre-change clamp against `last_seq` dropped the newest
    // ones entirely.
    for id in ["m0", "m1", "m2", "m3"] {
        assert!(
            collected.iter().any(|seen| seen == id),
            "missing {id} in {collected:?}"
        );
    }
    // The retried line is physically last, so it is the newest line the tail
    // window returns; the keep-last content wins and the renderer merges the
    // two sightings of that id. A page is always internally deduplicated.
    let newest = get_session_with_options(
        &db,
        &session.id,
        SessionReadOptions {
            message_around: None,
            message_before: None,
            message_limit: Some(2),
            content_limit: None,
        },
    )
    .unwrap()
    .unwrap();
    let newest_ids: Vec<&str> = newest.messages.iter().map(|m| m.id.as_str()).collect();
    assert_eq!(newest_ids, ["m3", "m1"]);
    assert_eq!(newest.messages[1].content, "body 1 retried");
    // An uncapped read still collapses the pair to one message.
    let whole = get_session(&db, &session.id).unwrap().unwrap();
    assert_eq!(whole.messages.len(), 4);
}

#[test]
fn bounded_reads_use_physical_line_positions_not_the_dedup_counter() {
    // A retried append leaves the same message id on two file lines. The
    // index counter (`last_seq`) counts it once, so a window clamped
    // against that counter cut one line short and hid the newest message.
    let db = test_db();
    let session = create_session(&db, None, None, None, None, None).unwrap();
    for index in 0..4 {
        append_message(
            &db,
            &session.id,
            &user_msg(
                &format!("m{index}"),
                &format!("body {index}"),
                "2025-05-01T00:00:00Z",
            ),
            None,
        )
        .unwrap();
    }
    // Append one line straight to the file, as a crash between the durable
    // file append and its index commit does. `last_seq` stays at 4 while the
    // file holds 5 message lines, and it never catches up.
    let (record, _) = ui_to_record(&user_msg("m4", "newest", "2025-05-01T00:00:04Z"));
    transcripts::append_message(db.data_dir(), &session.id, "2025-05-01T00:00:00Z", &record)
        .unwrap();
    let last_seq: i64 = db
        .conn()
        .query_row(
            "SELECT last_seq FROM sessions WHERE id = ?1",
            params![session.id],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(last_seq, 4);

    let page = get_session_with_options(
        &db,
        &session.id,
        SessionReadOptions {
            message_around: None,
            message_before: None,
            message_limit: Some(2),
            content_limit: None,
        },
    )
    .unwrap()
    .unwrap();
    // Clamping the window to `last_seq` used to cut the newest line off the
    // tail, so the message existed on disk but never reached the renderer.
    let ids: Vec<&str> = page.messages.iter().map(|m| m.id.as_str()).collect();
    assert_eq!(ids, ["m3", "m4"]);
    assert_eq!(page.has_more_before, Some(true));

    // Paging backwards from the reported start reaches the true head
    // without skipping a message.
    let mut seen: Vec<String> = page.messages.iter().map(|m| m.id.clone()).collect();
    let mut start = page.message_start.unwrap();
    while start > 0 {
        let older = get_session_with_options(
            &db,
            &session.id,
            SessionReadOptions {
                message_around: None,
                message_before: Some(start),
                message_limit: Some(2),
                content_limit: None,
            },
        )
        .unwrap()
        .unwrap();
        let mut ids: Vec<String> = older.messages.iter().map(|m| m.id.clone()).collect();
        ids.append(&mut seen);
        seen = ids;
        start = older.message_start.unwrap();
    }
    assert_eq!(seen, ["m0", "m1", "m2", "m3", "m4"]);
}

#[test]
fn a_replaced_message_keeps_its_position_for_an_around_window() {
    // A branch stamp and a terminal steering snapshot both rewrite one
    // existing message through `transcripts::update_message`. That call
    // splices the line where it stands. Writing the replacement at the end
    // of the file instead would still resolve the *content* — reads dedupe
    // keep-last — but it would move the line, and an `around` window is
    // centred on a physical position, so a search jump to an updated message
    // would open on the tail of the session. This pins the geometry, not
    // just the text.
    let db = test_db();
    let session = create_session(&db, None, None, None, None, None).unwrap();
    for index in 0..12 {
        append_message(
            &db,
            &session.id,
            &user_msg(
                &format!("m{index}"),
                &format!("body {index}"),
                "2025-05-01T00:00:00Z",
            ),
            None,
        )
        .unwrap();
    }
    let replaced = user_msg("m5", "body 5 newest snapshot", "2025-05-01T00:00:00Z");
    let (record, _) = ui_to_record(&replaced);
    assert!(transcripts::update_message(db.data_dir(), &session.id, &record).unwrap());

    let page = get_session_with_options(
        &db,
        &session.id,
        SessionReadOptions {
            message_around: Some("m5".to_string()),
            message_before: None,
            message_limit: Some(4),
            content_limit: None,
        },
    )
    .unwrap()
    .unwrap();
    let ids: Vec<&str> = page.messages.iter().map(|m| m.id.as_str()).collect();
    assert!(
        ids.contains(&"m5"),
        "the anchor must be inside its own window: {ids:?}"
    );
    // Numeric, not lexicographic: "m10" < "m5" as strings, which would let
    // a tail-window regression through.
    let index_of = |id: &str| id.strip_prefix('m').and_then(|n| n.parse::<usize>().ok());
    assert!(
        ids.iter().any(|id| index_of(id).is_some_and(|n| n < 5)),
        "messages before the anchor must stay reachable: {ids:?}"
    );
    assert!(
        ids.iter().any(|id| index_of(id).is_some_and(|n| n > 5)),
        "messages after the anchor must stay reachable: {ids:?}"
    );
    assert_eq!(
        page.has_more_after,
        Some(true),
        "an anchor in the middle of the history is not the end of the session"
    );
    assert_eq!(
        page.messages
            .iter()
            .find(|message| message.id == "m5")
            .unwrap()
            .content,
        "body 5 newest snapshot"
    );
}

#[test]
fn bounded_reads_keep_delegation_parents_outside_physical_page_cursors() {
    let db = test_db();
    let session = create_session(&db, None, None, None, None, None).unwrap();
    for n in 0..2 {
        let mut task = user_msg(&format!("task-{n}"), "parent", "2026-10-30T00:00:00Z");
        task.role = "tool".into();
        task.tool_name = Some("Task".into());
        task.tool_call_id = Some(format!("call-{n}"));
        task.tool_result = Some(json!({ "details": { "delegationId": format!("delegate-{n}") } }));
        append_message(&db, &session.id, &task, None).unwrap();
    }
    for n in 0..4 {
        append_message(
            &db,
            &session.id,
            &user_msg(&format!("m{n}"), "neighbor", "2026-10-30T00:00:01Z"),
            None,
        )
        .unwrap();
    }
    let mut child = user_msg("child", "delegate output", "2026-10-30T00:00:02Z");
    child.role = "assistant".into();
    child.parent_tool_call_id = Some("call-0".into());
    append_message(&db, &session.id, &child, None).unwrap();
    let mut list = user_msg("list", "roster", "2026-10-30T00:00:03Z");
    list.role = "tool".into();
    list.tool_name = Some("TaskList".into());
    list.tool_result =
        Some(json!({ "details": { "delegations": [{ "delegationId": "delegate-1" }] } }));
    append_message(&db, &session.id, &list, None).unwrap();
    let tail = get_session_with_options(
        &db,
        &session.id,
        SessionReadOptions {
            message_limit: Some(2),
            content_limit: Some(128),
            ..Default::default()
        },
    )
    .unwrap()
    .unwrap();
    assert_eq!(tail.message_start, Some(6));
    assert_eq!(tail.message_end, Some(8));
    assert_eq!(tail.has_more_before, Some(true));
    assert_eq!(
        tail.messages
            .iter()
            .map(|m| m.id.as_str())
            .collect::<Vec<_>>(),
        ["child", "list"]
    );
    let json = serde_json::to_value(&tail).unwrap();
    assert_eq!(
        json["messageParents"].as_array().map(|parents| parents
            .iter()
            .map(|m| m["id"].as_str().unwrap())
            .collect::<Vec<_>>()),
        Some(vec!["task-0", "task-1"])
    );
    let whole = serde_json::to_value(get_session(&db, &session.id).unwrap().unwrap()).unwrap();
    assert!(
        whole.get("messageParents").is_none(),
        "canonical reads stay unchanged"
    );
    let page = get_session_with_options(
        &db,
        &session.id,
        SessionReadOptions {
            message_limit: Some(8),
            ..Default::default()
        },
    )
    .unwrap()
    .unwrap();
    assert!(
        serde_json::to_value(page)
            .unwrap()
            .get("messageParents")
            .is_none(),
        "in-page parents are not duplicated"
    );
}

#[test]
fn nested_lineage_roundtrips_independently_of_legacy_task_parent() {
    let db = test_db();
    let session = create_session(&db, None, None, None, None, None).unwrap();
    for (id, task, nested) in [
        ("legacy", Some("task-1"), None),
        ("nested-root", None, Some("code-root")),
        ("nested-delegate", Some("task-1"), Some("code-child")),
    ] {
        let mut message = user_msg(id, "result", "2026-09-30T00:00:00Z");
        message.role = "assistant".into();
        message.parent_tool_call_id = task.map(str::to_owned);
        message.nested_parent_tool_call_id = nested.map(str::to_owned);
        append_message(&db, &session.id, &message, None).unwrap();
    }
    let detail = get_session(&db, &session.id).unwrap().unwrap();
    assert_eq!(
        detail.messages[0].parent_tool_call_id.as_deref(),
        Some("task-1")
    );
    assert_eq!(detail.messages[0].nested_parent_tool_call_id, None);
    assert_eq!(detail.messages[1].parent_tool_call_id, None);
    assert_eq!(
        detail.messages[1].nested_parent_tool_call_id.as_deref(),
        Some("code-root")
    );
    assert_eq!(
        detail.messages[2].parent_tool_call_id.as_deref(),
        Some("task-1")
    );
    assert_eq!(
        detail.messages[2].nested_parent_tool_call_id.as_deref(),
        Some("code-child")
    );
}

#[test]
fn assistant_thinking_roundtrips_as_canonical_blocks() {
    let db = test_db();
    let session = create_session(&db, None, None, None, None, None).unwrap();
    let assistant = UiMessage {
        id: "assistant-1".into(),
        role: "assistant".into(),
        content: "final answer".into(),
        command: None,
        skill_mentions: None,
        attachments: None,
        voice_origin: None,
        steering: None,
        created_at: "2025-05-01T00:00:01Z".into(),
        thinking: Some("first plan\nsecond plan".into()),
        status: Some("complete".into()),
        model_id: Some("model-1".into()),
        provider_id: Some("provider-1".into()),
        usage: Some(MessageUsage {
            input_tokens: 12,
            output_tokens: 34,
            cache_read_tokens: Some(2),
            cache_write_tokens: None,
            reasoning_tokens: Some(5),
            total_tokens: 48,
            accounting: serde_json::Map::new(),
        }),
        response_duration_ms: Some(2_000),
        response_output_tokens: Some(34),
        stop_reason: Some(json!({ "reason": "length" })),
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
    };
    append_message(&db, &session.id, &assistant, None).unwrap();

    let records = transcripts::read_transcript(db.data_dir(), &session.id).unwrap();
    assert_eq!(records.len(), 1);
    let blocks = &records[0].blocks;
    assert_eq!(
        blocks[0],
        json!({
            "type": "thinking",
            "text": "first plan\nsecond plan"
        })
    );
    assert_eq!(
        blocks[1],
        json!({
            "type": "text",
            "text": "final answer"
        })
    );

    let detail = get_session(&db, &session.id).unwrap().unwrap();
    assert_eq!(
        detail.messages[0].thinking.as_deref(),
        Some("first plan\nsecond plan")
    );
    assert_eq!(detail.messages[0].content, "final answer");
    assert_eq!(detail.messages[0].model_id.as_deref(), Some("model-1"));
    assert_eq!(
        detail.messages[0].provider_id.as_deref(),
        Some("provider-1")
    );
    let usage = detail.messages[0].usage.as_ref().expect("usage");
    assert_eq!(usage.input_tokens, 12);
    assert_eq!(usage.output_tokens, 34);
    assert_eq!(usage.cache_read_tokens, Some(2));
    assert_eq!(usage.reasoning_tokens, Some(5));
    assert_eq!(usage.total_tokens, 48);
    assert_eq!(detail.messages[0].response_duration_ms, Some(2_000));
    assert_eq!(detail.messages[0].response_output_tokens, Some(34));
    assert_eq!(
        detail.messages[0].stop_reason,
        Some(json!({ "reason": "length" }))
    );
}

#[test]
fn assistant_error_roundtrips_in_message_metadata() {
    let db = test_db();
    let session = create_session(&db, None, None, None, None, None).unwrap();
    let mut assistant = user_msg("assistant-error", "", "2025-05-01T00:00:01Z");
    assistant.role = "assistant".into();
    assistant.status = Some("error".into());
    assistant.is_error = Some(true);
    assistant.error = Some(json!({
        "code": "MODEL_NOT_CONFIGURED",
        "message": "404: model not found",
        "retriable": false
    }));

    append_message(&db, &session.id, &assistant, None).unwrap();
    let detail = get_session(&db, &session.id).unwrap().unwrap();
    let restored = &detail.messages[0];

    assert_eq!(restored.status.as_deref(), Some("error"));
    assert_eq!(restored.is_error, Some(true));
    assert_eq!(restored.error, assistant.error);
}

#[test]
fn import_and_replace_preserve_thinking() {
    let db = test_db();
    let summary = SessionSummary {
        id: "thinking-import".into(),
        title: "Thinking".into(),
        message_count: 0,
        project_path: None,
        model_id: None,
        provider_id: None,
        mode: "agent".into(),
        thinking_level: "medium".into(),
        permission_mode: "inherit".into(),
        // Ownership is derived from `task_runs`, so an import is never one.
        scheduled_run: false,
        worktree: None,
        created_at: "2025-01-01T00:00:00Z".into(),
        updated_at: "2025-01-01T00:00:00Z".into(),
    };
    let mut message = user_msg("m1", "prompt", "2025-01-01T00:00:01Z");
    message.role = "assistant".into();
    message.thinking = Some("persist me".into());
    assert!(import_session(&db, &summary, &[message.clone()]).unwrap());
    let detail = get_session(&db, &summary.id).unwrap().unwrap();
    assert_eq!(detail.summary.thinking_level, "medium");
    assert_eq!(detail.messages[0].thinking.as_deref(), Some("persist me"));

    let session = create_session(&db, None, None, None, None, None).unwrap();
    message.id = "m2".into();
    replace_messages(&db, &session.id, &[message]).unwrap();
    let detail = get_session(&db, &session.id).unwrap().unwrap();
    assert_eq!(detail.messages[0].thinking.as_deref(), Some("persist me"));
}

#[test]
fn transcript_survives_reopen_from_file() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("pi.sqlite");
    let db = Database::open(&path).unwrap();
    let session = create_session(&db, None, None, None, None, None).unwrap();
    append_message(
        &db,
        &session.id,
        &user_msg("m1", "durable", "2025-05-01T00:00:00Z"),
        None,
    )
    .unwrap();
    let transcript = transcripts::transcript_path(db.data_dir(), &session.id).unwrap();
    assert!(transcript.exists());

    drop(db);
    let db = Database::open(&path).unwrap();
    let detail = get_session(&db, &session.id).unwrap().unwrap();
    assert_eq!(detail.messages.len(), 1);
    assert_eq!(detail.messages[0].content, "durable");
}

#[test]
fn replace_messages_resets_stream() {
    let db = test_db();
    let session = create_session(&db, None, None, None, None, None).unwrap();
    append_message(
        &db,
        &session.id,
        &user_msg("a", "one", "2025-05-01T00:00:00Z"),
        None,
    )
    .unwrap();
    append_message(
        &db,
        &session.id,
        &user_msg("b", "two", "2025-05-01T00:00:01Z"),
        None,
    )
    .unwrap();
    replace_messages(
        &db,
        &session.id,
        &[user_msg("c", "compacted", "2025-05-01T00:00:02Z")],
    )
    .unwrap();
    let detail = get_session(&db, &session.id).unwrap().unwrap();
    assert_eq!(detail.messages.len(), 1);
    assert_eq!(detail.messages[0].content, "compacted");
    // Appending after replace continues from the new stream head.
    append_message(
        &db,
        &session.id,
        &user_msg("d", "next", "2025-05-01T00:00:03Z"),
        None,
    )
    .unwrap();
    let detail = get_session(&db, &session.id).unwrap().unwrap();
    assert_eq!(detail.messages.len(), 2);
    assert_eq!(detail.messages[1].content, "next");
}

#[test]
fn final_row_supersedes_checkpoint_and_late_checkpoint_cannot_resurrect_it() {
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
    assert!(!transcripts::inflight_path(db.data_dir(), &session.id)
        .unwrap()
        .exists());

    // A checkpoint call that was already in flight when the final row landed.
    assert!(!save_inflight_message(
        &db,
        &session.id,
        Some(&turn),
        &streaming_assistant("a1", "partial")
    )
    .unwrap());
    assert!(!transcripts::inflight_path(db.data_dir(), &session.id)
        .unwrap()
        .exists());
    assert!(recover_inflight_message(&db, &session.id, true)
        .unwrap()
        .is_none());

    let messages = get_session(&db, &session.id).unwrap().unwrap().messages;
    assert_eq!(messages.len(), 1);
    assert_eq!(messages[0].content, "partial and complete");
    assert_eq!(messages[0].status.as_deref(), Some("complete"));
}

#[test]
fn checkpoint_for_a_newer_fragment_survives_an_older_final_row() {
    let db = test_db();
    let session = create_session(&db, None, None, None, None, None).unwrap();
    let turn = begin_turn(&db, &session.id, None, None).unwrap();
    assert!(save_inflight_message(
        &db,
        &session.id,
        Some(&turn),
        &streaming_assistant("a2", "second")
    )
    .unwrap());

    let mut earlier = streaming_assistant("a1", "first");
    earlier.status = Some("complete".into());
    append_message(&db, &session.id, &earlier, Some(&turn)).unwrap();
    assert!(transcripts::inflight_path(db.data_dir(), &session.id)
        .unwrap()
        .exists());
}

#[test]
fn user_stop_keeps_the_checkpoint_until_the_final_row_lands() {
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

    let ended = end_turn_settling(
        &db,
        &turn,
        "aborted",
        Some("TURN_ABORTED"),
        None,
        false,
        false,
    )
    .unwrap();
    assert!(ended.updated);
    assert!(ended.recovered.is_none());
    assert!(transcripts::inflight_path(db.data_dir(), &session.id)
        .unwrap()
        .exists());

    let mut final_row = streaming_assistant("a1", "partial");
    final_row.status = Some("aborted".into());
    append_message(&db, &session.id, &final_row, Some(&turn)).unwrap();
    assert!(!transcripts::inflight_path(db.data_dir(), &session.id)
        .unwrap()
        .exists());
    assert_eq!(
        get_session(&db, &session.id)
            .unwrap()
            .unwrap()
            .messages
            .len(),
        1
    );
}
