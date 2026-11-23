use super::*;

#[test]
fn compaction_survives_restart_and_late_truncation_but_not_early_truncation() {
    let db = test_db();
    let session = create_session(&db, None, None, None, None, None).unwrap();
    let messages = [
        user_msg("u1", "old", "2026-07-28T00:00:00Z"),
        user_msg("u2", "recent", "2026-07-28T00:00:01Z"),
        user_msg("u3", "after", "2026-07-28T00:00:02Z"),
    ];
    for message in &messages {
        append_message(&db, &session.id, message, None).unwrap();
    }
    append_compaction(&db, &session.id, &checkpoint("u2", "u2")).unwrap();

    let restored = get_session(&db, &session.id).unwrap().unwrap();
    assert_eq!(restored.messages.len(), 3);
    assert_eq!(
        restored.compaction.as_ref().unwrap().through_message_id,
        "u2"
    );

    replace_messages(&db, &session.id, &messages[..2]).unwrap();
    assert!(get_session(&db, &session.id)
        .unwrap()
        .unwrap()
        .compaction
        .is_some());

    replace_messages(&db, &session.id, &messages[..1]).unwrap();
    assert!(get_session(&db, &session.id)
        .unwrap()
        .unwrap()
        .compaction
        .is_none());
}

#[test]
fn the_whole_checkpoint_chain_survives_restart_and_partial_truncation() {
    let db = test_db();
    let session = create_session(&db, None, None, None, None, None).unwrap();
    let messages = [
        user_msg("u1", "old", "2026-07-28T00:00:00Z"),
        user_msg("u2", "recent", "2026-07-28T00:00:01Z"),
        user_msg("u3", "after", "2026-07-28T00:00:02Z"),
    ];
    for message in &messages {
        append_message(&db, &session.id, message, None).unwrap();
    }
    append_compaction(&db, &session.id, &checkpoint("u1", "u1")).unwrap();
    append_compaction(&db, &session.id, &checkpoint("u2", "u3")).unwrap();

    let restored = get_session(&db, &session.id).unwrap().unwrap();
    assert_eq!(restored.compactions.len(), 2);
    // `compaction` stays the newest one: it is what the runtime reinstalls.
    assert_eq!(
        restored.compaction.as_ref().unwrap().id,
        restored.compactions[1].id
    );

    // Truncating past the second anchor invalidates that record alone.
    replace_messages(&db, &session.id, &messages[..2]).unwrap();
    let after = get_session(&db, &session.id).unwrap().unwrap();
    assert_eq!(
        after
            .compactions
            .iter()
            .map(|record| record.through_message_id.as_str())
            .collect::<Vec<_>>(),
        vec!["u1"]
    );
}

#[test]
fn bounded_session_reads_page_history_and_cap_display_content() {
    let db = test_db();
    let session = create_session(&db, None, None, None, None, None).unwrap();
    append_message(
        &db,
        &session.id,
        &user_msg("m1", "old", "2025-05-01T00:00:00Z"),
        None,
    )
    .unwrap();
    append_message(
        &db,
        &session.id,
        &user_msg("m2", &"x".repeat(80_000), "2025-05-01T00:00:01Z"),
        None,
    )
    .unwrap();

    let page = get_session_with_options(
        &db,
        &session.id,
        SessionReadOptions {
            message_around: None,
            message_before: None,
            message_limit: Some(1),
            content_limit: Some(128),
        },
    )
    .unwrap()
    .unwrap();
    assert_eq!(page.message_start, Some(1));
    assert_eq!(page.has_more_before, Some(true));
    assert_eq!(page.messages.len(), 1);
    assert!(page.messages[0].content.len() < 256);
    assert!(page.messages[0].content.contains("truncated for display"));

    let full = get_session(&db, &session.id).unwrap().unwrap();
    assert_eq!(full.messages[1].content.len(), 80_000);
}
