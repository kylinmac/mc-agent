use super::*;
use crate::db::canonical_project_path;
use crate::mc_creative::{import_reference, FileFacts};
use serde_json::json;

struct Fixture {
    _dir: tempfile::TempDir,
    db: Database,
    group: ProjectGroupRecord,
    web: PathBuf,
}

fn fixture() -> Fixture {
    let dir = tempfile::tempdir().unwrap();
    let web = dir.path().join("web");
    fs::create_dir_all(&web).unwrap();
    let db = Database::open(&dir.path().join("pi.sqlite")).unwrap();
    let group = db
        .create_project_group(
            "Studio",
            &[canonical_project_path(&web.to_string_lossy()).unwrap()],
        )
        .unwrap();
    Fixture {
        web: web.canonicalize().unwrap(),
        _dir: dir,
        db,
        group,
    }
}

fn ops(value: serde_json::Value) -> Vec<Op> {
    serde_json::from_value(value).unwrap()
}

const BOARD_A: &str = r#"<div style="padding: 24px">
  <h1 data-mc-id="headline">登录</h1>
  <button data-mc-id="cta" style="padding: 8px">继续</button>
  <p>忘记密码</p>
</div>"#;

fn with_board(f: &Fixture) -> Canvas {
    let canvas = create(&f.db, &f.group, "登录页方案").unwrap();
    apply(
        &f.db,
        &f.group,
        &canvas.id,
        canvas.version,
        &ops(json!([
            { "op": "add", "element": { "id": "a", "type": "frame", "x": 0, "y": 0, "w": 390, "h": 844, "title": "方案 A" }, "html": BOARD_A },
            { "op": "add", "element": { "type": "note", "x": 420, "y": 0, "text": "按钮太小", "boardId": "a" } },
        ])),
        &Actor::Agent { session_id: "s1".into() },
    )
    .unwrap()
    .canvas
}

#[test]
fn a_canvas_is_plain_files_under_creative_canvas() {
    let f = fixture();
    let canvas = with_board(&f);
    let dir = f.web.join("creative/canvas").join(&canvas.id);
    assert!(dir.join("canvas.json").is_file());
    assert_eq!(
        fs::read_to_string(dir.join("frames/a.html")).unwrap(),
        BOARD_A
    );
    let listed = list(&f.db, &f.group).unwrap();
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0].boards, 1);
    assert_eq!(listed[0].title, "登录页方案");
    assert_eq!(canvas.version, 2);
    assert_eq!(canvas.elements[1].board_id.as_deref(), Some("a"));
    assert_eq!(canvas.elements[1].color.as_deref(), Some("yellow"));
    // The folder name is reserved for canvases.
    assert!(crate::mc_creative::normalize_category("canvas").is_err());
}

#[test]
fn a_stale_version_is_refused_and_nothing_changes() {
    let f = fixture();
    let canvas = with_board(&f);
    let moved = apply(
        &f.db,
        &f.group,
        &canvas.id,
        canvas.version,
        &ops(json!([{ "op": "update", "id": "a", "set": { "x": 100 } }])),
        &Actor::User,
    )
    .unwrap();
    // The agent still holds the older version.
    let error = apply(
        &f.db,
        &f.group,
        &canvas.id,
        canvas.version,
        &ops(json!([{ "op": "update", "id": "a", "set": { "y": 500 } }])),
        &Actor::Agent {
            session_id: "s1".into(),
        },
    )
    .unwrap_err()
    .to_string();
    assert!(error.starts_with("CONFLICT"), "{error}");
    let now = get(&f.db, &f.group, &canvas.id).unwrap();
    assert_eq!(now, moved.canvas);
    assert_eq!(now.elements[0].x, 100.0);
    assert_eq!(now.elements[0].y, 0.0);
}

