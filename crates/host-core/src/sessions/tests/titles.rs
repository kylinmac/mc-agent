use super::*;

#[test]
fn default_title_matches_the_german_french_and_spanish_placeholders() {
    // The renderer lowercases `chat.untitledTask` before persisting (#1755);
    // the nav.newChat labels resolve through the same to_lowercase path.
    assert!(is_default_title("neue aufgabe"));
    assert!(is_default_title("Nouvelle tâche"));
    assert!(is_default_title("nueva tarea"));
    assert!(is_default_title("Neuer Chat"));
    assert!(is_default_title("nuevo chat"));
    assert!(is_default_title("Nouvelle discussion"));
    assert!(!is_default_title("real session name"));
}

#[test]
fn rename_session_normalizes_title_without_touching_activity() {
    let db = test_db();
    let session = create_session(&db, Some("Original".into()), None, None, None, None).unwrap();
    let before: i64 = db
        .conn()
        .query_row(
            "SELECT updated_at FROM sessions WHERE id = ?1",
            params![session.id],
            |row| row.get(0),
        )
        .unwrap();

    assert!(rename_session(&db, &session.id, "  Renamed task  ").unwrap());
    let renamed = get_session(&db, &session.id).unwrap().unwrap();
    assert_eq!(renamed.summary.title, "Renamed task");
    let after: i64 = db
        .conn()
        .query_row(
            "SELECT updated_at FROM sessions WHERE id = ?1",
            params![session.id],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(after, before);

    assert!(rename_session(&db, &session.id, &"界".repeat(MAX_SESSION_TITLE_CHARS),).is_ok());
    assert!(rename_session(&db, &session.id, "   ").is_err());
    assert!(rename_session(&db, &session.id, &"x".repeat(MAX_SESSION_TITLE_CHARS + 1),).is_err());
    assert!(!rename_session(&db, "missing", "Valid").unwrap());
}

#[test]
fn derived_prompt_title_stays_eligible_for_the_title_plugin() {
    let db = test_db();
    let session = create_session(&db, None, None, None, None, None).unwrap();
    append_message(
        &db,
        &session.id,
        &user_msg("user-1", "Fix the login button", "2026-01-01T00:00:01Z"),
        None,
    )
    .unwrap();
    let before: i64 = db
        .conn()
        .query_row(
            "SELECT updated_at FROM sessions WHERE id = ?1",
            params![session.id],
            |row| row.get(0),
        )
        .unwrap();

    assert!(derive_session_title(&db, &session.id, "Fix login bug").unwrap());
    let derived = get_session(&db, &session.id).unwrap().unwrap();
    assert_eq!(derived.summary.title, "Fix login bug");
    let after: i64 = db
        .conn()
        .query_row(
            "SELECT updated_at FROM sessions WHERE id = ?1",
            params![session.id],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(after, before);

    // The derived text is still an automatic title: the plugin reads it as
    // the expected title and may replace it.
    let context = auto_title_context(&db, &session.id).unwrap().unwrap();
    assert_eq!(context.expected_title, "Fix login bug");
    assert_eq!(context.user_prompt, "Fix the login button");
    assert!(set_automatic_session_title(&db, &session.id, "Fix login bug", "Login fix").unwrap());
    assert_eq!(
        get_session(&db, &session.id)
            .unwrap()
            .unwrap()
            .summary
            .title,
        "Login fix"
    );
    assert!(auto_title_context(&db, &session.id).unwrap().is_none());
}

#[test]
fn derived_prompt_title_never_overrides_named_sessions() {
    let db = test_db();
    let manual = create_session(&db, None, None, None, None, None).unwrap();
    assert!(rename_session(&db, &manual.id, "Picked by user").unwrap());
    assert!(!derive_session_title(&db, &manual.id, "First prompt").unwrap());
    assert_eq!(
        get_session(&db, &manual.id).unwrap().unwrap().summary.title,
        "Picked by user"
    );

    let generated = create_session(&db, None, None, None, None, None).unwrap();
    assert!(set_automatic_session_title(&db, &generated.id, "New task", "Generated").unwrap());
    assert!(!derive_session_title(&db, &generated.id, "First prompt").unwrap());

    let named = create_session(&db, Some("Named up front".into()), None, None, None, None).unwrap();
    assert!(!derive_session_title(&db, &named.id, "First prompt").unwrap());

    let returned = create_session(&db, None, None, None, None, None).unwrap();
    assert!(derive_session_title(&db, &returned.id, "First prompt").unwrap());
    assert!(!derive_session_title(&db, &returned.id, "Second prompt").unwrap());
    assert_eq!(
        get_session(&db, &returned.id)
            .unwrap()
            .unwrap()
            .summary
            .title,
        "First prompt"
    );

    assert!(!derive_session_title(&db, "missing", "First prompt").unwrap());
    assert!(derive_session_title(&db, &returned.id, "  ").is_err());
}

#[test]
fn localized_placeholder_titles_accept_the_first_prompt_fallback() {
    let db = test_db();
    for placeholder in [
        "새 작업",
        "新建任務",
        "Tarefa sem título",
        "Yeni görev",
        "New chat",
        "new task",
        "new chat",
        "tarefa sem título",
        "nova conversa",
        "yeni görev",
        "yeni sohbet",
    ] {
        let session =
            create_session(&db, Some(placeholder.into()), None, None, None, None).unwrap();
        assert!(
            derive_session_title(&db, &session.id, "Derived label").unwrap(),
            "{placeholder} must accept the first-prompt fallback"
        );
        assert_eq!(
            get_session(&db, &session.id)
                .unwrap()
                .unwrap()
                .summary
                .title,
            "Derived label"
        );
    }
}

#[test]
fn auto_title_context_is_limited_to_the_first_turn_and_bounded() {
    let db = test_db();
    let session = create_session_with_options(
        &db,
        SessionCreateOptions {
            provider_id: Some("provider".into()),
            model_id: Some("model".into()),
            ..Default::default()
        },
    )
    .unwrap();
    let first_prompt = "p".repeat(1_100);
    append_message(
        &db,
        &session.id,
        &user_msg("user-1", &first_prompt, "2026-01-01T00:00:01Z"),
        None,
    )
    .unwrap();
    let mut first_reply = user_msg("assistant-1", &"r".repeat(600), "2026-01-01T00:00:02Z");
    first_reply.role = "assistant".into();
    append_message(&db, &session.id, &first_reply, None).unwrap();
    append_message(
        &db,
        &session.id,
        &user_msg("user-2", "later prompt", "2026-01-01T00:00:03Z"),
        None,
    )
    .unwrap();
    let mut later_reply = user_msg("assistant-2", "later reply", "2026-01-01T00:00:04Z");
    later_reply.role = "assistant".into();
    append_message(&db, &session.id, &later_reply, None).unwrap();

    let context = auto_title_context(&db, &session.id).unwrap().unwrap();
    assert_eq!(context.session_id, session.id);
    assert_eq!(context.expected_title, "New task");
    assert_eq!(context.user_prompt, "p".repeat(1_000));
    assert_eq!(context.assistant_reply, Some("r".repeat(500)));
    assert_eq!(context.model_key.as_deref(), Some("provider/model"));
}

#[test]
fn automatic_title_compare_and_set_respects_manual_and_stale_titles() {
    let db = test_db();
    let session = create_session(&db, None, None, None, None, None).unwrap();
    assert!(set_automatic_session_title(&db, &session.id, "New task", "Generated").unwrap());
    assert!(auto_title_context(&db, &session.id).unwrap().is_none());
    assert!(!set_automatic_session_title(&db, &session.id, "New task", "Stale").unwrap());

    let manual = create_session(&db, None, None, None, None, None).unwrap();
    assert!(rename_session(&db, &manual.id, "Picked by user").unwrap());
    assert!(!set_automatic_session_title(&db, &manual.id, "New task", "Generated").unwrap());
    assert_eq!(
        get_session(&db, &manual.id).unwrap().unwrap().summary.title,
        "Picked by user"
    );
}
