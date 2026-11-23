use super::*;

#[test]
fn revision_roundtrip_restores_compaction_chain() {
    let mut db = test_db();
    let session = create_session(&db, None, None, None, None, None).unwrap();
    let messages = [
        user_msg("u1", "original", "2026-07-28T00:00:00Z"),
        user_msg("u2", "recent", "2026-07-28T00:00:01Z"),
        user_msg("u3", "after", "2026-07-28T00:00:02Z"),
    ];
    replace_messages(&db, &session.id, &messages).unwrap();
    let first = checkpoint("u1", "u1");
    let last = checkpoint("u2", "u3");
    append_compaction(&db, &session.id, &first).unwrap();
    append_compaction(&db, &session.id, &last).unwrap();
    save_message_revision(&db, &session.id, "u1", &messages, true).unwrap();
    let alternative = [user_msg("u-other", "alternative", "2026-07-28T00:00:04Z")];
    save_message_revision(&db, &session.id, "u1", &alternative, false).unwrap();

    for _ in 0..2 {
        activate_message_revision(&db, &session.id, "u1", 2, &[]).unwrap();
        assert!(get_session(&db, &session.id)
            .unwrap()
            .unwrap()
            .compactions
            .is_empty());
        let path = db.data_dir().join("test.sqlite");
        drop(db);
        db = Database::open(&path).unwrap();
        activate_message_revision(&db, &session.id, "u1", 1, &[]).unwrap();
        let restored = get_session(&db, &session.id).unwrap().unwrap();
        assert_eq!(restored.messages.len(), messages.len());
        assert_eq!(restored.compactions.len(), 2);
        assert_eq!(
            serde_json::to_value(&restored.compactions).unwrap(),
            json!([first, last])
        );
        assert_eq!(restored.compaction.unwrap().id, last.id);
    }
}

#[test]
fn revision_compactions_are_branch_local_even_with_identical_message_ids() {
    let db = test_db();
    let session = create_session(&db, None, None, None, None, None).unwrap();
    let messages = [user_msg("u1", "shared anchor", "2026-07-28T00:00:00Z")];
    replace_messages(&db, &session.id, &messages).unwrap();
    save_message_revision(&db, &session.id, "u1", &messages, false).unwrap();
    let first = checkpoint("u1", "u1");
    append_compaction(&db, &session.id, &first).unwrap();
    save_message_revision(&db, &session.id, "u1", &messages, true).unwrap();

    activate_message_revision(&db, &session.id, "u1", 1, &[]).unwrap();
    assert!(get_session(&db, &session.id)
        .unwrap()
        .unwrap()
        .compactions
        .is_empty());
    let second = checkpoint("u1", "u1");
    append_compaction(&db, &session.id, &second).unwrap();
    for (revision, expected) in [(2, &first), (1, &second)] {
        activate_message_revision(&db, &session.id, "u1", revision, &[]).unwrap();
        let restored = get_session(&db, &session.id).unwrap().unwrap();
        assert_eq!(restored.compactions.len(), 1);
        assert_eq!(restored.compaction.unwrap().id, expected.id);
    }
}

#[test]
fn revision_restores_checkpoint_with_an_anchor_in_the_unchanged_prefix() {
    let db = test_db();
    let session = create_session(&db, None, None, None, None, None).unwrap();
    let messages = [
        user_msg("prefix", "prefix", "2026-07-28T00:00:00Z"),
        user_msg("u1", "branch", "2026-07-28T00:00:01Z"),
    ];
    replace_messages(&db, &session.id, &messages).unwrap();
    let compacted = checkpoint("prefix", "u1");
    append_compaction(&db, &session.id, &compacted).unwrap();
    save_message_revision(&db, &session.id, "u1", &messages[1..], true).unwrap();
    let other = [user_msg("u2", "alternative", "2026-07-28T00:00:02Z")];
    save_message_revision(&db, &session.id, "u1", &other, false).unwrap();
    activate_message_revision(&db, &session.id, "u1", 2, &messages[..1]).unwrap();
    assert!(get_session(&db, &session.id)
        .unwrap()
        .unwrap()
        .compactions
        .is_empty());
    activate_message_revision(&db, &session.id, "u1", 1, &messages[..1]).unwrap();
    assert_eq!(
        get_session(&db, &session.id)
            .unwrap()
            .unwrap()
            .compaction
            .unwrap()
            .id,
        compacted.id
    );
}