#[test]
fn a_batch_is_all_or_nothing() {
    let f = fixture();
    let canvas = with_board(&f);
    let error = apply(
        &f.db,
        &f.group,
        &canvas.id,
        canvas.version,
        &ops(json!([
            { "op": "update", "id": "a", "set": { "x": 100 }, "html": "<p>new</p>" },
            { "op": "add", "element": { "type": "frame", "w": 300, "h": 300 }, "html": "<div><span></div>" },
        ])),
        &Actor::Agent { session_id: "s1".into() },
    )
    .unwrap_err()
    .to_string();
    assert!(
        error.contains("operation 2") && error.contains("closes <span>"),
        "{error}"
    );
    let now = get(&f.db, &f.group, &canvas.id).unwrap();
    assert_eq!(now, canvas);
    let dir = f.web.join("creative/canvas").join(&canvas.id);
    assert_eq!(
        fs::read_to_string(dir.join("frames/a.html")).unwrap(),
        BOARD_A
    );
}

#[test]
fn the_agents_change_keeps_the_previous_version_and_restore_swaps() {
    let f = fixture();
    let canvas = with_board(&f);
    let changed = apply(
        &f.db,
        &f.group,
        &canvas.id,
        canvas.version,
        &ops(json!([{ "op": "update", "id": "a", "html": "<p data-mc-id=\"x\">v2</p>" }])),
        &Actor::Agent {
            session_id: "s1".into(),
        },
    )
    .unwrap();
    let board = &changed.canvas.elements[0];
    assert!(board.has_prev);
    assert_eq!(board.rev, 2);
    let sources = board_sources(&f.db, &f.group, &canvas.id, None).unwrap();
    assert!(sources["a"].contains("v2"));
    let restored = apply(
        &f.db,
        &f.group,
        &canvas.id,
        changed.canvas.version,
        &ops(json!([{ "op": "restore", "id": "a" }])),
        &Actor::User,
    )
    .unwrap();
    assert_eq!(
        board_sources(&f.db, &f.group, &canvas.id, None).unwrap()["a"],
        BOARD_A
    );
    // Restoring again brings the agent's version back.
    apply(
        &f.db,
        &f.group,
        &canvas.id,
        restored.canvas.version,
        &ops(json!([{ "op": "restore", "id": "a" }])),
        &Actor::User,
    )
    .unwrap();
    assert!(
        board_sources(&f.db, &f.group, &canvas.id, Some(&["a".into()])).unwrap()["a"]
            .contains("v2")
    );
}

#[test]
fn removing_an_artboard_detaches_its_notes_and_deletes_its_files() {
    let f = fixture();
    let canvas = with_board(&f);
    let after = apply(
        &f.db,
        &f.group,
        &canvas.id,
        canvas.version,
        &ops(json!([{ "op": "remove", "id": "a" }])),
        &Actor::User,
    )
    .unwrap();
    assert_eq!(after.canvas.elements.len(), 1);
    assert_eq!(after.canvas.elements[0].board_id, None);
    let dir = f.web.join("creative/canvas").join(&canvas.id);
    assert!(!dir.join("frames/a.html").exists());
}

#[test]
fn elements_are_checked() {
    let f = fixture();
    let canvas = with_board(&f);
    let refused = [
        (
            json!([{ "op": "add", "element": { "type": "frame", "w": 300, "h": 300 } }]),
            "needs html",
        ),
        (
            json!([{ "op": "add", "element": { "type": "frame", "w": 9000, "h": 300 }, "html": "<p></p>" }]),
            "w must be",
        ),
        (
            json!([{ "op": "add", "element": { "id": "a", "type": "note" } }]),
            "already exists",
        ),
        (
            json!([{ "op": "add", "element": { "type": "note", "color": "neon" } }]),
            "color",
        ),
        (
            json!([{ "op": "add", "element": { "type": "note", "boardId": "zz" } }]),
            "no artboard zz",
        ),
        (
            json!([{ "op": "add", "element": { "type": "image", "assetId": "nope" } }]),
            "no asset",
        ),
        (
            json!([{ "op": "add", "element": { "type": "image" } }]),
            "needs assetId",
        ),
        (
            json!([{ "op": "add", "element": { "id": "../x", "type": "note" } }]),
            "element id",
        ),
        (
            json!([{ "op": "update", "id": "a", "set": { "type": "note" } }]),
            "cannot change",
        ),
        (
            json!([{ "op": "restore", "id": "a" }]),
            "no previous version",
        ),
        (
            json!([{ "op": "update", "id": "a", "html": "<iframe src=\"x\"></iframe>" }]),
            "<iframe>",
        ),
    ];
    for (batch, expected) in refused {
        let error = apply(
            &f.db,
            &f.group,
            &canvas.id,
            canvas.version,
            &ops(batch.clone()),
            &Actor::User,
        )
        .unwrap_err()
        .to_string();
        assert!(error.contains(expected), "{batch}: {error}");
    }
    assert!(get(&f.db, &f.group, "../etc").is_err());
}

