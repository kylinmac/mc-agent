use super::*;

#[test]
fn replay_after_a_failed_index_insert_updates_transcript_without_duplicate_or_reordering() {
    let db = test_db();
    let session = create_session(&db, None, None, None, None, None).unwrap();
    let turn_id = begin_turn(&db, &session.id, None, None).unwrap();
    let before = user_msg("before", "before", "2026-07-28T00:00:00Z");
    let replay = user_msg("replay", "latest replay snapshot", "2026-07-28T00:00:01Z");
    let old_replay = user_msg("replay", "old failed snapshot", "2026-07-28T00:00:01Z");
    let after = user_msg("after", "after", "2026-07-28T00:00:02Z");
    append_message(&db, &session.id, &before, Some(&turn_id)).unwrap();

    // Older hosts wrote the transcript line before the index transaction;
    // repeated retries could leave multiple stale copies while the index stayed absent.
    let (record, _) = ui_to_record(&old_replay);
    let created_at = session_created_at(&db, &session.id).unwrap();
    transcripts::append_message(db.data_dir(), &session.id, &created_at, &record).unwrap();
    transcripts::append_message(db.data_dir(), &session.id, &created_at, &record).unwrap();
    append_message(&db, &session.id, &after, Some(&turn_id)).unwrap();

    append_message(&db, &session.id, &replay, Some("missing-turn"))
        .expect("replaying an old outbox entry must reconcile the existing transcript line");

    let indexed: Vec<(String, i64, Option<String>)> = db
        .conn()
        .prepare("SELECT id, seq, turn_id FROM messages WHERE session_id = ?1 ORDER BY seq")
        .unwrap()
        .query_map(params![session.id], |row| {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?))
        })
        .unwrap()
        .collect::<rusqlite::Result<_>>()
        .unwrap();
    assert_eq!(
        indexed,
        vec![
            (before.id.clone(), 0, Some(turn_id.clone())),
            (replay.id.clone(), 1, None),
            (after.id.clone(), 2, Some(turn_id.clone())),
        ]
    );
    let last_seq: i64 = db
        .conn()
        .query_row(
            "SELECT last_seq FROM sessions WHERE id = ?1",
            params![session.id],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(last_seq, 3);

    let transcript = transcripts::read_transcript(db.data_dir(), &session.id).unwrap();
    assert_eq!(
        transcript
            .iter()
            .filter(|record| record.id == replay.id)
            .count(),
        2,
        "replay updates existing lines but does not append another copy"
    );
    let restored = get_session(&db, &session.id).unwrap().unwrap();
    assert_eq!(
        restored
            .messages
            .iter()
            .map(|message| message.id.as_str())
            .collect::<Vec<_>>(),
        vec![before.id.as_str(), replay.id.as_str(), after.id.as_str()]
    );
    assert_eq!(restored.messages[1].content, replay.content);
    assert_eq!(
        search_messages(&db, &replay.content, 10)
            .unwrap()
            .iter()
            .map(|hit| hit.message_id.as_str())
            .collect::<Vec<_>>(),
        vec![replay.id.as_str()]
    );

    let next = user_msg("next", "after repair", "2026-07-28T00:00:03Z");
    append_message(&db, &session.id, &next, Some(&turn_id)).unwrap();
    let next_seq: i64 = db
        .conn()
        .query_row(
            "SELECT seq FROM messages WHERE session_id = ?1 AND id = ?2",
            params![session.id, next.id],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(next_seq, 3);
}

#[test]
fn assistant_hosted_search_roundtrips_as_canonical_blocks() {
    let db = test_db();
    let session = create_session(&db, None, None, None, None, None).unwrap();
    let assistant = UiMessage {
        id: "assistant-search-1".into(),
        role: "assistant".into(),
        content: "answer with sources".into(),
        command: None,
        skill_mentions: None,
        attachments: None,
        voice_origin: None,
        steering: None,
        created_at: "2025-05-01T00:00:01Z".into(),
        thinking: None,
        status: Some("complete".into()),
        model_id: Some("model-1".into()),
        provider_id: Some("provider-1".into()),
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
        model_system: None,
        hosted_search: Some(json!({
            "status": "completed",
            "rounds": [
                {
                    "id": "srvtoolu_01",
                    "status": "completed",
                    "query": "pi-desktop release notes",
                    "sources": [
                        { "url": "https://example.com/a", "title": "A" }
                    ]
                }
            ],
            "replay": [
                {
                    "type": "hostedSearch",
                    "phase": "server_tool_use",
                    "blockId": "srvtoolu_01",
                    "name": "web_search",
                    "input": { "query": "pi-desktop release notes" }
                }
            ]
        })),
        session_message: None,
    };
    append_message(&db, &session.id, &assistant, None).unwrap();

    let records = transcripts::read_transcript(db.data_dir(), &session.id).unwrap();
    assert_eq!(records.len(), 1);
    let blocks = &records[0].blocks;
    assert_eq!(
        blocks[0],
        json!({
            "type": "hostedSearch",
            "status": "completed",
            "rounds": [
                {
                    "id": "srvtoolu_01",
                    "status": "completed",
                    "query": "pi-desktop release notes",
                    "sources": [
                        { "url": "https://example.com/a", "title": "A" }
                    ]
                }
            ],
            "replay": [
                {
                    "type": "hostedSearch",
                    "phase": "server_tool_use",
                    "blockId": "srvtoolu_01",
                    "name": "web_search",
                    "input": { "query": "pi-desktop release notes" }
                }
            ]
        })
    );

    let detail = get_session(&db, &session.id).unwrap().unwrap();
    assert_eq!(
        detail.messages[0].hosted_search,
        Some(json!({
            "status": "completed",
            "rounds": [
                {
                    "id": "srvtoolu_01",
                    "status": "completed",
                    "query": "pi-desktop release notes",
                    "sources": [
                        { "url": "https://example.com/a", "title": "A" }
                    ]
                }
            ],
            "replay": [
                {
                    "type": "hostedSearch",
                    "phase": "server_tool_use",
                    "blockId": "srvtoolu_01",
                    "name": "web_search",
                    "input": { "query": "pi-desktop release notes" }
                }
            ]
        }))
    );
    // The additive block must not disturb text reconstruction.
    assert_eq!(detail.messages[0].content, "answer with sources");
}

#[test]
fn search_finds_cjk_and_short_queries() {
    let db = test_db();
    let session = create_session(&db, Some("重构".into()), None, None, None, None).unwrap();
    append_message(
        &db,
        &session.id,
        &user_msg("m1", "帮我重构数据库结构", "2025-05-01T00:00:00Z"),
        None,
    )
    .unwrap();
    let hits = search_messages(&db, "数据库", 10).unwrap();
    assert_eq!(hits.len(), 1);
    assert_eq!(hits[0].session_id, session.id);
    // 2-char query falls back to LIKE.
    let hits = search_messages(&db, "重构", 10).unwrap();
    assert_eq!(hits.len(), 1);
    // Deleting the session clears the index (cascade + FTS trigger).
    delete_session(&db, &session.id).unwrap();
    assert!(search_messages(&db, "数据库", 10).unwrap().is_empty());
}

/// The search snippets must show the window around the match. FTS5's
/// `snippet()` reads the phrase list of the MATCH that positioned its
/// cursor, so a reformulation that reaches a document by rowid alone
/// silently degrades to the head of the document — which still looks like a
/// plausible preview. This pins the observable property.
#[test]
fn search_snippets_center_on_the_match_not_the_document_head() {
    let db = test_db();
    let session = create_session(&db, None, None, None, None, None).unwrap();
    let filler = "lorem ipsum dolor sit amet ".repeat(60);
    append_message(
        &db,
        &session.id,
        &user_msg(
            "m1",
            &format!("{filler}needle-window-tail"),
            "2025-05-01T00:00:00Z",
        ),
        None,
    )
    .unwrap();
    let hits = search_messages(&db, "needle-window-tail", 10).unwrap();
    assert_eq!(hits.len(), 1);
    assert!(
        hits[0].snippet.contains("needle-window-tail"),
        "snippet is not the window around the match: {:?}",
        hits[0].snippet
    );
    assert!(
        hits[0].snippet.len() < filler.len(),
        "snippet returned the whole body: {} bytes",
        hits[0].snippet.len()
    );
}

/// The ordering indexes are a plan change and must not be a result change.
/// Both branches of `search_messages` are compared with the indexes present
/// and dropped, on the same rows.
#[test]
fn search_results_do_not_depend_on_the_ordering_indexes() {
    let db = test_db();
    let session = create_session(&db, None, None, None, None, None).unwrap();
    for index in 0..40 {
        append_message(
            &db,
            &session.id,
            &user_msg(
                &format!("m{index:02}"),
                &format!("needle body {index}"),
                &format!("2025-05-01T00:00:{index:02}Z"),
            ),
            None,
        )
        .unwrap();
    }
    let project = |hits: Vec<SearchHit>| {
        hits.into_iter()
            .map(|hit| (hit.message_id, hit.snippet))
            .collect::<Vec<_>>()
    };
    let indexed_fts = project(search_messages(&db, "needle body", 10).unwrap());
    let indexed_like = project(search_messages(&db, "ne", 10).unwrap());
    assert_eq!(indexed_fts.len(), 10);
    assert_eq!(indexed_like.len(), 10);
    // Newest first: the query must rank by created_at, not by row order.
    assert_eq!(indexed_fts[0].0, "m39");

    db.conn()
        .execute_batch(
            "DROP INDEX idx_messages_created;
             DROP INDEX idx_messages_session_created;",
        )
        .unwrap();
    assert_eq!(
        project(search_messages(&db, "needle body", 10).unwrap()),
        indexed_fts
    );
    assert_eq!(
        project(search_messages(&db, "ne", 10).unwrap()),
        indexed_like
    );
}

/// `boot_maintenance` adds the ordering indexes to an existing database
/// without a schema-version bump, the same way it has always added
/// `idx_turns_ended_at`.
#[test]
fn opening_a_database_creates_the_message_ordering_indexes() {
    let db = test_db();
    for name in ["idx_messages_created", "idx_messages_session_created"] {
        let present: i64 = db
            .conn()
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type = 'index' AND name = ?1",
                params![name],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(present, 1, "{name} was not created");
    }
}

/// Randomized differential check of the one fact this change caches. A
/// session is driven through provisional appends, settled snapshots, retried
/// duplicates of the same id and checkpoint recovery, and after every step the
/// index's `streaming` bit and the guard's answer have to agree with the
/// transcript itself.
#[test]
fn the_streaming_bit_matches_the_transcript_under_random_appends() {
    let db = test_db();
    let session = create_session(&db, None, None, None, None, None).unwrap();
    let mut seed = 0x2545_F491_4F6C_DD1Du64;
    let mut next = move || {
        seed ^= seed << 13;
        seed ^= seed >> 7;
        seed ^= seed << 17;
        seed
    };
    for step in 0..80 {
        let id = format!("m{}", next() % 6);
        let mut message = user_msg(&id, &format!("body {step}"), "2025-05-01T00:00:00Z");
        message.role = if next() % 4 == 0 {
            "user".into()
        } else {
            "assistant".into()
        };
        if message.role == "assistant" {
            message.status = Some(
                if next() % 2 == 0 {
                    "streaming"
                } else {
                    "complete"
                }
                .into(),
            );
        }
        let appended = append_message(&db, &session.id, &message, None);
        assert!(
            !format!("{appended:?}").contains("missing from its transcript"),
            "step {step}: the settled row could not reach the transcript: {appended:?}"
        );
        if next() % 3 == 0 {
            let _ = save_inflight_message(&db, &session.id, None, &message);
        }
        if next() % 7 == 0 {
            let _ = recover_inflight_message(&db, &session.id, next() % 2 == 0);
        }
        let records =
            dedupe_records(transcripts::read_transcript(db.data_dir(), &session.id).unwrap());
        for record in &records {
            assert_eq!(
                streaming_flag(&db, &record.id),
                Some(i64::from(record_is_streaming(record))),
                "step {step}: the index disagrees with the transcript for {}",
                record.id
            );
            assert_eq!(
                streaming_assistant_indexed(&db, &session.id, &record.id).unwrap(),
                record_is_streaming(record),
                "step {step}: the guard disagrees with the transcript for {}",
                record.id
            );
        }
    }
}

/// The guard reads the index, not the transcript: a live streaming row keeps
/// its checkpoint even when the transcript file is gone.
#[test]
fn the_streaming_guard_answers_from_the_index_not_from_the_transcript() {
    let db = test_db();
    let session = create_session(&db, None, None, None, None, None).unwrap();
    append_message(
        &db,
        &session.id,
        &streaming_assistant("a1", "partial"),
        None,
    )
    .unwrap();
    let transcript = transcripts::transcript_path(db.data_dir(), &session.id).unwrap();
    assert!(transcript.exists());
    std::fs::remove_file(&transcript).unwrap();

    assert!(save_inflight_message(
        &db,
        &session.id,
        None,
        &streaming_assistant("a1", "partial")
    )
    .unwrap());
    assert!(transcripts::inflight_path(db.data_dir(), &session.id)
        .unwrap()
        .exists());
}

/// The mirror image: a row the index cannot answer for is resolved from the
/// transcript, which is what makes an unrebuilt database behave exactly as it
/// did before the cache existed. Clearing the column *and* deleting the file
/// makes the two sources disagree, so the answer says which one was read.
#[test]
fn a_message_written_before_the_streaming_column_answers_from_the_transcript() {
    let db = test_db();
    let session = create_session(&db, None, None, None, None, None).unwrap();
    append_message(
        &db,
        &session.id,
        &streaming_assistant("a1", "partial"),
        None,
    )
    .unwrap();
    db.conn()
        .execute("UPDATE messages SET streaming = NULL WHERE id = 'a1'", [])
        .unwrap();

    // The transcript has the streaming row, and the fallback finds it.
    assert!(save_inflight_message(
        &db,
        &session.id,
        None,
        &streaming_assistant("a1", "partial")
    )
    .unwrap());

    // Now only the column could answer "streaming"; the file cannot. The
    // checkpoint is dropped, so the file is the source that answered.
    let transcript = transcripts::transcript_path(db.data_dir(), &session.id).unwrap();
    std::fs::remove_file(&transcript).unwrap();
    assert!(!save_inflight_message(
        &db,
        &session.id,
        None,
        &streaming_assistant("a1", "partial")
    )
    .unwrap());
    assert!(!transcripts::inflight_path(db.data_dir(), &session.id)
        .unwrap()
        .exists());
}

/// The column is a cache of the transcript's last copy, so landing a terminal
/// snapshot has to re-stamp it. A stale row would keep answering "still
/// streaming", refuse the terminal row and lose the reply.
#[test]
fn the_streaming_column_tracks_the_last_copy_of_a_message() {
    let db = test_db();
    let session = create_session(&db, None, None, None, None, None).unwrap();
    let settled = |id: &str, text: &str| {
        let mut message = streaming_assistant(id, text);
        message.status = Some("complete".into());
        message
    };

    append_message(
        &db,
        &session.id,
        &streaming_assistant("a1", "partial"),
        None,
    )
    .unwrap();
    assert_eq!(streaming_flag(&db, "a1"), Some(1));
    append_message(
        &db,
        &session.id,
        &settled("a1", "partial and complete"),
        None,
    )
    .unwrap();
    assert_eq!(streaming_flag(&db, "a1"), Some(0));
    append_message(&db, &session.id, &streaming_assistant("a2", "second"), None).unwrap();
    assert_eq!(streaming_flag(&db, "a2"), Some(1));

    // Every row agrees with the transcript's own last copy of its id.
    let records = dedupe_records(transcripts::read_transcript(db.data_dir(), &session.id).unwrap());
    assert_eq!(records.len(), 2);
    for record in records {
        assert_eq!(
            streaming_flag(&db, &record.id),
            Some(i64::from(record_is_streaming(&record))),
            "the index disagrees with the transcript for {}",
            record.id
        );
    }
}

/// The column arrives through boot maintenance, not a versioned migration: no
/// row is rewritten and no backup is taken, so a database that predates it
/// keeps working and simply answers from the transcript until its rows are
/// rewritten by an append.
#[test]
fn opening_a_database_adds_the_streaming_column() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("pi.sqlite");
    let db = Database::open(&path).unwrap();
    let session = create_session(&db, None, None, None, None, None).unwrap();
    append_message(
        &db,
        &session.id,
        &streaming_assistant("a1", "partial"),
        None,
    )
    .unwrap();
    assert!(messages_have_streaming_column(&db));
    db.conn()
        .execute_batch("ALTER TABLE messages DROP COLUMN streaming")
        .unwrap();
    drop(db);

    let db = Database::open(&path).unwrap();
    assert!(messages_have_streaming_column(&db));
    assert_eq!(streaming_flag(&db, "a1"), None);
    assert!(save_inflight_message(
        &db,
        &session.id,
        None,
        &streaming_assistant("a1", "partial")
    )
    .unwrap());
}

