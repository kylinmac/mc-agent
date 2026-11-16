use super::*;
use crate::db::canonical_project_path;

struct Fixture {
    _dir: tempfile::TempDir,
    db: Database,
    group: ProjectGroupRecord,
    resources: PathBuf,
    web: PathBuf,
}

fn fixture() -> Fixture {
    let dir = tempfile::tempdir().unwrap();
    let resources = dir.path().join("resources");
    let web = dir.path().join("web");
    for path in [&resources, &web] {
        fs::create_dir_all(path).unwrap();
    }
    fs::create_dir_all(resources.join("requirements/login")).unwrap();
    fs::create_dir_all(resources.join("reference")).unwrap();
    fs::create_dir_all(resources.join(".git")).unwrap();
    fs::write(resources.join("requirements/login/spec.md"), "v1").unwrap();
    fs::write(resources.join("reference/api.md"), "api").unwrap();
    fs::write(resources.join("notes.md"), "loose").unwrap();
    fs::write(resources.join("workspaces.md"), "# Workspaces").unwrap();
    fs::write(resources.join("AGENTS.md"), "# rules").unwrap();
    fs::write(resources.join(".DS_Store"), "x").unwrap();
    fs::write(resources.join(".git/HEAD"), "ref").unwrap();
    fs::write(web.join("README.md"), "web").unwrap();
    let canonical = |path: &Path| canonical_project_path(&path.to_string_lossy()).unwrap();
    let db = Database::open(&dir.path().join("pi.sqlite")).unwrap();
    let group = db.create_project_group("App", &[canonical(&web)]).unwrap();
    let group = db
        .attach_project_resource_root(&group.id, &canonical(&resources))
        .unwrap();
    Fixture {
        _dir: dir,
        db,
        group,
        resources: PathBuf::from(canonical(&resources)),
        web: PathBuf::from(canonical(&web)),
    }
}

fn status_of(listing: &ResourceListing, key: &str) -> ResourceStatus {
    listing
        .items
        .iter()
        .find(|item| item.key == key)
        .unwrap()
        .status
}

#[test]
fn indexed_local_file_is_listed_once_and_keeps_explicit_state() {
    let f = fixture();
    let key = resource_index::add(
        &f.resources,
        "reference",
        "API title",
        &IndexTarget::Path(f.resources.join("reference/api.md")),
    )
    .unwrap();
    set_status(&f.db, &f.group, &key, ResourceStatus::Confirmed).unwrap();
    let listing = list(&f.db, &f.group).unwrap();
    let rows: Vec<_> = listing
        .items
        .iter()
        .filter(|item| {
            item.path.as_deref() == Some(f.resources.join("reference/api.md").to_str().unwrap())
        })
        .collect();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].key, key);
    assert_eq!(rows[0].status, ResourceStatus::Confirmed);
    assert_eq!(listing.summary.total, 3);
    fs::write(f.resources.join("reference/api.md"), "changed").unwrap();
    assert_eq!(
        status_of(&list(&f.db, &f.group).unwrap(), &key),
        ResourceStatus::Changed
    );
    unregister(&f.db, &f.group, &key).unwrap();
    let listing = list(&f.db, &f.group).unwrap();
    assert_eq!(listing.summary.total, 3);
    assert!(listing
        .items
        .iter()
        .any(|item| item.key == "folder:reference/api.md"));
}

#[test]
fn local_state_wins_a_tie_and_workspace_links_are_deduplicated() {
    let f = fixture();
    let local = "folder:reference/api.md";
    let index = resource_index::add(
        &f.resources,
        "reference",
        "API",
        &IndexTarget::Path(f.resources.join("reference/api.md")),
    )
    .unwrap();
    set_status(&f.db, &f.group, local, ResourceStatus::Confirmed).unwrap();
    set_status(&f.db, &f.group, &index, ResourceStatus::Deprecated).unwrap();
    for category in ["reference", "requirements"] {
        resource_index::add(
            &f.resources,
            category,
            "README",
            &IndexTarget::Path(f.web.join("README.md")),
        )
        .unwrap();
    }
    let listing = list(&f.db, &f.group).unwrap();
    assert_eq!(listing.summary.total, 4);
    assert_eq!(status_of(&listing, local), ResourceStatus::Confirmed);
    assert!(!listing.items.iter().any(|item| item.key == index));
    assert_eq!(
        listing
            .items
            .iter()
            .filter(|item| item.title == "README")
            .count(),
        1
    );
}

#[test]
fn the_folder_is_listed_by_category_without_reserved_or_hidden_files() {
    let f = fixture();
    let listing = list(&f.db, &f.group).unwrap();
    let rows: Vec<_> = listing
        .items
        .iter()
        .map(|item| (item.category.as_str(), item.key.as_str(), item.status))
        .collect();
    assert_eq!(
        rows,
        [
            ("", "folder:notes.md", ResourceStatus::Draft),
            (
                "reference",
                "folder:reference/api.md",
                ResourceStatus::Draft
            ),
            (
                "requirements",
                "folder:requirements/login/spec.md",
                ResourceStatus::Draft
            ),
        ]
    );
    assert_eq!(listing.categories, ["reference", "requirements"]);
    assert_eq!(listing.summary.draft, 3);
}

