//! Assets and categories: the images the studio knows and the folders they
//! are filed in.

use super::*;

// ---- assets -----------------------------------------------------------------

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AssetFilter {
    #[serde(default)]
    pub origin: Option<Origin>,
    #[serde(default)]
    pub favorite: bool,
    #[serde(default)]
    pub include_removed: bool,
    #[serde(default)]
    pub query: Option<String>,
}

pub fn list_assets(
    db: &Database,
    group: &ProjectGroupRecord,
    filter: &AssetFilter,
) -> Result<Vec<Asset>> {
    ensure_schema(db)?;
    let mut stmt = db.conn().prepare(&format!(
        "SELECT {ASSET_COLUMNS} FROM mc_creative_assets WHERE group_id = ?1 ORDER BY created_at DESC, result_index ASC"
    ))?;
    let needle = filter
        .query
        .as_deref()
        .map(str::to_lowercase)
        .filter(|q| !q.trim().is_empty());
    let rows = stmt.query_map(params![group.id], asset_from_row)?;
    let mut assets = Vec::new();
    for row in rows {
        let asset = row?;
        if asset.removed_at.is_some() && !filter.include_removed {
            continue;
        }
        if filter.origin.is_some_and(|origin| origin != asset.origin)
            || (filter.favorite && !asset.favorite)
        {
            continue;
        }
        if let Some(needle) = &needle {
            let prompt = asset
                .job_id
                .as_deref()
                .and_then(|job| get_job(db, job).ok().flatten())
                .and_then(|job| {
                    job.snapshot
                        .get("prompt")
                        .and_then(Value::as_str)
                        .map(str::to_lowercase)
                })
                .unwrap_or_default();
            if !asset.title.to_lowercase().contains(needle) && !prompt.contains(needle) {
                continue;
            }
        }
        assets.push(asset);
    }
    Ok(assets)
}

/// Copy a reference into the project (deduplicated by content) and register
/// it. Later changes to the original never reach the project.
pub fn import_reference(
    db: &Database,
    group: &ProjectGroupRecord,
    source: &Path,
    facts: &FileFacts,
    category: &str,
) -> Result<Asset> {
    ensure_schema(db)?;
    let store = storage(db, group)?;
    let category = normalize_category(category)?;
    if !source.is_file() {
        return Err(anyhow!("INVALID_ARGUMENT: the file does not exist"));
    }
    let (sha, _) = sha256_file(source)?;
    let existing: Option<String> = db
        .conn()
        .query_row(
            "SELECT id FROM mc_creative_assets WHERE group_id = ?1 AND sha256 = ?2 AND origin = 'reference' ORDER BY created_at LIMIT 1",
            params![group.id, sha],
            |row| row.get(0),
        )
        .optional()?;
    if let Some(id) = existing {
        let asset = group_asset(db, group, &id)?;
        if asset.file_exists {
            db.conn().execute(
                "UPDATE mc_creative_assets SET removed_at = NULL WHERE id = ?1",
                params![id],
            )?;
            return group_asset(db, group, &id);
        }
    }
    let dir = store.category_dir(&category);
    fs::create_dir_all(&dir)?;
    let name = source
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default();
    let target = dir.join(format!("{}-{}", &sha[..8], safe_file_name(&name)));
    if !target.exists() {
        fs::copy(source, &target).with_context(|| format!("copy {}", source.display()))?;
    }
    let title = Path::new(&name)
        .file_stem()
        .map(|stem| stem.to_string_lossy().into_owned())
        .unwrap_or_default();
    insert_asset(
        db,
        &group.id,
        Origin::Reference,
        &target,
        facts,
        &title,
        None,
        &category,
    )
}

