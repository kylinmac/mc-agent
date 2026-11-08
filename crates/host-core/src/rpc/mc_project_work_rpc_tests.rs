use super::*;
use crate::db::canonical_project_path;
use std::fs;

struct Fixture {
    _dir: tempfile::TempDir,
    state: Arc<Mutex<AppState>>,
    caller: String,
    outsider: String,
    web: String,
}

async fn fixture() -> Fixture {
    let dir = tempfile::tempdir().unwrap();
    let canonical = |path: &Path| canonical_project_path(&path.to_string_lossy()).unwrap();
    let (web, resources, other) = (
        dir.path().join("web"),
        dir.path().join("resources"),
        dir.path().join("other"),
    );
    fs::create_dir_all(resources.join("requirements")).unwrap();
    fs::create_dir_all(web.join("docs")).unwrap();
    fs::create_dir_all(&other).unwrap();
    fs::write(resources.join("requirements/login.md"), "v1").unwrap();
    fs::write(web.join("docs/research.md"), "notes").unwrap();
    let app = AppState::open(dir.path()).unwrap();
    let group = app
        .db
        .create_project_group("App", &[canonical(&web)])
        .unwrap();
    app.db
        .attach_project_resource_root(&group.id, &canonical(&resources))
        .unwrap();
    app.db
        .create_project_group("Other", &[canonical(&other)])
        .unwrap();
    let make = |path: String| {
        sessions::create_session(&app.db, Some("chat".into()), None, None, None, Some(path))
            .unwrap()
            .id
    };
    let caller = make(canonical(&web));
    let outsider = make(canonical(&other));
    Fixture {
        _dir: dir,
        state: Arc::new(Mutex::new(app)),
        caller,
        outsider,
        web: canonical(&web),
    }
}

async fn call(f: &Fixture, session: &str, body: Value) -> Result<Value, JsonRpcError> {
    let mut params = body;
    params["sessionId"] = json!(session);
    handle(&f.state, &params).await
}

fn code(error: JsonRpcError) -> String {
    error
        .data
        .and_then(|d| {
            d.get("errorCode")
                .and_then(Value::as_str)
                .map(str::to_string)
        })
        .unwrap_or_default()
}

#[tokio::test]
async fn tasks_list_get_create_update_stay_small_and_versioned() {
    let f = fixture().await;
    let created = call(&f, &f.caller, json!({"tool":"tasks","action":"create","title":"登录接口","acceptance":"单元测试通过","resources":["folder:requirements/login.md"]})).await.unwrap();
    let id = created["id"].as_str().unwrap().to_string();
    assert_eq!(id.len(), 8);
    assert_eq!(created["revision"], 1);
    assert_eq!(created["status"], "todo");
    assert_eq!(created["project"], "App");
    for n in 0..11 {
        call(&f, &f.caller, json!({"tool":"tasks","action":"create","title":format!("任务 {n}"),"acceptance":"done"})).await.unwrap();
    }

    let listed = call(&f, &f.caller, json!({"tool":"tasks","action":"list"}))
        .await
        .unwrap();
    assert_eq!(listed["tasks"].as_array().unwrap().len(), 10);
    assert_eq!(listed["matched"], 12);
    assert_eq!(listed["nextOffset"], 10);
    assert_eq!(listed["counts"]["todo"], 12);
    let row = &listed["tasks"][0];
    assert_eq!(
        row.as_object().unwrap().keys().cloned().collect::<Vec<_>>(),
        ["id", "status", "title"]
    );
    let found = call(
        &f,
        &f.caller,
        json!({"tool":"tasks","action":"list","query":"登录"}),
    )
    .await
    .unwrap();
    assert_eq!(found["tasks"][0]["id"], id.as_str());

    let detail = call(
        &f,
        &f.caller,
        json!({"tool":"tasks","action":"get","taskId":id}),
    )
    .await
    .unwrap();
    assert_eq!(detail["acceptance"], "单元测试通过");
    assert_eq!(detail["resources"][0]["status"], "draft");
    assert!(detail.get("truncated").is_none());

    let long = "验".repeat(DETAIL_CHARS + 10);
    let updated = call(&f, &f.caller, json!({"tool":"tasks","action":"update","taskId":id,"revision":1,"acceptance":long,"title":"登录接口"})).await.unwrap();
    assert_eq!(
        updated,
        json!({"id": id, "revision": 2, "changed": ["acceptance"], "project": "App"})
    );
    let clipped = call(
        &f,
        &f.caller,
        json!({"tool":"tasks","action":"get","taskId":id}),
    )
    .await
    .unwrap();
    assert_eq!(clipped["truncated"], json!(["acceptance"]));
    let whole = call(
        &f,
        &f.caller,
        json!({"tool":"tasks","action":"get","taskId":id,"full":true}),
    )
    .await
    .unwrap();
    assert_eq!(
        whole["acceptance"].as_str().unwrap().chars().count(),
        DETAIL_CHARS + 10
    );

    let stale = call(
        &f,
        &f.caller,
        json!({"tool":"tasks","action":"update","taskId":id,"revision":1,"goal":"x"}),
    )
    .await
    .unwrap_err();
    assert_eq!(code(stale), "CONFLICT");
    let nothing = call(
        &f,
        &f.caller,
        json!({"tool":"tasks","action":"update","taskId":id,"revision":2}),
    )
    .await
    .unwrap_err();
    assert_eq!(code(nothing), "INVALID_PARAMS");
}