#[test]
fn empty_streaming_message_is_not_checkpointed() {
    let db = test_db();
    let session = create_session(&db, None, None, None, None, None).unwrap();
    let mut empty = streaming_assistant("a1", "   ");
    empty.thinking = None;
    assert!(!save_inflight_message(&db, &session.id, None, &empty).unwrap());
    assert!(!transcripts::inflight_path(db.data_dir(), &session.id)
        .unwrap()
        .exists());
    assert!(save_inflight_message(
        &db,
        &session.id,
        None,
        &user_msg("u1", "x", "2025-05-01T00:00:00Z")
    )
    .is_err());
}

#[test]
fn completed_turn_end_keeps_an_unindexed_checkpoint() {
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

    let ended = end_turn_settling(&db, &turn, "completed", None, None, false, false).unwrap();
    assert!(ended.updated);
    assert!(ended.recovered.is_none());
    assert!(
        transcripts::inflight_path(db.data_dir(), &session.id)
            .unwrap()
            .exists(),
        "outbox may still be draining; do not drop the only copy (D327)"
    );
    assert!(get_session(&db, &session.id)
        .unwrap()
        .unwrap()
        .messages
        .is_empty());

    assert!(
        recover_inflight_messages(&db, false).unwrap().is_empty(),
        "boot leaves a completed leftover for the outbox"
    );
    assert!(transcripts::inflight_path(db.data_dir(), &session.id)
        .unwrap()
        .exists());

    let recovered = recover_inflight_messages(&db, true).unwrap();
    assert_eq!(recovered.len(), 1);
    assert_eq!(recovered[0].1.content, "partial");
    assert_eq!(recovered[0].1.status.as_deref(), Some("complete"));
    let messages = get_session(&db, &session.id).unwrap().unwrap().messages;
    assert_eq!(messages.len(), 1);
    assert_eq!(messages[0].id, "a1");
    assert_eq!(messages[0].status.as_deref(), Some("complete"));
}