#[test]
fn a_confirmed_file_turns_changed_when_edited_and_missing_when_deleted() {
    let f = fixture();
    let key = "folder:requirements/login/spec.md";
    set_status(&f.db, &f.group, key, ResourceStatus::Confirmed).unwrap();
    assert_eq!(
        status_of(&list(&f.db, &f.group).unwrap(), key),
        ResourceStatus::Confirmed
    );

    fs::write(f.resources.join("requirements/login/spec.md"), "v2").unwrap();
    let listing = list(&f.db, &f.group).unwrap();
    assert_eq!(status_of(&listing, key), ResourceStatus::Changed);
    assert_eq!(listing.summary.changed, 1);

    set_status(&f.db, &f.group, key, ResourceStatus::Confirmed).unwrap();
    assert_eq!(
        status_of(&list(&f.db, &f.group).unwrap(), key),
        ResourceStatus::Confirmed
    );

    set_status(&f.db, &f.group, key, ResourceStatus::Deprecated).unwrap();
    assert_eq!(
        status_of(&list(&f.db, &f.group).unwrap(), key),
        ResourceStatus::Deprecated
    );
    set_status(&f.db, &f.group, key, ResourceStatus::Draft).unwrap();
    assert_eq!(
        status_of(&list(&f.db, &f.group).unwrap(), key),
        ResourceStatus::Draft
    );
}

#[test]
fn workspace_files_and_links_are_registered_and_removed_without_touching_disk() {
    let f = fixture();
    let file_key = register_file(
        &f.db,
        &f.group,
        &f.web.join("README.md").to_string_lossy(),
        "reference",
        None,
    )
    .unwrap();
    let url_key = register_url(
        &f.db,
        &f.group,
        "https://example.com/design",
        "prototype",
        Some("设计稿"),
    )
    .unwrap();
    let listing = list(&f.db, &f.group).unwrap();
    let file = listing
        .items
        .iter()
        .find(|item| item.key == file_key)
        .unwrap();
    assert_eq!(file.source, ResourceSource::Workspace);
    assert_eq!(file.title, "README.md");
    let link = listing
        .items
        .iter()
        .find(|item| item.key == url_key)
        .unwrap();
    assert_eq!(link.url.as_deref(), Some("https://example.com/design"));
    assert_eq!(link.title, "设计稿");

    set_status(&f.db, &f.group, &url_key, ResourceStatus::Confirmed).unwrap();
    assert_eq!(
        status_of(&list(&f.db, &f.group).unwrap(), &url_key),
        ResourceStatus::Confirmed
    );

    unregister(&f.db, &f.group, &file_key).unwrap();
    assert!(f.web.join("README.md").is_file());
    assert!(list(&f.db, &f.group)
        .unwrap()
        .items
        .iter()
        .all(|item| item.key != file_key));
    assert!(unregister(&f.db, &f.group, "folder:notes.md").is_err());
}

#[test]
fn registration_is_limited_to_project_workspaces_and_valid_links() {
    let f = fixture();
    let outside = f._dir.path().join("outside.md");
    fs::write(&outside, "x").unwrap();
    assert!(register_file(&f.db, &f.group, &outside.to_string_lossy(), "", None).is_err());
    assert!(register_file(
        &f.db,
        &f.group,
        &f.resources.join("notes.md").to_string_lossy(),
        "",
        None
    )
    .is_err());
    assert!(register_url(&f.db, &f.group, "file:///etc/passwd", "", None).is_err());
    assert!(register_url(&f.db, &f.group, "javascript:alert(1)", "", None).is_err());
    register_url(&f.db, &f.group, "https://example.com", "", None).unwrap();
    assert!(register_url(&f.db, &f.group, "https://example.com", "", None).is_err());
    assert!(register_url(&f.db, &f.group, "https://example.com/x", "../escape", None).is_err());
}

#[test]
fn keys_cannot_reach_outside_the_project() {
    let f = fixture();
    for key in [
        "folder:../pi.sqlite",
        "folder:/etc/passwd",
        "folder:",
        "other:x",
        "entry:missing",
    ] {
        assert!(locate(&f.db, &f.group, key).is_err(), "{key}");
        assert!(
            set_status(&f.db, &f.group, key, ResourceStatus::Confirmed).is_err(),
            "{key}"
        );
    }
    assert_eq!(
        locate(&f.db, &f.group, "folder:reference/api.md").unwrap(),
        ResourceTarget::Path(
            f.resources
                .join("reference/api.md")
                .to_string_lossy()
                .into_owned()
        )
    );
}

