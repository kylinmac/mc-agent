use super::*;

#[test]
fn usage_accounting_roundtrips_without_rewriting_legacy_tokens() {
    let db = test_db();
    let session = create_session(&db, None, None, None, None, None).unwrap();
    let fixtures = [
        json!({"inputTokens": 12, "outputTokens": 3, "totalTokens": 15}),
        json!({
            "inputTokens": 12, "outputTokens": 3, "totalTokens": 15,
            "operationId": "request-1", "usageOrigin": "pi",
            "providerId": "physical-account", "modelId": "physical-model",
            "costStatus": "reported", "aggregation": "operation",
            "cost": {"input": 0.12, "output": 0.03, "cacheRead": 0, "cacheWrite": 0, "total": 0.15}
        }),
        json!({
            "inputTokens": 12, "outputTokens": 3, "totalTokens": 15,
            "costStatus": "unknown", "aggregation": "aggregate",
            "operations": [
                {"operationId": "child-1", "usageOrigin": "pi", "inputTokens": 10, "outputTokens": 2, "totalTokens": 12, "costStatus": "unknown"},
                {"operationId": "classifier-1", "usageOrigin": "pi", "inputTokens": 2, "outputTokens": 1, "totalTokens": 3, "costStatus": "estimated", "cost": {"input": 0.2, "output": 0.1, "cacheRead": 0, "cacheWrite": 0, "total": 0.3}}
            ]
        }),
    ];
    for (index, usage) in fixtures.iter().enumerate() {
        let mut message = user_msg(&format!("usage-{index}"), "answer", "2026-09-30T00:00:00Z");
        message.role = "assistant".into();
        message.usage = Some(serde_json::from_value(usage.clone()).unwrap());
        append_message(&db, &session.id, &message, None).unwrap();
        // Replayed message_end replaces a row; it must not duplicate usage.
        append_message(&db, &session.id, &message, None).unwrap();
    }
    let detail = get_session(&db, &session.id).unwrap().unwrap();
    assert_eq!(detail.messages.len(), fixtures.len());
    for (message, expected) in detail.messages.iter().zip(fixtures) {
        assert_eq!(json!(message.usage), expected);
    }
}

#[test]
fn token_usage_history_aggregation() {
    let db = test_db();
    let session = create_session(&db, None, None, None, None, None).unwrap();
    let turn = begin_turn(&db, &session.id, None, None).unwrap();

    let usage = json!({
        "inputTokens": 120,
        "outputTokens": 80,
        "cacheReadTokens": 40,
        "cacheWriteTokens": 10,
        "reasoningTokens": 20
    });

    let ended =
        end_turn_settling(&db, &turn, "completed", None, Some(&usage), false, false).unwrap();
    assert!(ended.updated);
    let ended_at: i64 = db
        .conn()
        .query_row(
            "SELECT ended_at FROM turns WHERE id = ?1",
            params![turn],
            |r| r.get(0),
        )
        .unwrap();

    let history =
        get_token_usage_history(&db, Some(ended_at - 1_000), Some(ended_at + 1_000), "day")
            .unwrap();
    let totals = history.get("totals").unwrap();
    assert_eq!(totals.get("inputTokens").unwrap().as_i64(), Some(120));
    assert_eq!(totals.get("outputTokens").unwrap().as_i64(), Some(80));
    assert_eq!(totals.get("totalTokens").unwrap().as_i64(), Some(250));
    assert_eq!(totals.get("cacheReadTokens").unwrap().as_i64(), Some(40));
    assert_eq!(totals.get("turnCount").unwrap().as_i64(), Some(1));

    let items = history.get("items").unwrap().as_array().unwrap();
    assert!(!items.is_empty());
    let active = items
        .iter()
        .find(|item| item.get("turnCount").and_then(|v| v.as_i64()) == Some(1))
        .expect("active day");
    assert_eq!(active.get("totalTokens").unwrap().as_i64(), Some(250));
}

#[test]
fn token_usage_history_uses_iso_week_year() {
    let db = test_db();
    let session = create_session(&db, None, None, None, None, None).unwrap();
    let turn = begin_turn(&db, &session.id, None, None).unwrap();
    let usage = json!({ "inputTokens": 1, "outputTokens": 1 });
    end_turn_settling(&db, &turn, "completed", None, Some(&usage), false, false).unwrap();
    // Monday 2025-12-29 is ISO week 1 of 2026.
    let ended_at = chrono::TimeZone::with_ymd_and_hms(&chrono::Utc, 2025, 12, 29, 12, 0, 0)
        .unwrap()
        .timestamp_millis();
    db.conn()
        .execute(
            "UPDATE turns SET ended_at = ?1 WHERE id = ?2",
            params![ended_at, turn],
        )
        .unwrap();

    let history = get_token_usage_history(
        &db,
        Some(ended_at - 86_400_000),
        Some(ended_at + 86_400_000),
        "week",
    )
    .unwrap();
    let items = history.get("items").unwrap().as_array().unwrap();
    let active = items
        .iter()
        .find(|item| item.get("turnCount").and_then(|v| v.as_i64()) == Some(1))
        .expect("iso week");
    assert_eq!(
        active.get("date").and_then(|v| v.as_str()),
        Some("2026-W01")
    );
}

#[test]
fn token_usage_history_defaults_to_a_bounded_window() {
    let db = test_db();
    let history = get_token_usage_history(&db, None, None, "day").unwrap();
    let items = history.get("items").unwrap().as_array().unwrap();
    assert!(items.len() >= 365);
    assert!(items.len() <= 53 * 7 + 1);
    assert_eq!(
        history
            .get("totals")
            .unwrap()
            .get("turnCount")
            .unwrap()
            .as_i64(),
        Some(0)
    );
}
