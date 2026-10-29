use super::*;
use crate::{db::Database, secrets::SecretStore, sessions};
use serde_json::json;

fn copy_directory(source: &Path, destination: &Path) {
    fs::create_dir_all(destination).unwrap();
    for entry in fs::read_dir(source).unwrap() {
        let entry = entry.unwrap();
        let target = destination.join(entry.file_name());
        if entry.file_type().unwrap().is_dir() {
            copy_directory(&entry.path(), &target);
        } else {
            fs::copy(entry.path(), target).unwrap();
        }
    }
}

fn read_json(path: &Path) -> Value {
    serde_json::from_slice(&fs::read(path).unwrap()).unwrap()
}

#[test]
fn relocated_project_memory_remains_readable_through_the_repository() {
    let directory = tempfile::tempdir().unwrap();
    let temporary = directory.path();
    let source = temporary.join("old profile");
    let destination = temporary.join("new profile");
    let project = source.join("projects").join("saved project");
    fs::create_dir_all(&project).unwrap();
    let database = Database::open_in_dir(&source).unwrap();
    database
        .set_project_memory(&project.to_string_lossy(), "Keep project memory")
        .unwrap();
    drop(database);
    copy_directory(&source, &destination);
    // A picker can return different case from the canonical spelling stored by
    // project repositories. Windows canonicalize also adds a verbatim prefix.
    #[cfg(windows)]
    let source = temporary.join("OLD PROFILE");
    relocate(&source, &destination).unwrap();
    let moved_project = destination.join("projects").join("saved project");
    let database = Database::open_in_dir(&destination).unwrap();
    assert_eq!(
        database
            .get_project_memory(&moved_project.to_string_lossy())
            .unwrap()
            .content,
        "Keep project memory"
    );
    let stored: String = database
        .conn()
        .query_row("SELECT path FROM projects", [], |row| row.get(0))
        .unwrap();
    assert_eq!(
        stored,
        crate::db::canonical_project_path(&moved_project.to_string_lossy()).unwrap()
    );
}

#[cfg(unix)]
#[test]
fn relocated_project_keys_use_the_destination_canonical_spelling() {
    let temporary = tempfile::tempdir().unwrap();
    let source = temporary.path().join("source");
    let real_parent = temporary.path().join("real-parent");
    let alias_parent = temporary.path().join("alias-parent");
    fs::create_dir_all(&real_parent).unwrap();
    std::os::unix::fs::symlink(&real_parent, &alias_parent).unwrap();
    let destination = alias_parent.join("destination");
    let project = source.join("project");
    fs::create_dir_all(&project).unwrap();
    let database = Database::open_in_dir(&source).unwrap();
    let group = database
        .create_project_group("Relocated", &[project.to_string_lossy().into_owned()])
        .unwrap();
    database
        .set_project_memory(&project.to_string_lossy(), "Keep this memory")
        .unwrap();
    let source_key = crate::db::canonical_project_path(&project.to_string_lossy()).unwrap();
    database
        .kv_set(
            "projectInstructions",
            &source_key,
            &json!({"content": "Keep these instructions"}),
        )
        .unwrap();
    drop(database);
    copy_directory(&source, &destination);
    relocate(&source, &destination).unwrap();
    let moved_project = destination.join("project");
    let key = crate::db::canonical_project_path(&moved_project.to_string_lossy()).unwrap();
    let database = Database::open_in_dir(&destination).unwrap();
    assert_eq!(
        database
            .project_group_for_path(&moved_project.to_string_lossy())
            .unwrap()
            .map(|group| group.id),
        Some(group.id)
    );
    assert_eq!(
        database
            .get_project_memory(&moved_project.to_string_lossy())
            .unwrap()
            .content,
        "Keep this memory"
    );
    assert_eq!(
        database.kv_get("projectInstructions", &key).unwrap(),
        Some(json!({"content": "Keep these instructions"}))
    );
    let paths: Vec<String> = database
        .conn()
        .prepare("SELECT path FROM projects")
        .unwrap()
        .query_map([], |row| row.get(0))
        .unwrap()
        .collect::<rusqlite::Result<_>>()
        .unwrap();
    assert_eq!(paths, vec![key]);
    let original = Database::open_in_dir(&source).unwrap();
    assert_eq!(
        original
            .get_project_memory(&project.to_string_lossy())
            .unwrap()
            .content,
        "Keep this memory"
    );
}

