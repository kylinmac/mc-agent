use super::*;

#[test]
fn restore_orphaned_session_remaps_ids_owned_by_another_session() {
    let db = test_db();
    let first = create_session(&db, None, None, None, None, None).unwrap();
    let second = create_session(&db, None, None, None, None, None).unwrap();
    let colliding = user_msg("call_421522", "orphan", "2026-09-16T15:42:41Z");
    append_message(&db, &first.id, &colliding, None).unwrap();
    let (record, _) = ui_to_record(&colliding);
    transcripts::append_message(db.data_dir(), &second.id, &second.created_at, &record).unwrap();
    db.conn()
        .execute("DELETE FROM sessions WHERE id = ?1", params![second.id])
        .unwrap();
    assert!(restore_orphaned_session(&db, &second.id).unwrap());
    let restored = get_session(&db, &second.id).unwrap().unwrap();
    assert_eq!(restored.messages.len(), 1);
    assert_eq!(
        restored.messages[0].id,
        format!("{}:call_421522", second.id)
    );
    assert_eq!(
        get_session(&db, &first.id).unwrap().unwrap().messages[0].id,
        "call_421522"
    );
}

#[test]
fn recover_orphaned_sessions_restores_transcript_files_without_rows() {
    let db = test_db();
    let session = create_session(&db, None, None, None, None, None).unwrap();
    append_message(
        &db,
        &session.id,
        &user_msg("u1", "keep", "2025-05-01T00:00:00Z"),
        None,
    )
    .unwrap();
    db.conn()
        .execute("DELETE FROM sessions WHERE id = ?1", params![session.id])
        .unwrap();
    assert_eq!(recover_orphaned_sessions(&db).unwrap(), 1);
    assert!(get_session(&db, &session.id).unwrap().is_some());
    assert_eq!(recover_orphaned_sessions(&db).unwrap(), 0);
}

/// A device that lost a settled row's bytes leaves the index claiming the
/// reply is finished while the transcript still ends on the provisional row.
/// The checkpoint is then the durable copy, so recovery has to promote it —
/// and re-stamp the index — instead of dropping it as a settled duplicate.
#[test]
fn a_settled_index_row_over_a_provisional_transcript_row_still_recovers() {
    let db = test_db();
    let session = create_session(&db, None, None, None, None, None).unwrap();
    append_message(
        &db,
        &session.id,
        &streaming_assistant("a1", "partial"),
        None,
    )
    .unwrap();
    assert!(save_inflight_message(
        &db,
        &session.id,
        None,
        &streaming_assistant("a1", "partial reply")
    )
    .unwrap());
    // The crash window: the index was re-stamped, the row's bytes never were.
    db.conn()
        .execute("UPDATE messages SET streaming = 0 WHERE id = 'a1'", [])
        .unwrap();

    let recovered = recover_inflight_messages(&db, false).unwrap();
    assert_eq!(recovered.len(), 1, "the reply was dropped as a duplicate");
    assert_eq!(recovered[0].1.content, "partial reply");
    assert_eq!(streaming_flag(&db, "a1"), Some(0));
    let records = dedupe_records(transcripts::read_transcript(db.data_dir(), &session.id).unwrap());
    assert_eq!(records.len(), 1);
    assert_eq!(
        record_index_text(&records[0]).as_deref(),
        Some("partial reply")
    );
}