#[tokio::test]
async fn no_review_cancel_or_status_writes_and_no_other_projects() {
    let f = fixture().await;
    let created = call(
        &f,
        &f.caller,
        json!({"tool":"tasks","action":"create","title":"t","acceptance":"a"}),
    )
    .await
    .unwrap();
    let id = created["id"].as_str().unwrap();
    for action in ["review", "cancel", "reopen", "startRun"] {
        let refused = call(
            &f,
            &f.caller,
            json!({"tool":"tasks","action":action,"taskId":id,"revision":1}),
        )
        .await
        .unwrap_err();
        assert_eq!(code(refused), "INVALID_PARAMS", "{action}");
    }
    for extra in [
        json!({"status":"done"}),
        json!({"verdict":"accepted"}),
        json!({"groupId":"x"}),
    ] {
        let mut body = json!({"tool":"tasks","action":"update","taskId":id,"revision":1});
        body.as_object_mut()
            .unwrap()
            .extend(extra.as_object().unwrap().clone());
        // `status` is only a list filter; update ignores it, so nothing changes.
        assert!(call(&f, &f.caller, body).await.is_err());
    }
    let resource_write = call(
        &f,
        &f.caller,
        json!({"tool":"resources","action":"setStatus","key":"folder:requirements/login.md"}),
    )
    .await
    .unwrap_err();
    assert_eq!(code(resource_write), "INVALID_PARAMS");

    let elsewhere = call(
        &f,
        &f.outsider,
        json!({"tool":"tasks","action":"get","taskId":id}),
    )
    .await
    .unwrap_err();
    assert_eq!(code(elsewhere), "NOT_FOUND");
    let listed = call(&f, &f.outsider, json!({"tool":"tasks","action":"list"}))
        .await
        .unwrap();
    assert_eq!(listed["matched"], 0);
    assert_eq!(listed["project"], "Other");
    let unbound = sessions::create_session(&f.state.lock().await.db, None, None, None, None, None)
        .unwrap()
        .id;
    let denied = call(&f, &unbound, json!({"tool":"tasks","action":"list"}))
        .await
        .unwrap_err();
    assert_eq!(code(denied), "PROJECT_HISTORY_DENIED");
}

#[tokio::test]
async fn resources_list_get_register_and_goal() {
    let f = fixture().await;
    let registered = call(&f, &f.caller, json!({"tool":"resources","action":"register","path":"docs/research.md","category":"research","title":"调研"})).await.unwrap();
    let key = registered["key"].as_str().unwrap().to_string();
    let linked = call(
        &f,
        &f.caller,
        json!({"tool":"resources","action":"register","url":"https://example.com/spec"}),
    )
    .await
    .unwrap();
    assert!(linked["key"].as_str().unwrap().starts_with("index:"));
    let both = call(&f, &f.caller, json!({"tool":"resources","action":"register","url":"https://example.com","path":"docs/research.md"})).await.unwrap_err();
    assert_eq!(code(both), "INVALID_PARAMS");
    let outside = call(
        &f,
        &f.caller,
        json!({"tool":"resources","action":"register","path":"/etc/hosts"}),
    )
    .await
    .unwrap_err();
    assert_eq!(code(outside), "INVALID_PARAMS");

    let listed = call(&f, &f.caller, json!({"tool":"resources","action":"list"}))
        .await
        .unwrap();
    assert_eq!(listed["matched"], 3);
    assert!(listed["resources"]
        .as_array()
        .unwrap()
        .iter()
        .all(|row| row.get("path").is_none()));
    let drafts = call(
        &f,
        &f.caller,
        json!({"tool":"resources","action":"list","status":"draft","query":"调研"}),
    )
    .await
    .unwrap();
    assert_eq!(drafts["resources"][0]["key"], key.as_str());

    let got = call(
        &f,
        &f.caller,
        json!({"tool":"resources","action":"get","key":key}),
    )
    .await
    .unwrap();
    assert_eq!(got["path"], format!("{}/docs/research.md", f.web));
    assert_eq!(got["status"], "draft");
    let missing = call(
        &f,
        &f.caller,
        json!({"tool":"resources","action":"get","key":"index:nope"}),
    )
    .await
    .unwrap_err();
    assert_eq!(code(missing), "NOT_FOUND");

    let goal = call(&f, &f.caller, json!({"tool":"resources","action":"goal"}))
        .await
        .unwrap();
    assert_eq!(goal["goal"], "");
}