#[test]
fn images_show_library_assets_of_this_project_only() {
    let f = fixture();
    let canvas = with_board(&f);
    let png = f.web.join("hero.png");
    fs::write(&png, [0x89, b'P', b'N', b'G', 1]).unwrap();
    let asset = import_reference(&f.db, &f.group, &png, &FileFacts::default(), "").unwrap();
    let after = apply(
        &f.db,
        &f.group,
        &canvas.id,
        canvas.version,
        &ops(json!([
            { "op": "add", "element": { "id": "img", "type": "image", "assetId": asset.id, "w": 200, "h": 120 } },
            { "op": "update", "id": "a", "html": format!("<img src=\"asset:{}\" alt=\"hero\"><img src=\"asset:other\" alt=\"x\">", asset.id) },
        ])),
        &Actor::User,
    )
    .unwrap();
    assert_eq!(
        after.canvas.elements[2].asset_id.as_deref(),
        Some(asset.id.as_str())
    );
    let (served, rev) = board_document(&f.db, &f.group, &canvas.id, "a", |id| {
        format!("mc-canvas://asset/g/{id}")
    })
    .unwrap();
    assert_eq!(rev, 2);
    assert!(served.contains(&format!("src=\"mc-canvas://asset/g/{}\"", asset.id)));
    assert!(served.contains("data-mc-node=\"1\" src=\"\""));
}

#[test]
fn a_picked_element_is_named_from_the_source() {
    let f = fixture();
    let canvas = with_board(&f);
    let node = resolve_node(&f.db, &f.group, &canvas.id, "a", 2).unwrap();
    assert_eq!(node.address, "a#2:0/1");
    assert_eq!(node.mc_id.as_deref(), Some("cta"));
    assert_eq!(node.label.as_deref(), Some("继续"));
    assert_eq!(node.tag, "button");
    assert!(resolve_node(&f.db, &f.group, &canvas.id, "a", 99).is_err());
    assert!(resolve_node(&f.db, &f.group, &canvas.id, "zz", 0).is_err());
}

#[test]
fn comment_threads_follow_their_element_or_say_it_moved() {
    let f = fixture();
    let canvas = with_board(&f);
    let anchor = |node: usize| AnchorInput {
        kind: AnchorKind::Element,
        board_id: Some("a".into()),
        node: Some(node),
        mc_id: None,
        x: 10.0,
        y: 20.0,
    };
    // On the button (has an id) and on the paragraph (has none).
    let (on_button, _) = add_comment(
        &f.db,
        &f.group,
        &canvas.id,
        &anchor(2),
        "按钮放大一点",
        &Actor::User,
    )
    .unwrap();
    let (on_text, comments) = add_comment(
        &f.db,
        &f.group,
        &canvas.id,
        &anchor(3),
        "改成链接",
        &Actor::User,
    )
    .unwrap();
    assert_eq!(comments.threads.len(), 2);
    assert!(comments
        .threads
        .iter()
        .all(|thread| thread.located.state == "ok"));
    // The agent rewrites the artboard: the button moves, the paragraph's text changes.
    apply(
        &f.db,
        &f.group,
        &canvas.id,
        canvas.version,
        &ops(json!([{ "op": "update", "id": "a", "html": "<div><p>新的说明</p><button data-mc-id=\"cta\">继续</button><p>找回密码</p></div>" }])),
        &Actor::Agent { session_id: "s1".into() },
    )
    .unwrap();
    let now = comments_of(&f, &canvas.id);
    let button = now
        .threads
        .iter()
        .find(|thread| thread.thread.id == on_button)
        .unwrap();
    assert_eq!(button.located.state, "ok");
    assert_eq!(button.located.node.as_ref().unwrap().address, "a#2:0/1");
    // Same address, different text: never attached to another element.
    let text = now
        .threads
        .iter()
        .find(|thread| thread.thread.id == on_text)
        .unwrap();
    assert_eq!(text.located.state, "moved");
}