#[test]
fn save_and_activate_message_revision() {
    let db = test_db();
    let session = create_session(&db, None, None, None, None, None).unwrap();
    let user = user_msg("u1", "hello", "2025-05-01T00:00:00Z");
    let mut a1 = user_msg("a1", "first", "2025-05-01T00:00:01Z");
    a1.role = "assistant".into();
    let mut a2 = user_msg("a2", "second", "2025-05-01T00:00:02Z");
    a2.role = "assistant".into();
    let branch1 = vec![user.clone(), a1.clone()];
    let branch2 = vec![user.clone(), a2.clone()];
    let r1 = save_message_revision(&db, &session.id, "u1", &branch1, true).unwrap();
    assert_eq!(r1.revision_index, 1);
    let r2 = save_message_revision(&db, &session.id, "u1", &branch2, true).unwrap();
    assert_eq!(r2.revision_index, 2);
    let listed = list_message_revisions(&db, &session.id, "u1").unwrap();
    assert_eq!(listed.len(), 2);
    assert!(listed.iter().any(|r| r.revision_index == 1 && !r.is_active));
    assert!(listed.iter().any(|r| r.revision_index == 2 && r.is_active));
    let activated = activate_message_revision(&db, &session.id, "u1", 1, &[]).unwrap();
    assert_eq!(activated.len(), 2);
    assert_eq!(activated[1].content, "first");
    assert_eq!(activated[0].revision_root_id.as_deref(), Some("u1"));
    assert_eq!(activated[0].active_revision, Some(1));
    assert_eq!(activated[0].revision_count, Some(2));
    let detail = get_session(&db, &session.id).unwrap().unwrap();
    assert_eq!(detail.messages[1].content, "first");
    assert_eq!(detail.messages[0].active_revision, Some(1));
    assert_eq!(detail.messages[0].revision_count, Some(2));

    // Switching forward restores the second branch and keeps the family key.
    let activated2 = activate_message_revision(&db, &session.id, "u1", 2, &[]).unwrap();
    assert_eq!(activated2[1].content, "second");
    assert_eq!(activated2[0].active_revision, Some(2));
    assert_eq!(activated2[0].revision_root_id.as_deref(), Some("u1"));
}

#[test]
fn save_active_branch_revision_keeps_a_message_appended_after_its_read() {
    let db = test_db();
    let session = create_session(&db, None, None, None, None, None).unwrap();
    let turn = begin_turn(&db, &session.id, Some("p1"), Some("m1")).unwrap();
    // Regenerate archived the discarded original branch as revision 1 and
    // stamped the rewritten prompt as revision 2 of the same family.
    let mut discarded = user_msg("u1", "do it", "2025-04-30T00:00:00Z");
    let mut discarded_answer = user_msg("a1", "the discarded answer", "2025-04-30T00:00:01Z");
    discarded_answer.role = "assistant".into();
    discarded.revision_root_id = Some("u1".into());
    save_message_revision(
        &db,
        &session.id,
        "u1",
        &[discarded, discarded_answer],
        false,
    )
    .unwrap();
    let mut root = user_msg("u2", "redo it", "2025-05-01T00:00:00Z");
    root.revision_root_id = Some("u1".into());
    root.revision_count = Some(2);
    root.active_revision = Some(2);
    append_message(&db, &session.id, &root, Some(&turn)).unwrap();
    let mut tool = user_msg("t1", "ran a command", "2025-05-01T00:00:01Z");
    tool.role = "assistant".into();
    append_message(&db, &session.id, &tool, Some(&turn)).unwrap();

    // The turn's final assistant message lands while the archive is already
    // in flight — the case that used to lose it to a stale rewrite.
    let mut answer = user_msg("a9", "the finished answer", "2025-05-01T00:00:02Z");
    answer.role = "assistant".into();
    append_message(&db, &session.id, &answer, Some(&turn)).unwrap();

    let saved = save_active_branch_revision(&db, &session.id)
        .unwrap()
        .expect("a revision-bearing root is archived");
    assert!(saved.archived);
    assert_eq!(saved.root_user_id, "u1");
    assert_eq!(saved.active_revision, 2);

    // Nothing was dropped, and the pager stamp landed on the root.
    let detail = get_session(&db, &session.id).unwrap().unwrap();
    assert_eq!(
        detail
            .messages
            .iter()
            .map(|m| m.id.as_str())
            .collect::<Vec<_>>(),
        vec!["u2", "t1", "a9"],
    );
    assert_eq!(detail.messages[0].revision_count, Some(2));
    assert_eq!(detail.messages[0].active_revision, Some(2));
    assert_eq!(detail.messages[0].revision_root_id.as_deref(), Some("u1"));

    // The branch carries the final answer, so switching back to it later
    // restores a complete turn. It is still live, so what the file holds is
    // a reference to the transcript suffix rather than a second copy of it.
    let payload = transcripts::read_revision(db.data_dir(), &session.id, "u1", 2)
        .unwrap()
        .expect("branch payload");
    assert!(matches!(payload, transcripts::RevisionPayload::Live(_)));
    let branch = &detail.messages[live_branch_start(&detail.messages, "u1").unwrap()..];
    assert_eq!(branch.last().unwrap().id, "a9");

    // A one-line stamp must not reseat the index: seq order and the owning
    // turn stay intact.
    let rows: Vec<(String, i64, Option<String>)> = {
        let conn = db.conn();
        let mut stmt = conn
            .prepare("SELECT id, seq, turn_id FROM messages WHERE session_id = ?1 ORDER BY seq")
            .unwrap();
        let mapped = stmt
            .query_map(params![session.id], |row| {
                Ok((row.get(0)?, row.get(1)?, row.get(2)?))
            })
            .unwrap();
        mapped.map(|row| row.unwrap()).collect()
    };
    assert_eq!(
        rows,
        vec![
            ("u2".to_string(), 0, Some(turn.clone())),
            ("t1".to_string(), 1, Some(turn.clone())),
            ("a9".to_string(), 2, Some(turn.clone())),
        ],
    );
}