#[test]
fn relocated_creative_storage_and_generated_assets_follow_the_copied_files() {
    use crate::mc_creative as creative;
    let temporary = tempfile::tempdir().unwrap();
    let source = temporary.path().join("source");
    let destination = temporary.path().join("destination");
    let project = source.join("project");
    fs::create_dir_all(&project).unwrap();
    let database = Database::open_in_dir(&source).unwrap();
    let group = creative::create_project(&database, "Studio", &project).unwrap();
    let job = creative::create_job(
        &database,
        &group,
        creative::JobInput {
            entry: "form".into(),
            session_id: None,
            provider_id: None,
            model_id: None,
            snapshot: json!({"prompt":"Keep original prompt"}),
            count: 1,
        },
    )
    .unwrap();
    let output = creative::output_dir(&database, &group, "")
        .unwrap()
        .join("result.png");
    fs::write(&output, b"image bytes").unwrap();
    let job = creative::record_result(
        &database,
        &group,
        &job.id,
        0,
        Some(&output),
        &creative::FileFacts::default(),
        None,
    )
    .unwrap();
    let asset_id = job.results[0].asset_id.as_ref().unwrap();
    let script = project.join("draw.py");
    fs::write(&script, b"print('drawing')").unwrap();
    let drawing = project.join("drawing.png");
    fs::write(&drawing, b"drawing bytes").unwrap();
    let code_job = creative::register_code_drawing(
        &database,
        &group,
        &drawing,
        Some(&script),
        "python draw.py",
        None,
        &creative::FileFacts::default(),
        "",
    )
    .unwrap();
    drop(database);
    copy_directory(&source, &destination);
    relocate(&source, &destination).unwrap();
    let database = Database::open_in_dir(&destination).unwrap();
    let group = database.project_group(&group.id).unwrap().unwrap();
    let storage = creative::storage(&database, &group).unwrap();
    assert_eq!(
        storage.folder,
        destination.join("project").canonicalize().unwrap()
    );
    let asset = creative::get_asset(&database, asset_id).unwrap().unwrap();
    assert!(asset.file_exists);
    assert!(Path::new(&asset.path).starts_with(&destination));
    assert_eq!(fs::read(&asset.path).unwrap(), b"image bytes");
    let restored_job = creative::get_job(&database, &job.id).unwrap().unwrap();
    assert_eq!(
        restored_job.results[0].path.as_deref(),
        Some(asset.path.as_str())
    );
    assert_eq!(restored_job.snapshot, job.snapshot);
    let code = creative::get_job(&database, &code_job.id).unwrap().unwrap();
    let kept = Path::new(code.snapshot["script"]["kept"].as_str().unwrap());
    assert!(kept.starts_with(&destination));
    assert_eq!(fs::read(kept).unwrap(), b"print('drawing')");
    assert_eq!(
        code.snapshot["script"]["source"],
        code_job.snapshot["script"]["source"]
    );
    assert_eq!(code.snapshot["command"], code_job.snapshot["command"]);
    let original = Database::open_in_dir(&source).unwrap();
    assert_eq!(
        creative::get_asset(&original, asset_id)
            .unwrap()
            .unwrap()
            .path,
        output.to_string_lossy()
    );
}