#[test]
fn indexes_link_originals_and_never_reach_outside_the_project() {
    let f = fixture();
    let key = register_file(
        &f.db,
        &f.group,
        &f.web.join("README.md").to_string_lossy(),
        "reference",
        Some("Web 说明"),
    )
    .unwrap();
    let index = fs::read_to_string(f.resources.join("reference/INDEX.md")).unwrap();
    assert!(index.contains("- [Web 说明](<../../web/README.md>)"));
    assert!(
        !f.resources.join("reference/README.md").exists(),
        "nothing is copied"
    );

    fs::write(
        f.resources.join("reference/INDEX.md"),
        format!("{index}- [secret](<../../../../../etc/passwd>)\n"),
    )
    .unwrap();
    let listing = list(&f.db, &f.group).unwrap();
    let outside = listing
        .items
        .iter()
        .find(|item| item.title == "secret")
        .unwrap();
    assert_eq!(outside.status, ResourceStatus::Missing);
    assert!(outside.path.is_none());
    assert!(locate(&f.db, &f.group, &outside.key).is_err());
    assert!(listing.items.iter().all(|item| item.title != "INDEX.md"));
    assert_eq!(status_of(&listing, &key), ResourceStatus::Draft);

    set_status(&f.db, &f.group, &key, ResourceStatus::Confirmed).unwrap();
    fs::write(f.web.join("README.md"), "edited at the source").unwrap();
    assert_eq!(
        status_of(&list(&f.db, &f.group).unwrap(), &key),
        ResourceStatus::Changed
    );
}

#[test]
fn computed_statuses_cannot_be_set() {
    let f = fixture();
    assert!(set_status(&f.db, &f.group, "folder:notes.md", ResourceStatus::Changed).is_err());
    assert!(set_status(&f.db, &f.group, "folder:notes.md", ResourceStatus::Missing).is_err());
}

#[test]
fn a_creative_projects_studio_folder_is_not_listed_as_resources() {
    let f = fixture();
    let creative = f.resources.join("creative");
    fs::create_dir_all(creative.join("角色")).unwrap();
    fs::write(creative.join("角色/a.png"), "a").unwrap();
    fs::write(creative.join("kept.png"), "k").unwrap();
    let keys = |listing: &ResourceListing| -> Vec<String> {
        listing.items.iter().map(|item| item.key.clone()).collect()
    };
    // An ordinary project: its creative/ folder is plain documents.
    let before = list(&f.db, &f.group).unwrap();
    assert!(keys(&before).contains(&"folder:creative/角色/a.png".to_string()));
    assert!(before.categories.contains(&"creative".to_string()));
    set_status(
        &f.db,
        &f.group,
        "folder:creative/kept.png",
        ResourceStatus::Confirmed,
    )
    .unwrap();

    // Creative, storing in the resource folder: the studio's output is left out,
    // except what the user confirmed as a resource.
    crate::mc_creative::set_purpose(&f.db, &f.group, crate::mc_creative::Purpose::Creative)
        .unwrap();
    crate::mc_creative::set_storage(&f.db, &f.group, &f.resources.to_string_lossy()).unwrap();
    let after = list(&f.db, &f.group).unwrap();
    let listed = keys(&after);
    assert!(!listed.contains(&"folder:creative/角色/a.png".to_string()));
    assert!(listed.contains(&"folder:creative/kept.png".to_string()));
    assert!(!after.categories.contains(&"creative".to_string()));
    assert!(listed.contains(&"folder:requirements/login/spec.md".to_string()));
    // Nothing on disk changed.
    assert!(creative.join("角色/a.png").is_file());

    // Stored in a workspace instead: the resource folder is scanned as before.
    crate::mc_creative::set_storage(&f.db, &f.group, &f.web.to_string_lossy()).unwrap();
    assert!(
        keys(&list(&f.db, &f.group).unwrap()).contains(&"folder:creative/角色/a.png".to_string())
    );
}

#[test]
fn cross_category_register_file_returns_the_existing_key() {
    let f = fixture();
    let path = f.web.join("README.md");
    let first = register_file(&f.db, &f.group, &path.to_string_lossy(), "reference", None).unwrap();
    let second = register_file(
        &f.db,
        &f.group,
        &path.to_string_lossy(),
        "requirements",
        Some("Duplicate"),
    )
    .unwrap();
    assert_eq!(second, first);
    assert!(
        !f.resources.join("requirements/INDEX.md").exists(),
        "no duplicate cross-category index entry should be written"
    );
}

#[cfg(unix)]
#[test]
fn symlink_category_directory_rejects_register_file_and_url() {
    use std::os::unix::fs::symlink;

    let f = fixture();
    let outside = f._dir.path().join("outside");
    fs::create_dir_all(&outside).unwrap();
    fs::write(outside.join("INDEX.md"), "untouched").unwrap();
    symlink(&outside, f.resources.join("prototype")).unwrap();

    assert!(register_file(
        &f.db,
        &f.group,
        &f.web.join("README.md").to_string_lossy(),
        "prototype",
        None
    )
    .is_err());
    assert!(register_url(&f.db, &f.group, "https://example.com/p", "prototype", None).is_err());
    assert_eq!(
        fs::read_to_string(outside.join("INDEX.md")).unwrap(),
        "untouched"
    );
}