#[test]
fn save_active_branch_revision_is_none_without_regenerate_history() {
    let db = test_db();
    let session = create_session(&db, None, None, None, None, None).unwrap();
    append_message(
        &db,
        &session.id,
        &user_msg("u1", "hello", "2025-05-01T00:00:00Z"),
        None,
    )
    .unwrap();
    assert!(save_active_branch_revision(&db, &session.id)
        .unwrap()
        .is_none());
    assert!(list_message_revisions(&db, &session.id, "u1")
        .unwrap()
        .is_empty());
}

#[test]
fn save_active_branch_revision_restamps_an_already_archived_branch() {
    let db = test_db();
    let session = create_session(&db, None, None, None, None, None).unwrap();
    let mut root = user_msg("u1", "hello", "2025-05-01T00:00:00Z");
    root.revision_count = Some(1);
    root.active_revision = Some(1);
    append_message(&db, &session.id, &root, None).unwrap();
    save_message_revision(&db, &session.id, "u1", &[root.clone()], true).unwrap();

    let saved = save_active_branch_revision(&db, &session.id)
        .unwrap()
        .unwrap();
    assert!(!saved.archived, "revision 1 is already on disk");
    assert_eq!(saved.revision_count, 1);
    assert_eq!(
        list_message_revisions(&db, &session.id, "u1")
            .unwrap()
            .len(),
        1,
    );
}

#[test]
fn save_active_branch_revision_refreshes_an_already_archived_branch() {
    let db = test_db();
    let session = create_session(&db, None, None, None, None, None).unwrap();
    let mut root = user_msg("u1", "hello", "2025-05-01T00:00:00Z");
    root.revision_count = Some(1);
    root.active_revision = Some(1);
    append_message(&db, &session.id, &root, None).unwrap();
    save_message_revision(&db, &session.id, "u1", &[root.clone()], true).unwrap();

    // A later prompt on the same branch: the archived copy is now short.
    append_message(
        &db,
        &session.id,
        &user_msg("u2", "and then", "2025-05-01T00:01:00Z"),
        None,
    )
    .unwrap();
    let mut answer = user_msg("a2", "done", "2025-05-01T00:01:01Z");
    answer.role = "assistant".into();
    append_message(&db, &session.id, &answer, None).unwrap();

    let saved = save_active_branch_revision(&db, &session.id)
        .unwrap()
        .unwrap();
    assert!(!saved.archived, "no new index is minted");
    assert_eq!(saved.revision_count, 1);
    // The branch is still live, so the refresh records a reference and the
    // messages stay in the transcript instead of being copied into the
    // revisions file again on every turn.
    let payload = transcripts::read_revision(db.data_dir(), &session.id, "u1", 1)
        .unwrap()
        .unwrap();
    assert!(matches!(payload, transcripts::RevisionPayload::Live(_)));
    let live = get_session(&db, &session.id).unwrap().unwrap().messages;
    let branch = &live[live_branch_start(&live, "u1").unwrap()..];
    assert_eq!(
        branch.iter().map(|m| m.id.as_str()).collect::<Vec<_>>(),
        vec!["u1", "u2", "a2"],
    );
    let listed = list_message_revisions(&db, &session.id, "u1").unwrap();
    assert_eq!(listed[0].message_count, 3);
    assert!(listed[0].is_active);
}