/// Register an image already inside the project folder (an imported file).
pub fn import_existing(
    db: &Database,
    group: &ProjectGroupRecord,
    path: &Path,
    facts: &FileFacts,
) -> Result<Asset> {
    ensure_schema(db)?;
    if !in_project(group, path) || !path.is_file() {
        return Err(anyhow!(
            "INVALID_ARGUMENT: the file is not inside the project folder"
        ));
    }
    let title = path
        .file_stem()
        .map(|stem| stem.to_string_lossy().into_owned())
        .unwrap_or_default();
    insert_asset(db, &group.id, Origin::Import, path, facts, &title, None, "")
}

pub fn set_favorite(
    db: &Database,
    group: &ProjectGroupRecord,
    id: &str,
    favorite: bool,
) -> Result<Asset> {
    group_asset(db, group, id)?;
    db.conn().execute(
        "UPDATE mc_creative_assets SET favorite = ?2 WHERE id = ?1",
        params![id, favorite as i64],
    )?;
    group_asset(db, group, id)
}

pub fn set_title(
    db: &Database,
    group: &ProjectGroupRecord,
    id: &str,
    title: &str,
) -> Result<Asset> {
    group_asset(db, group, id)?;
    let title: String = title.trim().chars().take(200).collect();
    db.conn().execute(
        "UPDATE mc_creative_assets SET title = ?2 WHERE id = ?1",
        params![id, title],
    )?;
    group_asset(db, group, id)
}

/// Take the asset out of the library; the file stays on disk.
pub fn remove_asset(db: &Database, group: &ProjectGroupRecord, id: &str) -> Result<Asset> {
    group_asset(db, group, id)?;
    db.conn().execute(
        "UPDATE mc_creative_assets SET removed_at = ?2 WHERE id = ?1 AND removed_at IS NULL",
        params![id, now_ms()],
    )?;
    group_asset(db, group, id)
}

pub fn restore_asset(db: &Database, group: &ProjectGroupRecord, id: &str) -> Result<Asset> {
    group_asset(db, group, id)?;
    db.conn().execute(
        "UPDATE mc_creative_assets SET removed_at = NULL WHERE id = ?1",
        params![id],
    )?;
    group_asset(db, group, id)
}

/// Delete the file itself (only inside the project folder) and remove the
/// asset from the library. The record stays, so snapshots that used it still
/// name it.
pub fn delete_asset_file(db: &Database, group: &ProjectGroupRecord, id: &str) -> Result<Asset> {
    let asset = group_asset(db, group, id)?;
    let path = Path::new(&asset.path);
    if path.exists() {
        if !in_project(group, path) {
            return Err(anyhow!(
                "PERMISSION_DENIED: the file is outside the project folder"
            ));
        }
        fs::remove_file(path).with_context(|| format!("delete {}", path.display()))?;
    }
    remove_asset(db, group, id)
}

/// The assets a result used, and the results that used an asset.
pub fn asset_links(db: &Database, group: &ProjectGroupRecord, id: &str) -> Result<Value> {
    group_asset(db, group, id)?;
    let uses = |sql: &str| -> Result<Vec<Value>> {
        let mut stmt = db.conn().prepare(sql)?;
        let rows = stmt.query_map(params![id], |row| {
            Ok(json!({ "assetId": row.get::<_, String>(0)?, "position": row.get::<_, i64>(1)?, "role": row.get::<_, String>(2)? }))
        })?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    };
    Ok(json!({
        "uses": uses("SELECT ref_asset_id, position, role FROM mc_creative_asset_refs WHERE asset_id = ?1 ORDER BY position")?,
        "usedBy": uses("SELECT asset_id, position, role FROM mc_creative_asset_refs WHERE ref_asset_id = ?1 ORDER BY asset_id")?,
    }))
}

// ---- categories -------------------------------------------------------------