fn comments_of(f: &Fixture, id: &str) -> Comments {
    comments(&f.db, &f.group, id).unwrap()
}

#[test]
fn only_the_conversation_a_thread_was_sent_to_may_answer_it() {
    let f = fixture();
    let canvas = with_board(&f);
    let (thread, _) = add_comment(
        &f.db,
        &f.group,
        &canvas.id,
        &AnchorInput {
            kind: AnchorKind::Board,
            board_id: Some("a".into()),
            node: None,
            mc_id: None,
            x: 5.0,
            y: 5.0,
        },
        "整体再紧凑些",
        &Actor::User,
    )
    .unwrap();
    let agent = Actor::Agent {
        session_id: "s1".into(),
    };
    let refused = reply(&f.db, &f.group, &canvas.id, &thread, "好的", &agent)
        .unwrap_err()
        .to_string();
    assert!(refused.starts_with("PERMISSION_DENIED"), "{refused}");
    assign(&f.db, &f.group, &canvas.id, &thread, "s1").unwrap();
    let other = Actor::Agent {
        session_id: "s2".into(),
    };
    assert!(set_status(
        &f.db,
        &f.group,
        &canvas.id,
        &thread,
        ThreadStatus::Resolved,
        &other
    )
    .is_err());
    reply(&f.db, &f.group, &canvas.id, &thread, "已收紧间距", &agent).unwrap();
    let done = set_status(
        &f.db,
        &f.group,
        &canvas.id,
        &thread,
        ThreadStatus::Resolved,
        &agent,
    )
    .unwrap();
    let view = &done.threads[0];
    assert_eq!(view.thread.status, ThreadStatus::Resolved);
    assert_eq!(view.thread.messages.len(), 2);
    assert_eq!(view.thread.messages[1].author, Author::Agent);
    assert_eq!(view.located.state, "board");
    // A thread the agent starts is its own; anyone can find an element by its id.
    let (own, _) = add_comment(
        &f.db,
        &f.group,
        &canvas.id,
        &AnchorInput {
            kind: AnchorKind::Element,
            board_id: Some("a".into()),
            node: None,
            mc_id: Some("headline".into()),
            x: 0.0,
            y: 0.0,
        },
        "这里我拿不准",
        &agent,
    )
    .unwrap();
    reply(&f.db, &f.group, &canvas.id, &own, "补充", &agent).unwrap();
    let removed = delete_thread(&f.db, &f.group, &canvas.id, &thread).unwrap();
    assert_eq!(removed.threads.len(), 1);
    assert_eq!(
        removed.threads[0].thread.anchor.label.as_deref(),
        Some("登录")
    );
}

#[test]
fn renaming_and_deleting_a_canvas() {
    let f = fixture();
    let canvas = with_board(&f);
    let renamed = rename(&f.db, &f.group, &canvas.id, "  新名字 ").unwrap();
    assert_eq!(renamed.title, "新名字");
    assert!(rename(&f.db, &f.group, &canvas.id, " ").is_err());
    delete(&f.db, &f.group, &canvas.id).unwrap();
    assert!(list(&f.db, &f.group).unwrap().is_empty());
    assert!(get(&f.db, &f.group, &canvas.id).is_err());
}