/// The reason a live branch is referenced and not copied: a branch that is
/// still in the transcript must cost the revisions file nothing, however
/// many turns run over it. Copying it per turn is what made a real session
/// reach 107 MB for 1152 messages — every turn rewrote a tail that had grown
/// since the turn before, which is O(N²) bytes for content the transcript
/// already held.
#[test]
fn a_live_branch_is_referenced_and_never_copied() {
    let db = test_db();
    let session = create_session(&db, None, None, None, None, None).unwrap();
    let turn = begin_turn(&db, &session.id, Some("p1"), Some("m1")).unwrap();
    let mut root = user_msg("u1", "start", "2025-05-01T00:00:00Z");
    root.revision_count = Some(1);
    root.active_revision = Some(1);
    append_message(&db, &session.id, &root, Some(&turn)).unwrap();

    // Ten finished turns, each appending a sizeable answer, each archived
    // exactly the way a real turn ends.
    for index in 0..10 {
        let mut answer = user_msg(
            &format!("a{index}"),
            &"x".repeat(20_000),
            "2025-05-01T00:01:00Z",
        );
        answer.role = "assistant".into();
        append_message(&db, &session.id, &answer, Some(&turn)).unwrap();
        assert!(
            save_active_branch_revision(&db, &session.id)
                .unwrap()
                .is_some(),
            "the stamped root archives on every turn"
        );
    }

    let path = transcripts::revisions_path(db.data_dir(), &session.id).unwrap();
    let written = std::fs::metadata(&path).unwrap().len();
    assert!(
        written < 8 * 1024,
        "ten turns over a 200 KB branch wrote {written} bytes; \
         a live branch must be referenced, not copied"
    );

    // The branch is still one revision, still counted, and still resolves
    // to every message the transcript holds.
    let listed = list_message_revisions(&db, &session.id, "u1").unwrap();
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0].message_count, 11);
    assert!(matches!(
        transcripts::read_revision(db.data_dir(), &session.id, "u1", 1)
            .unwrap()
            .unwrap(),
        transcripts::RevisionPayload::Live(_)
    ));
    let live = get_session(&db, &session.id).unwrap().unwrap().messages;
    let branch = &live[live_branch_start(&live, "u1").unwrap()..];
    assert_eq!(branch.len(), 11);
    assert_eq!(branch.last().unwrap().id, "a9");
    // The reference carries no turn map: a live branch's rows are the
    // session's own index rows, so a restore reads their turns from there.
    // That is what keeps the reference constant-sized instead of one entry
    // per branch message on every turn.
    let payload = transcripts::read_revision(db.data_dir(), &session.id, "u1", 1)
        .unwrap()
        .unwrap();
    assert!(payload.turns().is_empty());
    let line_bytes = {
        let raw = std::fs::read_to_string(
            transcripts::revisions_path(db.data_dir(), &session.id).unwrap(),
        )
        .unwrap();
        raw.lines().last().unwrap().len()
    };
    assert!(
        line_bytes < 160,
        "the newest reference is {line_bytes} bytes; it must not grow with the branch"
    );

    // And the restore still re-attaches every message to its turn.
    let restored = activate_message_revision(&db, &session.id, "u1", 1, &[]).unwrap();
    assert_eq!(restored.len(), 11);
    let with_turn: i64 = db
        .conn()
        .query_row(
            "SELECT COUNT(*) FROM messages
             WHERE session_id = ?1 AND turn_id = ?2",
            params![session.id, turn],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(with_turn, 11, "all eleven rows keep their owning turn");
}