/// Record a category (and its parents) so it shows even while empty.
pub(super) fn remember_category(db: &Database, group_id: &str, category: &str) -> Result<()> {
    let segments: Vec<&str> = category.split('/').collect();
    for depth in 1..=segments.len() {
        db.conn().execute(
            "INSERT OR IGNORE INTO mc_creative_categories (group_id, path, created_at) VALUES (?1, ?2, ?3)",
            params![group_id, segments[..depth].join("/"), now_ms()],
        )?;
    }
    Ok(())
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CategoryInfo {
    pub path: String,
    /// Assets directly in this category (not its children).
    pub count: i64,
}

/// Every category of the project, sorted by path, with its own asset count.
pub fn list_categories(db: &Database, group: &ProjectGroupRecord) -> Result<Vec<CategoryInfo>> {
    ensure_schema(db)?;
    let mut stmt = db.conn().prepare(
        "SELECT path FROM mc_creative_categories WHERE group_id = ?1
         UNION SELECT category FROM mc_creative_assets WHERE group_id = ?1 AND category != '' AND removed_at IS NULL",
    )?;
    let mut paths: Vec<String> = stmt
        .query_map(params![group.id], |row| row.get(0))?
        .collect::<rusqlite::Result<_>>()?;
    paths.sort();
    paths.dedup();
    let mut out = Vec::with_capacity(paths.len());
    for path in paths {
        let count: i64 = db.conn().query_row(
            "SELECT COUNT(*) FROM mc_creative_assets WHERE group_id = ?1 AND category = ?2 AND removed_at IS NULL",
            params![group.id, path],
            |row| row.get(0),
        )?;
        out.push(CategoryInfo { path, count });
    }
    Ok(out)
}

pub fn create_category(db: &Database, group: &ProjectGroupRecord, raw: &str) -> Result<String> {
    ensure_schema(db)?;
    let category = normalize_category(raw)?;
    if category.is_empty() {
        return Err(anyhow!("INVALID_ARGUMENT: a category needs a name"));
    }
    fs::create_dir_all(storage(db, group)?.category_dir(&category))?;
    remember_category(db, group.id.as_str(), &category)?;
    Ok(category)
}

/// A free file name in `dir` for `name` (adds -2, -3, … when taken).
fn free_target(dir: &Path, name: &str) -> PathBuf {
    let candidate = dir.join(name);
    if !candidate.exists() {
        return candidate;
    }
    let path = Path::new(name);
    let stem = path
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_default();
    let ext = path
        .extension()
        .map(|e| format!(".{}", e.to_string_lossy()))
        .unwrap_or_default();
    (2..)
        .map(|n| dir.join(format!("{stem}-{n}{ext}")))
        .find(|p| !p.exists())
        .unwrap()
}

fn move_file(from: &Path, to: &Path) -> Result<()> {
    if fs::rename(from, to).is_err() {
        fs::copy(from, to)?;
        fs::remove_file(from)?;
    }
    Ok(())
}

/// Move assets into a category: the files move into its folder (a file that
/// is outside the project, or already gone, only changes category).
pub fn move_assets(
    db: &Database,
    group: &ProjectGroupRecord,
    ids: &[String],
    raw: &str,
) -> Result<Vec<Asset>> {
    ensure_schema(db)?;
    let category = normalize_category(raw)?;
    let dir = storage(db, group)?.category_dir(&category);
    fs::create_dir_all(&dir)?;
    if !category.is_empty() {
        remember_category(db, group.id.as_str(), &category)?;
    }
    let mut moved = Vec::new();
    for id in ids {
        let asset = group_asset(db, group, id)?;
        let from = PathBuf::from(&asset.path);
        let mut path = asset.path.clone();
        if from.is_file() && in_project(group, &from) && from.parent() != Some(dir.as_path()) {
            let name = from
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_default();
            let target = free_target(&dir, &name);
            move_file(&from, &target)?;
            path = target.to_string_lossy().into_owned();
        }
        db.conn().execute(
            "UPDATE mc_creative_assets SET category = ?2, path = ?3 WHERE id = ?1",
            params![id, category, path],
        )?;
        db.conn().execute(
            "UPDATE mc_creative_job_results SET path = ?2 WHERE asset_id = ?1",
            params![id, path],
        )?;
        moved.push(group_asset(db, group, id)?);
    }
    Ok(moved)
}

fn replace_prefix(value: &str, from: &str, to: &str) -> Option<String> {
    if value == from {
        Some(to.to_string())
    } else {
        value
            .strip_prefix(&format!("{from}/"))
            .map(|rest| format!("{to}/{rest}"))
    }
}

/// Rename (or move) a category and everything under it, folder included.
pub fn rename_category(
    db: &Database,
    group: &ProjectGroupRecord,
    from_raw: &str,
    to_raw: &str,
) -> Result<String> {
    ensure_schema(db)?;
    let from = normalize_category(from_raw)?;
    let to = normalize_category(to_raw)?;
    if from.is_empty() || to.is_empty() {
        return Err(anyhow!("INVALID_ARGUMENT: a category needs a name"));
    }
    if to == from {
        return Ok(to);
    }
    if to.starts_with(&format!("{from}/")) {
        return Err(anyhow!(
            "INVALID_ARGUMENT: a category cannot move into itself"
        ));
    }
    let store = storage(db, group)?;
    let (old_dir, new_dir) = (store.category_dir(&from), store.category_dir(&to));
    if new_dir.exists() {
        return Err(anyhow!(
            "CONFLICT: a category with that name already exists"
        ));
    }
    if old_dir.exists() {
        if let Some(parent) = new_dir.parent() {
            fs::create_dir_all(parent)?;
        }
        fs::rename(&old_dir, &new_dir).context("rename the category folder")?;
    } else {
        fs::create_dir_all(&new_dir)?;
    }
    let old_prefix = old_dir.to_string_lossy().into_owned();
    let new_prefix = new_dir.to_string_lossy().into_owned();
    let tx = db.conn().unchecked_transaction()?;
    let rows: Vec<(String, String, String)> = tx
        .prepare("SELECT id, category, path FROM mc_creative_assets WHERE group_id = ?1")?
        .query_map(params![group.id], |row| {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?))
        })?
        .collect::<rusqlite::Result<_>>()?;
    for (id, category, path) in rows {
        let Some(next) = replace_prefix(&category, &from, &to) else {
            continue;
        };
        let next_path = replace_prefix(&path, &old_prefix, &new_prefix).unwrap_or(path);
        tx.execute(
            "UPDATE mc_creative_assets SET category = ?2, path = ?3 WHERE id = ?1",
            params![id, next, next_path],
        )?;
        tx.execute(
            "UPDATE mc_creative_job_results SET path = ?2 WHERE asset_id = ?1",
            params![id, next_path],
        )?;
    }
    let categories: Vec<String> = tx
        .prepare("SELECT path FROM mc_creative_categories WHERE group_id = ?1")?
        .query_map(params![group.id], |row| row.get(0))?
        .collect::<rusqlite::Result<_>>()?;
    for path in categories {
        if let Some(next) = replace_prefix(&path, &from, &to) {
            tx.execute(
                "DELETE FROM mc_creative_categories WHERE group_id = ?1 AND path = ?2",
                params![group.id, path],
            )?;
            tx.execute(
                "INSERT OR IGNORE INTO mc_creative_categories (group_id, path, created_at) VALUES (?1, ?2, ?3)",
                params![group.id, next, now_ms()],
            )?;
        }
    }
    tx.commit()?;
    remember_category(db, group.id.as_str(), &to)?;
    Ok(to)
}