#[test]
fn relocates_a_real_copied_profile_without_recovery_or_changing_user_content() {
    let temporary = tempfile::tempdir().unwrap();
    let source = temporary.path().join("old");
    let destination = temporary.path().join("new");
    let attachment = source.join("scratch/chat/pasted/input.txt");
    fs::create_dir_all(attachment.parent().unwrap()).unwrap();
    fs::write(&attachment, "user file bytes").unwrap();
    let project = source.join("project");
    fs::create_dir_all(&project).unwrap();
    let external = temporary.path().join("external-project");
    fs::create_dir_all(&external).unwrap();
    let database = Database::open_in_dir(&source).unwrap();
    let session =
        sessions::create_session(&database, Some("Saved chat".into()), None, None, None, None)
            .unwrap();
    database.conn().execute("INSERT INTO projects(path,name,created_at,last_opened_at) VALUES(?1,'inside',0,0), (?2,'outside',0,0)", params![project.to_string_lossy(), external.to_string_lossy()]).unwrap();
    database
        .conn()
        .execute(
            "INSERT INTO turns(id,session_id,status,started_at) VALUES ('live',?1,'running',0)",
            params![session.id],
        )
        .unwrap();
    database
        .conn()
        .execute(
            "INSERT INTO artifacts(session_id,path,op,updated_at) VALUES (?1,?2,'write',0)",
            params![session.id, attachment.to_string_lossy()],
        )
        .unwrap();
    database.conn().execute("INSERT INTO turn_queue(id,session_id,principal,input_hash,content,attachments_json,permission_mode,position,created_at) VALUES ('queued',?1,'user','hash',?2,?3,'ask',0,0)", params![session.id, attachment.to_string_lossy(), json!([{"ref":attachment}]).to_string()]).unwrap();
    database.conn().execute("INSERT INTO kv(ns,key,value_json,updated_at) VALUES ('projectMemory',?1,?2,0),('projectGroups','group',?3,0)", params![project.to_string_lossy(), json!({"content":attachment.to_string_lossy()}).to_string(), json!({"primaryPath":project,"roots":[{"path":project}],"detachedPaths":[source.join("removed")]}).to_string()]).unwrap();
    drop(database);
    let secrets = SecretStore::open(&source).unwrap();
    secrets.set("secret:test", "fixture-credential").unwrap();
    drop(secrets);
    let line = json!({"type":"message","id":"m1","blocks":[
        {"type":"text","text":attachment},
        {"type":"attachment","ref":attachment},
        {"type":"tool_call","args":{"path":attachment,"command":attachment,"content":attachment},"result":{"scratchReportPath":attachment,"text":attachment}}
    ]}).to_string();
    let compaction = json!({"type":"compaction","summary":attachment,"retainedTail":[{"blocks":[{"type":"attachment","ref":attachment}]}]}).to_string();
    let transcript = source.join("sessions/chat.jsonl");
    fs::create_dir_all(source.join("sessions")).unwrap();
    fs::create_dir_all(source.join("plugins")).unwrap();
    fs::write(&transcript, format!("{line}\n{compaction}\n{{\"type\":")).unwrap();
    fs::write(
        source.join("sessions/chat.revisions.jsonl"),
        format!(
            "{}\n",
            json!({"type":"revision","messages":[serde_json::from_str::<Value>(&line).unwrap()]})
        ),
    )
    .unwrap();
    fs::write(
        source.join("sessions/chat.inflight.json"),
        json!({"message":{"blocks":[{"ref":attachment}]}}).to_string(),
    )
    .unwrap();
    fs::write(
        source.join("session-message-outbox.json"),
        json!([{"message":{"attachments":[{"ref":attachment}],"content":attachment}}]).to_string(),
    )
    .unwrap();
    fs::write(
        source.join("plugins/registry.json"),
        json!([
            {"source":"installed","path":source.join("plugins/installed/example")},
            {"source":"dev","path":source.join("dev-source")},
            {"source":"builtin","path":external},
            {"source":"marketplace","path":format!("{}-other/plugins", source.display())}
        ])
        .to_string(),
    )
    .unwrap();
    copy_directory(&source, &destination);
    let original = fs::read(&transcript).unwrap();
    let key_before = fs::read(source.join("secrets/.machine-key")).unwrap();
    relocate(&source, &destination).unwrap();
    let moved_attachment = destination.join("scratch/chat/pasted/input.txt");
    let new_transcript = fs::read_to_string(destination.join("sessions/chat.jsonl")).unwrap();
    let lines: Vec<_> = new_transcript.lines().collect();
    let message: Value = serde_json::from_str(lines[0]).unwrap();
    assert_eq!(message["blocks"][1]["ref"], json!(moved_attachment));
    assert_eq!(message["blocks"][0]["text"], json!(attachment));
    assert_eq!(
        message["blocks"][2]["args"]["path"],
        json!(moved_attachment)
    );
    assert_eq!(message["blocks"][2]["args"]["command"], json!(attachment));
    assert_eq!(message["blocks"][2]["args"]["content"], json!(attachment));
    assert_eq!(
        message["blocks"][2]["result"]["scratchReportPath"],
        json!(moved_attachment)
    );
    let compacted: Value = serde_json::from_str(lines[1]).unwrap();
    assert_eq!(compacted["summary"], json!(attachment));
    assert_eq!(
        compacted["retainedTail"][0]["blocks"][0]["ref"],
        json!(moved_attachment)
    );
    assert_eq!(lines[2], "{\"type\":");
    let revision: Value = serde_json::from_str(
        fs::read_to_string(destination.join("sessions/chat.revisions.jsonl"))
            .unwrap()
            .trim(),
    )
    .unwrap();
    assert_eq!(
        revision["messages"][0]["blocks"][1]["ref"],
        json!(moved_attachment)
    );
    assert_eq!(
        read_json(&destination.join("sessions/chat.inflight.json"))["message"]["blocks"][0]["ref"],
        json!(moved_attachment)
    );
    assert_eq!(
        read_json(&destination.join("session-message-outbox.json"))[0]["message"]["attachments"][0]
            ["ref"],
        json!(moved_attachment)
    );
    let plugins = read_json(&destination.join("plugins/registry.json"));
    assert_eq!(
        plugins[0]["path"],
        json!(destination.join("plugins/installed/example"))
    );
    assert_eq!(plugins[1]["path"], json!(source.join("dev-source")));
    assert_eq!(plugins[2]["path"], json!(external));
    assert_eq!(
        plugins[3]["path"],
        json!(format!("{}-other/plugins", source.display()))
    );
    let connection = Connection::open(destination.join("pi.sqlite")).unwrap();
    let inside: String = connection
        .query_row("SELECT path FROM projects WHERE name='inside'", [], |row| {
            row.get(0)
        })
        .unwrap();
    assert_eq!(
        inside,
        crate::db::canonical_project_path(&destination.join("project").to_string_lossy()).unwrap()
    );
    let outside: String = connection
        .query_row(
            "SELECT path FROM projects WHERE name='outside'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(outside, external.to_string_lossy());
    let status: String = connection
        .query_row("SELECT status FROM turns WHERE id='live'", [], |row| {
            row.get(0)
        })
        .unwrap();
    assert_eq!(
        status, "running",
        "offline relocation must not execute startup recovery"
    );
    let queued: String = connection
        .query_row("SELECT attachments_json FROM turn_queue", [], |row| {
            row.get(0)
        })
        .unwrap();
    assert_eq!(
        serde_json::from_str::<Value>(&queued).unwrap()[0]["ref"],
        json!(moved_attachment)
    );
    let memory_key: String = connection
        .query_row("SELECT key FROM kv WHERE ns='projectMemory'", [], |row| {
            row.get(0)
        })
        .unwrap();
    assert_eq!(
        memory_key,
        crate::db::canonical_project_path(&destination.join("project").to_string_lossy()).unwrap()
    );
    let group: String = connection
        .query_row(
            "SELECT value_json FROM kv WHERE ns='projectGroups'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(
        serde_json::from_str::<Value>(&group).unwrap()["roots"][0]["path"],
        json!(
            crate::db::canonical_project_path(&destination.join("project").to_string_lossy())
                .unwrap()
        )
    );
    assert_eq!(
        SecretStore::open(&destination)
            .unwrap()
            .get("secret:test")
            .unwrap()
            .as_deref(),
        Some("fixture-credential")
    );
    assert_eq!(
        fs::read(destination.join("secrets/.machine-key")).unwrap(),
        key_before
    );
    assert_eq!(fs::read(&transcript).unwrap(), original);
    assert_eq!(fs::read(moved_attachment).unwrap(), b"user file bytes");
    drop(connection);
    // A retry is harmless even when the previous relocation finished fully.
    relocate(&source, &destination).unwrap();
}

#[test]
fn exact_path_boundaries_preserve_prose_prefix_neighbors_and_traversal() {
    let temporary = tempfile::tempdir().unwrap();
    let roots = Roots {
        source: temporary.path().join("old"),
        canonical_source: temporary.path().join("old"),
        project_source: temporary.path().join("old"),
        destination: temporary.path().join("new"),
    };
    let inside = roots.source.join("nested/file");
    let neighbor = format!("{}-other/file", roots.source.display());
    let traversal = roots.source.join("../external/file");
    let prose = format!("cat {}", inside.display());
    let mut value = json!({"path":inside, "ref":neighbor, "args":{"command":prose, "path":traversal}, "text":inside, "userCode":{"content":{"path":inside}}});
    assert!(roots.structured(&mut value));
    assert_eq!(value["path"], json!(roots.destination.join("nested/file")));
    assert_eq!(value["ref"], json!(neighbor));
    assert_eq!(value["args"]["path"], json!(traversal));
    assert_eq!(value["userCode"]["content"]["path"], json!(inside));
    assert_eq!(value["text"], json!(inside));
}

#[test]
fn refuses_overlapping_roots_and_malformed_complete_records() {
    let temporary = tempfile::tempdir().unwrap();
    let source = temporary.path().join("old");
    let destination = temporary.path().join("new");
    fs::create_dir_all(source.join("nested")).unwrap();
    assert!(relocate(&source, &source.join("nested")).is_err());
    fs::create_dir_all(destination.join("sessions")).unwrap();
    fs::write(destination.join("sessions/chat.jsonl"), b"not json\n").unwrap();
    assert!(relocate(&source, &destination).is_err());
    assert_eq!(
        fs::read(destination.join("sessions/chat.jsonl")).unwrap(),
        b"not json\n"
    );
}

#[cfg(unix)]
#[test]
fn refuses_symlinked_host_metadata_without_touching_external_files() {
    use std::os::unix::fs::symlink;
    let temporary = tempfile::tempdir().unwrap();
    let source = temporary.path().join("old");
    let destination = temporary.path().join("new");
    fs::create_dir_all(&source).unwrap();
    fs::create_dir_all(&destination).unwrap();
    let external = temporary.path().join("external");
    fs::write(&external, "private fixture").unwrap();
    symlink(&external, destination.join("pi.sqlite")).unwrap();
    assert!(relocate(&source, &destination).is_err());
    assert_eq!(fs::read(external).unwrap(), b"private fixture");
}

#[test]
fn handles_legacy_schema_without_upgrading_or_creating_missing_tables() {
    let temporary = tempfile::tempdir().unwrap();
    let source = temporary.path().join("old");
    let destination = temporary.path().join("new");
    fs::create_dir_all(&source).unwrap();
    fs::create_dir_all(&destination).unwrap();
    let database = Connection::open(destination.join("pi.sqlite")).unwrap();
    database.execute_batch("PRAGMA user_version=6; CREATE TABLE projects(id INTEGER PRIMARY KEY,path TEXT UNIQUE);").unwrap();
    database
        .execute(
            "INSERT INTO projects(path) VALUES (?1)",
            params![source.join("project").to_string_lossy()],
        )
        .unwrap();
    drop(database);
    relocate(&source, &destination).unwrap();
    let database = Connection::open(destination.join("pi.sqlite")).unwrap();
    let version: i64 = database
        .query_row("PRAGMA user_version", [], |row| row.get(0))
        .unwrap();
    assert_eq!(version, 6);
    let path: String = database
        .query_row("SELECT path FROM projects", [], |row| row.get(0))
        .unwrap();
    assert_eq!(path, destination.join("project").to_string_lossy());
    let tables: i64 = database
        .query_row(
            "SELECT count(*) FROM sqlite_master WHERE type='table'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(tables, 1);
    assert!(!destination.join("sessions").exists());
    assert!(!destination.join("secrets").exists());
}

#[test]
fn project_capability_overrides_follow_the_moved_project_without_changing_globals() {
    use crate::agent_capabilities::{CapabilityLevel, CapabilityState};
    let temporary = tempfile::tempdir().unwrap();
    let source = temporary.path().join("old");
    let destination = temporary.path().join("new");
    fs::create_dir_all(&source).unwrap();
    let project = source.join("project").to_string_lossy().into_owned();
    let mut original = CapabilityState::new(&source, "skills");
    original
        .set_enabled(
            "skills",
            CapabilityLevel::Project,
            "analysis",
            Some(&project),
            false,
        )
        .unwrap();
    original
        .set_enabled(
            "skills",
            CapabilityLevel::Global,
            "global-analysis",
            None,
            false,
        )
        .unwrap();
    copy_directory(&source, &destination);
    relocate(&source, &destination).unwrap();
    let moved_project = destination.join("project").to_string_lossy().into_owned();
    let restored = CapabilityState::new(&destination, "skills");
    assert!(!restored.enabled(
        "skills",
        CapabilityLevel::Project,
        "analysis",
        Some(&moved_project)
    ));
    assert!(!restored.enabled("skills", CapabilityLevel::Global, "global-analysis", None));
    assert!(restored.enabled(
        "skills",
        CapabilityLevel::Project,
        "analysis",
        Some(&project)
    ));
    assert!(!original.enabled(
        "skills",
        CapabilityLevel::Project,
        "analysis",
        Some(&project)
    ));
}

#[test]
fn refuses_colliding_project_capability_keys_without_losing_an_override() {
    use crate::agent_capabilities::{CapabilityLevel, CapabilityState};
    let temporary = tempfile::tempdir().unwrap();
    let source = temporary.path().join("old");
    let destination = temporary.path().join("new");
    fs::create_dir_all(&source).unwrap();
    let mut original = CapabilityState::new(&source, "skills");
    for project in [source.join("project"), destination.join("project")] {
        original
            .set_enabled(
                "skills",
                CapabilityLevel::Project,
                "analysis",
                Some(&project.to_string_lossy()),
                false,
            )
            .unwrap();
    }
    copy_directory(&source, &destination);
    let file = destination.join("agent-capabilities/skills.json");
    let before = fs::read(&file).unwrap();
    assert!(relocate(&source, &destination).is_err());
    assert_eq!(fs::read(file).unwrap(), before);
}