/// Deleting the turn that owns a regenerate family takes its branch out of
/// the transcript, so the reference written while that branch was live has
/// to become a stored payload in the same breath. Otherwise the file names
/// a suffix that no longer exists and paging back to the variant fails.
#[test]
fn dropping_a_branch_root_stores_its_live_reference_first() {
    let db = test_db();
    let session = create_session(&db, None, None, None, None, None).unwrap();
    let turn = begin_turn(&db, &session.id, Some("p1"), Some("m1")).unwrap();
    let mut root = user_msg("u1", "start", "2025-05-01T00:00:00Z");
    root.revision_count = Some(1);
    root.active_revision = Some(1);
    append_message(&db, &session.id, &root, Some(&turn)).unwrap();
    let mut answer = user_msg("a1", "the answer", "2025-05-01T00:01:00Z");
    answer.role = "assistant".into();
    append_message(&db, &session.id, &answer, Some(&turn)).unwrap();
    save_active_branch_revision(&db, &session.id)
        .unwrap()
        .unwrap();
    assert!(matches!(
        transcripts::read_revision(db.data_dir(), &session.id, "u1", 1)
            .unwrap()
            .unwrap(),
        transcripts::RevisionPayload::Live(_)
    ));

    // The user deletes the turn. No revision call of its own runs for it.
    let mut other = user_msg("u2", "another question", "2025-05-01T00:02:00Z");
    other.role = "assistant".into();
    replace_messages(&db, &session.id, &[other]).unwrap();

    let stored = match transcripts::read_revision(db.data_dir(), &session.id, "u1", 1)
        .unwrap()
        .expect("the dropped branch was stored before the rewrite")
    {
        transcripts::RevisionPayload::Stored(record) => record,
        transcripts::RevisionPayload::Live(_) => {
            panic!("a branch that left the transcript must be stored")
        }
    };
    assert_eq!(
        stored
            .messages
            .iter()
            .map(|m| m.id.as_str())
            .collect::<Vec<_>>(),
        vec!["u1", "a1"]
    );
}

/// Two user turns each own a regenerate family and both are referenced, then
/// an edit cuts the earlier one away. The later family's root leaves the
/// transcript in that same rewrite, so its reference has to be stored in
/// full — it is not the branch the truncate archives itself.
#[test]
fn truncate_from_stores_a_later_familys_reference_first() {
    let db = test_db();
    let session = create_session(&db, None, None, None, None, None).unwrap();
    let turn = begin_turn(&db, &session.id, Some("p1"), Some("m1")).unwrap();
    let mut first = user_msg("u1", "one", "2025-05-01T00:00:00Z");
    first.revision_count = Some(1);
    first.active_revision = Some(1);
    append_message(&db, &session.id, &first, Some(&turn)).unwrap();
    let mut first_answer = user_msg("a1", "first answer", "2025-05-01T00:00:01Z");
    first_answer.role = "assistant".into();
    append_message(&db, &session.id, &first_answer, Some(&turn)).unwrap();
    save_active_branch_revision(&db, &session.id)
        .unwrap()
        .unwrap();

    let mut second = user_msg("u2", "two", "2025-05-01T00:01:00Z");
    second.revision_count = Some(1);
    second.active_revision = Some(1);
    append_message(&db, &session.id, &second, Some(&turn)).unwrap();
    let mut second_answer = user_msg("a2", "second answer", "2025-05-01T00:01:01Z");
    second_answer.role = "assistant".into();
    append_message(&db, &session.id, &second_answer, Some(&turn)).unwrap();
    save_active_branch_revision(&db, &session.id)
        .unwrap()
        .unwrap();

    let second_index = list_message_revisions(&db, &session.id, "u2").unwrap()[0].revision_index;
    assert!(matches!(
        transcripts::read_revision(db.data_dir(), &session.id, "u2", second_index)
            .unwrap()
            .unwrap(),
        transcripts::RevisionPayload::Live(_)
    ));

    // Editing the FIRST turn cuts the whole second turn away from the
    // transcript, and only the first family is the regenerate root.
    truncate_from(&db, &session.id, Some("u1"), None).unwrap();

    let stored = match transcripts::read_revision(db.data_dir(), &session.id, "u2", second_index)
        .unwrap()
        .expect("the later family was stored before its root left the transcript")
    {
        transcripts::RevisionPayload::Stored(record) => record,
        transcripts::RevisionPayload::Live(_) => {
            panic!("a branch that left the transcript must be stored")
        }
    };
    assert_eq!(
        stored
            .messages
            .iter()
            .map(|m| m.id.as_str())
            .collect::<Vec<_>>(),
        vec!["u2", "a2"]
    );
}