/// Delete a category: its images (and those of its children) move up to the
/// parent category, or to uncategorized; the emptied folders are removed.
pub fn delete_category(db: &Database, group: &ProjectGroupRecord, raw: &str) -> Result<()> {
    ensure_schema(db)?;
    let category = normalize_category(raw)?;
    if category.is_empty() {
        return Err(anyhow!("INVALID_ARGUMENT: uncategorized cannot be deleted"));
    }
    let parent = category
        .rsplit_once('/')
        .map(|(parent, _)| parent.to_string())
        .unwrap_or_default();
    let ids: Vec<String> = db
        .conn()
        .prepare("SELECT id, category FROM mc_creative_assets WHERE group_id = ?1")?
        .query_map(params![group.id], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?
        .into_iter()
        .filter(|(_, c)| replace_prefix(c, &category, "x").is_some())
        .map(|(id, _)| id)
        .collect();
    move_assets(db, group, &ids, &parent)?;
    let paths: Vec<String> = db
        .conn()
        .prepare("SELECT path FROM mc_creative_categories WHERE group_id = ?1")?
        .query_map(params![group.id], |row| row.get(0))?
        .collect::<rusqlite::Result<_>>()?;
    for path in paths {
        if replace_prefix(&path, &category, "x").is_some() {
            db.conn().execute(
                "DELETE FROM mc_creative_categories WHERE group_id = ?1 AND path = ?2",
                params![group.id, path],
            )?;
        }
    }
    // Only folders left empty are removed; anything else in them stays.
    let dir = storage(db, group)?.category_dir(&category);
    remove_empty_dirs(&dir);
    Ok(())
}

fn remove_empty_dirs(dir: &Path) {
    if let Ok(entries) = fs::read_dir(dir) {
        for entry in entries.flatten() {
            if entry.path().is_dir() {
                remove_empty_dirs(&entry.path());
            }
        }
    }
    let _ = fs::remove_dir(dir);
}

// ---- creative templates ------------------------------------------------------

/// A creative template by name, refused when missing or meant for resource
/// folders. Checked before a project or folder is touched.
pub fn creative_template_source(home: &Path, template: &str) -> Result<PathBuf> {
    crate::resource_dirs::validate_template_name(template)
        .map_err(|_| anyhow!("INVALID_ARGUMENT: not a template name: {template}"))?;
    let source = home
        .join(crate::resource_dirs::TEMPLATES_DIR)
        .join(template);
    if !source.is_dir() {
        return Err(anyhow!("NOT_FOUND: template not found: {template}"));
    }
    if crate::resource_templates::read_template_meta(&source)?.target
        != crate::resource_templates::TemplateTarget::Creative
    {
        return Err(anyhow!(
            "INVALID_ARGUMENT: {template} is a resource folder template, not a creative one"
        ));
    }
    Ok(source)
}

/// A template only starts a creative folder that is missing or empty; it is
/// never laid over files already there.
pub fn check_creative_folder_free(base: &Path) -> Result<()> {
    match fs::symlink_metadata(base) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error).context("read the creative folder"),
        Ok(meta) if !meta.is_dir() => {
            return Err(anyhow!(
                "PRECONDITION: {} is not a plain folder; the template was not applied",
                base.display()
            ))
        }
        Ok(_) => {}
    }
    for entry in fs::read_dir(base)? {
        if entry?.file_name() != ".DS_Store" {
            return Err(anyhow!(
                "PRECONDITION: {} already has content; the template was not applied, and the existing files are used as they are",
                base.display()
            ));
        }
    }
    Ok(())
}

/// Lay a creative template's folders out as the project's categories, in its
/// storage's `creative/`. Folders only: no files, no later syncing.
pub fn apply_creative_template(
    db: &Database,
    group: &ProjectGroupRecord,
    home: &Path,
    template: &str,
) -> Result<Vec<String>> {
    ensure_schema(db)?;
    let source = creative_template_source(home, template)?;
    let store = storage(db, group)?;
    check_creative_folder_free(&store.base)?;
    let folders = crate::resource_dirs::template_folders(&source)?
        .iter()
        .map(|folder| normalize_category(folder))
        .collect::<Result<Vec<_>>>()?;
    let existed = store.base.exists();
    let made = (|| -> Result<()> {
        for folder in &folders {
            fs::create_dir_all(store.base.join(folder))?;
            remember_category(db, &group.id, folder)?;
        }
        Ok(())
    })();
    if let Err(error) = made {
        if !existed {
            // Made by this call and holding only empty folders.
            let _ = fs::remove_dir_all(&store.base);
        }
        return Err(error);
    }
    Ok(folders)
}