/// The mirror window: the transcript lost the provisional row while the index
/// kept it. The checkpoint is again the only copy, and the promotion has to
/// append the row back instead of failing because the file does not have it.
#[test]
fn a_reply_whose_transcript_row_was_lost_is_appended_back_on_recovery() {
    let db = test_db();
    let session = create_session(&db, None, None, None, None, None).unwrap();
    append_message(
        &db,
        &session.id,
        &streaming_assistant("a1", "partial"),
        None,
    )
    .unwrap();
    assert!(save_inflight_message(
        &db,
        &session.id,
        None,
        &streaming_assistant("a1", "partial reply")
    )
    .unwrap());
    // The transcript lost the row's bytes; only the index still has it.
    let transcript = transcripts::transcript_path(db.data_dir(), &session.id).unwrap();
    std::fs::write(&transcript, "").unwrap();

    let recovered = recover_inflight_messages(&db, false).unwrap();
    assert_eq!(recovered.len(), 1);
    assert_eq!(streaming_flag(&db, "a1"), Some(0));
    let records = dedupe_records(transcripts::read_transcript(db.data_dir(), &session.id).unwrap());
    assert_eq!(records.len(), 1, "the promoted row never reached the file");
    assert_eq!(
        record_index_text(&records[0]).as_deref(),
        Some("partial reply")
    );
}

#[test]
fn inflight_checkpoint_is_promoted_as_aborted_after_reopen() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("pi.sqlite");
    let db = Database::open(&path).unwrap();
    let session = create_session(&db, None, None, None, None, None).unwrap();
    let turn = begin_turn(&db, &session.id, None, None).unwrap();
    append_message(
        &db,
        &session.id,
        &user_msg("u1", "hello", "2025-05-01T00:00:00Z"),
        Some(&turn),
    )
    .unwrap();

    // Two checkpoints of the same reply: the file is replaced, not appended.
    assert!(save_inflight_message(
        &db,
        &session.id,
        Some(&turn),
        &streaming_assistant("a1", "par")
    )
    .unwrap());
    assert!(save_inflight_message(
        &db,
        &session.id,
        Some(&turn),
        &streaming_assistant("a1", "partial")
    )
    .unwrap());
    assert!(transcripts::inflight_path(db.data_dir(), &session.id)
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
    drop(db);

    // A new process: the boot sweep aborts the turn, then the checkpoint
    // becomes the aborted tail of the transcript.
    let db = Database::open(&path).unwrap();
    let recovered = recover_inflight_messages(&db, false).unwrap();
    assert_eq!(recovered.len(), 1);
    assert_eq!(recovered[0].0, session.id);
    assert_eq!(recovered[0].1.content, "partial");
    assert_eq!(recovered[0].1.status.as_deref(), Some("aborted"));
    assert!(!transcripts::inflight_path(db.data_dir(), &session.id)
        .unwrap()
        .exists());

    let messages = get_session(&db, &session.id).unwrap().unwrap().messages;
    assert_eq!(messages.len(), 2);
    assert_eq!(messages[1].id, "a1");
    assert_eq!(messages[1].thinking.as_deref(), Some("still thinking"));
    assert_eq!(messages[1].status.as_deref(), Some("aborted"));
    let owning: Option<String> = db
        .conn()
        .query_row("SELECT turn_id FROM messages WHERE id = 'a1'", [], |r| {
            r.get(0)
        })
        .unwrap();
    assert_eq!(owning.as_deref(), Some(turn.as_str()));
    // Running it again finds nothing to do.
    assert!(recover_inflight_messages(&db, false).unwrap().is_empty());
}

#[test]
fn sidecar_loss_recovers_the_checkpoint_at_turn_end() {
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
        true,
    )
    .unwrap();
    assert!(ended.updated);
    let recovered = ended.recovered.expect("checkpoint promoted");
    assert_eq!(recovered.id, "a1");
    assert_eq!(recovered.status.as_deref(), Some("aborted"));
    assert!(!transcripts::inflight_path(db.data_dir(), &session.id)
        .unwrap()
        .exists());
    let messages = get_session(&db, &session.id).unwrap().unwrap().messages;
    assert_eq!(messages.len(), 1);
    assert_eq!(messages[0].content, "partial");

    // The final row for the same id, should it still arrive, is a no-op.
    let mut late = streaming_assistant("a1", "partial");
    late.status = Some("aborted".into());
    append_message(&db, &session.id, &late, Some(&turn)).unwrap();
    assert_eq!(
        get_session(&db, &session.id)
            .unwrap()
            .unwrap()
            .messages
            .len(),
        1
    );
}