/// The other half of the same hazard: a revision switch restores a prefix
/// from before a later family, and that later family leaves the transcript
/// without the switch ever naming it.
#[test]
fn activate_message_revision_stores_a_later_familys_reference_first() {
    let db = test_db();
    let session = create_session(&db, None, None, None, None, None).unwrap();
    let turn = begin_turn(&db, &session.id, Some("p1"), Some("m1")).unwrap();
    // Family u1 has two variants: the first does not contain u2 at all.
    let mut first = user_msg("u1", "one", "2025-05-01T00:00:00Z");
    first.revision_count = Some(2);
    first.active_revision = Some(2);
    append_message(&db, &session.id, &first, Some(&turn)).unwrap();
    let mut first_answer = user_msg("a1", "v1 answer", "2025-05-01T00:00:01Z");
    first_answer.role = "assistant".into();
    save_message_revision(
        &db,
        &session.id,
        "u1",
        &[first.clone(), first_answer.clone()],
        false,
    )
    .unwrap();
    append_message(&db, &session.id, &first_answer, Some(&turn)).unwrap();

    let mut second = user_msg("u2", "two", "2025-05-01T00:01:00Z");
    second.revision_count = Some(1);
    second.active_revision = Some(1);
    append_message(&db, &session.id, &second, Some(&turn)).unwrap();
    let mut second_answer = user_msg("a2", "second answer", "2025-05-01T00:01:01Z");
    second_answer.role = "assistant".into();
    append_message(&db, &session.id, &second_answer, Some(&turn)).unwrap();
    save_active_branch_revision(&db, &session.id)
        .unwrap()
        .unwrap();

    let second_index = list_message_revisions(&db, &session.id, "u2").unwrap()[0].revision_index;
    assert!(matches!(
        transcripts::read_revision(db.data_dir(), &session.id, "u2", second_index)
            .unwrap()
            .unwrap(),
        transcripts::RevisionPayload::Live(_)
    ));

    // Variant 1 of u1 predates u2, so restoring it drops u2 entirely.
    let restored = activate_message_revision(&db, &session.id, "u1", 1, &[]).unwrap();
    assert_eq!(
        restored.iter().map(|m| m.id.as_str()).collect::<Vec<_>>(),
        vec!["u1", "a1"]
    );

    let stored = match transcripts::read_revision(db.data_dir(), &session.id, "u2", second_index)
        .unwrap()
        .expect("the later family was stored before the switch dropped it")
    {
        transcripts::RevisionPayload::Stored(record) => record,
        transcripts::RevisionPayload::Live(_) => {
            panic!("a branch that left the transcript must be stored")
        }
    };
    assert_eq!(
        stored
            .messages
            .iter()
            .map(|m| m.id.as_str())
            .collect::<Vec<_>>(),
        vec!["u2", "a2"]
    );
}

/// The incident shape: a branch archived on agent_end kept growing (later
/// prompts, an error-ended turn that never re-archived it). Paging away and
/// back must restore all of it, not the copy taken at the first archive.
#[test]
fn activate_message_revision_archives_the_grown_live_branch_first() {
    let db = test_db();
    let session = create_session(&db, None, None, None, None, None).unwrap();
    let turn = begin_turn(&db, &session.id, Some("p1"), Some("m1")).unwrap();
    let prefix_msg = user_msg("u0", "earlier", "2025-04-29T00:00:00Z");
    append_message(&db, &session.id, &prefix_msg, Some(&turn)).unwrap();
    // Regenerate archived the original tail as revision 1 ...
    let mut discarded = user_msg("u1", "do it", "2025-04-30T00:00:00Z");
    discarded.revision_root_id = Some("u1".into());
    let mut discarded_answer = user_msg("a1", "old answer", "2025-04-30T00:00:01Z");
    discarded_answer.role = "assistant".into();
    save_message_revision(
        &db,
        &session.id,
        "u1",
        &[discarded, discarded_answer],
        false,
    )
    .unwrap();
    // ... and the rewritten prompt finished and was archived as revision 2.
    let mut root = user_msg("u2", "redo it", "2025-05-01T00:00:00Z");
    root.revision_root_id = Some("u1".into());
    root.revision_count = Some(2);
    root.active_revision = Some(2);
    append_message(&db, &session.id, &root, Some(&turn)).unwrap();
    let mut answer = user_msg("a2", "new answer", "2025-05-01T00:00:01Z");
    answer.role = "assistant".into();
    append_message(&db, &session.id, &answer, Some(&turn)).unwrap();
    save_message_revision(&db, &session.id, "u1", &[root, answer], true).unwrap();
    // The conversation went on; this turn ended in an error, so nothing
    // re-archived the branch.
    append_message(
        &db,
        &session.id,
        &user_msg("u3", "continue", "2025-05-01T00:05:00Z"),
        Some(&turn),
    )
    .unwrap();
    let mut failed = user_msg("a3", "", "2025-05-01T00:05:01Z");
    failed.role = "assistant".into();
    failed.status = Some("error".into());
    append_message(&db, &session.id, &failed, Some(&turn)).unwrap();

    // Page back to the original, with a deliberately wrong renderer prefix:
    // the durable transcript decides what stays in front of the branch.
    let back = activate_message_revision(&db, &session.id, "u1", 1, &[]).unwrap();
    assert_eq!(
        back.iter().map(|m| m.id.as_str()).collect::<Vec<_>>(),
        vec!["u0", "u1", "a1"],
    );
    let listed = list_message_revisions(&db, &session.id, "u1").unwrap();
    assert_eq!(listed.len(), 2, "no extra variant was minted");
    assert_eq!(
        listed[1].message_count, 4,
        "revision 2 now holds the grown branch"
    );

    // Page forward again: the whole grown branch is back, including the
    // failed turn, and the prefix kept its owning turn.
    let forward = activate_message_revision(&db, &session.id, "u1", 2, &[]).unwrap();
    assert_eq!(
        forward.iter().map(|m| m.id.as_str()).collect::<Vec<_>>(),
        vec!["u0", "u2", "a2", "u3", "a3"],
    );
    assert_eq!(forward[1].active_revision, Some(2));
    assert_eq!(forward[1].revision_count, Some(2));
    let detail = get_session(&db, &session.id).unwrap().unwrap();
    assert_eq!(detail.messages.len(), 5);
    let prefix_turn: Option<String> = db
        .conn()
        .query_row(
            "SELECT turn_id FROM messages WHERE session_id = ?1 AND id = 'u0'",
            params![session.id],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(prefix_turn.as_deref(), Some(turn.as_str()));
    let restored_with_turn: i64 = db
        .conn()
        .query_row(
            "SELECT COUNT(*) FROM messages
             WHERE session_id = ?1 AND turn_id = ?2 AND id IN ('u2', 'a2', 'u3', 'a3')",
            params![session.id, turn],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(
        restored_with_turn, 4,
        "rows that left the index with the branch get their turn back"
    );
}

/// A regenerate stamped the new prompt as variant 2, then its turn failed
/// before agent_end archived it. Paging away must store that tail as its
/// own variant instead of writing it over variant 1.
#[test]
fn activate_message_revision_keeps_a_stamped_unarchived_branch_as_its_own_variant() {
    let db = test_db();
    let session = create_session(&db, None, None, None, None, None).unwrap();
    let mut discarded = user_msg("u1", "do it", "2025-04-30T00:00:00Z");
    discarded.revision_root_id = Some("u1".into());
    let mut discarded_answer = user_msg("a1", "old answer", "2025-04-30T00:00:01Z");
    discarded_answer.role = "assistant".into();
    save_message_revision(
        &db,
        &session.id,
        "u1",
        &[discarded, discarded_answer],
        false,
    )
    .unwrap();
    let mut root = user_msg("u2", "redo it", "2025-05-01T00:00:00Z");
    root.revision_root_id = Some("u1".into());
    root.revision_count = Some(2);
    root.active_revision = Some(2);
    append_message(&db, &session.id, &root, None).unwrap();
    let mut failed = user_msg("a2", "", "2025-05-01T00:00:01Z");
    failed.role = "assistant".into();
    failed.status = Some("error".into());
    append_message(&db, &session.id, &failed, None).unwrap();

    let back = activate_message_revision(&db, &session.id, "u1", 1, &[]).unwrap();
    assert_eq!(
        back.iter().map(|m| m.id.as_str()).collect::<Vec<_>>(),
        vec!["u1", "a1"],
    );
    let listed = list_message_revisions(&db, &session.id, "u1").unwrap();
    assert_eq!(listed.len(), 2);
    let original = transcripts::read_revision(db.data_dir(), &session.id, "u1", 1)
        .unwrap()
        .unwrap();
    let stored = match original {
        transcripts::RevisionPayload::Stored(record) => record,
        transcripts::RevisionPayload::Live(_) => {
            panic!("variant 1 was archived before the switch and stays stored")
        }
    };
    assert_eq!(
        stored.messages.last().unwrap().id,
        "a1",
        "variant 1 is intact"
    );
    let forward = activate_message_revision(&db, &session.id, "u1", 2, &[]).unwrap();
    assert_eq!(
        forward.iter().map(|m| m.id.as_str()).collect::<Vec<_>>(),
        vec!["u2", "a2"],
    );
}

#[test]
fn refresh_message_revision_rejects_an_unknown_index() {
    let db = test_db();
    let session = create_session(&db, None, None, None, None, None).unwrap();
    let root = user_msg("u1", "hello", "2025-05-01T00:00:00Z");
    assert!(refresh_message_revision(&db, &session.id, "u1", 1, &[root]).is_err());
}

#[test]
fn truncate_from_drops_the_tail_and_archives_the_discarded_branch() {
    let db = test_db();
    let session = create_session(&db, None, None, None, None, None).unwrap();
    let turn = begin_turn(&db, &session.id, Some("p1"), Some("m1")).unwrap();
    append_message(
        &db,
        &session.id,
        &user_msg("u0", "earlier", "2025-05-01T00:00:00Z"),
        Some(&turn),
    )
    .unwrap();
    let mut root = user_msg("u1", "do it", "2025-05-01T00:00:01Z");
    root.revision_root_id = Some("u1".into());
    root.revision_count = Some(1);
    root.active_revision = Some(1);
    append_message(&db, &session.id, &root, Some(&turn)).unwrap();
    let mut answer = user_msg("a1", "old answer", "2025-05-01T00:00:02Z");
    answer.role = "assistant".into();
    append_message(&db, &session.id, &answer, Some(&turn)).unwrap();

    let result = truncate_from(&db, &session.id, Some("u1"), None).unwrap();
    assert_eq!(result.kept_count, 1);
    assert_eq!(result.discarded_count, 2);
    assert_eq!(result.aborted_turn_id.as_deref(), Some(turn.as_str()));
    let revision = result.revision.unwrap();
    assert_eq!(revision.root_user_id, "u1");
    assert_eq!(revision.revision_count, 2);
    assert_eq!(revision.active_revision, 2);

    let detail = get_session(&db, &session.id).unwrap().unwrap();
    assert_eq!(
        detail
            .messages
            .iter()
            .map(|m| m.id.as_str())
            .collect::<Vec<_>>(),
        vec!["u0"]
    );
    let status: String = db
        .conn()
        .query_row(
            "SELECT status FROM turns WHERE id = ?1",
            params![turn],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(status, "aborted");
    let listed = list_message_revisions(&db, &session.id, "u1").unwrap();
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0].message_count, 2);
    assert!(!listed[0].is_active);
    let owning: Option<String> = db
        .conn()
        .query_row(
            "SELECT turn_id FROM messages WHERE session_id = ?1 AND id = 'u0'",
            params![session.id],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(owning.as_deref(), Some(turn.as_str()));
}

#[test]
fn truncate_from_rejects_an_unknown_message() {
    let db = test_db();
    let session = create_session(&db, None, None, None, None, None).unwrap();
    append_message(
        &db,
        &session.id,
        &user_msg("u1", "hello", "2025-05-01T00:00:00Z"),
        None,
    )
    .unwrap();
    let error = truncate_from(&db, &session.id, Some("gone"), None).unwrap_err();
    assert!(error.to_string().contains("NOT_FOUND"));
    assert_eq!(
        get_session(&db, &session.id)
            .unwrap()
            .unwrap()
            .messages
            .len(),
        1
    );
}

#[test]
fn truncate_from_refreshes_the_stamped_revision() {
    let db = test_db();
    let session = create_session(&db, None, None, None, None, None).unwrap();
    let mut original = user_msg("u1", "do it", "2025-05-01T00:00:00Z");
    original.revision_root_id = Some("u1".into());
    original.active_revision = Some(1);
    let mut original_answer = user_msg("a0", "stale", "2025-05-01T00:00:01Z");
    original_answer.role = "assistant".into();
    save_message_revision(
        &db,
        &session.id,
        "u1",
        &[original.clone(), original_answer],
        true,
    )
    .unwrap();
    append_message(&db, &session.id, &original, None).unwrap();
    let mut grown = user_msg("a1", "grown answer", "2025-05-01T00:00:02Z");
    grown.role = "assistant".into();
    append_message(&db, &session.id, &grown, None).unwrap();

    truncate_from(&db, &session.id, Some("u1"), None).unwrap();
    let listed = list_message_revisions(&db, &session.id, "u1").unwrap();
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0].message_count, 2);
    let payload = transcripts::read_revision(db.data_dir(), &session.id, "u1", 1)
        .unwrap()
        .unwrap();
    let stored = match payload {
        transcripts::RevisionPayload::Stored(record) => record,
        transcripts::RevisionPayload::Live(_) => {
            panic!("a branch that left the transcript must be stored in full")
        }
    };
    assert_eq!(
        stored
            .messages
            .iter()
            .map(|m| m.id.as_str())
            .collect::<Vec<_>>(),
        vec!["u1", "a1"]
    );
}
