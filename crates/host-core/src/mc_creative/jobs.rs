//! Generation jobs: one per request, results recorded before they are
//! registered as assets.

use super::*;

// ---- jobs -------------------------------------------------------------------

fn snapshot_references(snapshot: &Value) -> Vec<ReferenceUse> {
    snapshot
        .get("references")
        .cloned()
        .and_then(|value| serde_json::from_value::<Vec<ReferenceUse>>(value).ok())
        .unwrap_or_default()
}

pub fn get_job(db: &Database, id: &str) -> Result<Option<Job>> {
    ensure_schema(db)?;
    let job = db
        .conn()
        .query_row(
            "SELECT id, group_id, entry, session_id, provider_id, model_id, snapshot, status, error, created_at, updated_at, ended_at FROM mc_creative_jobs WHERE id = ?1",
            params![id],
            |row| {
                Ok(Job {
                    id: row.get(0)?,
                    group_id: row.get(1)?,
                    entry: row.get(2)?,
                    session_id: row.get(3)?,
                    provider_id: row.get(4)?,
                    model_id: row.get(5)?,
                    snapshot: serde_json::from_str(&row.get::<_, String>(6)?).unwrap_or(Value::Null),
                    status: JobStatus::parse(&row.get::<_, String>(7)?),
                    error: row.get(8)?,
                    created_at: row.get(9)?,
                    updated_at: row.get(10)?,
                    ended_at: row.get(11)?,
                    results: Vec::new(),
                })
            },
        )
        .optional()?;
    let Some(mut job) = job else { return Ok(None) };
    let mut stmt = db.conn().prepare(
        "SELECT idx, status, path, asset_id, error FROM mc_creative_job_results WHERE job_id = ?1 ORDER BY idx",
    )?;
    job.results = stmt
        .query_map(params![id], |row| {
            Ok(JobResult {
                index: row.get(0)?,
                status: row.get(1)?,
                path: row.get(2)?,
                asset_id: row.get(3)?,
                error: row.get(4)?,
            })
        })?
        .collect::<rusqlite::Result<_>>()?;
    Ok(Some(job))
}

fn group_job(db: &Database, group: &ProjectGroupRecord, id: &str) -> Result<Job> {
    get_job(db, id)?
        .filter(|job| job.group_id == group.id)
        .ok_or_else(|| anyhow!("NOT_FOUND: generation not found"))
}

/// Record a request before anything runs: the queue shows it at once, and
/// every result has a row to land in.
pub fn create_job(db: &Database, group: &ProjectGroupRecord, input: JobInput) -> Result<Job> {
    ensure_schema(db)?;
    if !matches!(input.entry.as_str(), "chat" | "form" | "code") {
        return Err(anyhow!("INVALID_ARGUMENT: unknown entry"));
    }
    if input.count == 0 || input.count > MAX_RESULTS {
        return Err(anyhow!(
            "INVALID_ARGUMENT: a generation asks for 1 to {MAX_RESULTS} results"
        ));
    }
    if input.snapshot.to_string().chars().count() > MAX_TEXT_CHARS * 2 {
        return Err(anyhow!("INVALID_ARGUMENT: the request is too large"));
    }
    if let Some(raw) = input.snapshot.get("category").and_then(Value::as_str) {
        normalize_category(raw)?;
    }
    let references = snapshot_references(&input.snapshot);
    if references.len() > MAX_REFERENCES {
        return Err(anyhow!("INVALID_ARGUMENT: too many references"));
    }
    for reference in &references {
        group_asset(db, group, &reference.asset_id)?;
    }
    storage(db, group)?;
    let id = uuid::Uuid::new_v4().to_string();
    let now = now_ms();
    let tx = db.conn().unchecked_transaction()?;
    tx.execute(
        "INSERT INTO mc_creative_jobs (id, group_id, entry, session_id, provider_id, model_id, snapshot, status, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'pending', ?8, ?8)",
        params![id, group.id, input.entry, input.session_id, input.provider_id, input.model_id, input.snapshot.to_string(), now],
    )?;
    for index in 0..input.count {
        tx.execute(
            "INSERT INTO mc_creative_job_results (job_id, idx, status) VALUES (?1, ?2, 'pending')",
            params![id, index as i64],
        )?;
    }
    tx.commit()?;
    group_job(db, group, &id)
}

/// Where the job's results are written: the folder of the chosen category.
pub fn output_dir(db: &Database, group: &ProjectGroupRecord, category: &str) -> Result<PathBuf> {
    let dir = storage(db, group)?.category_dir(&normalize_category(category)?);
    fs::create_dir_all(&dir)?;
    Ok(dir)
}

/// The category a job's results go to (from its snapshot; empty when none).
fn snapshot_category(snapshot: &Value) -> String {
    snapshot
        .get("category")
        .and_then(Value::as_str)
        .and_then(|raw| normalize_category(raw).ok())
        .unwrap_or_default()
}

pub fn set_job_status(
    db: &Database,
    group: &ProjectGroupRecord,
    id: &str,
    status: JobStatus,
    error: Option<&str>,
) -> Result<Job> {
    let job = group_job(db, group, id)?;
    if job.status.is_final() {
        return Ok(job);
    }
    let now = now_ms();
    db.conn().execute(
        "UPDATE mc_creative_jobs SET status = ?2, error = COALESCE(?3, error), updated_at = ?4, ended_at = CASE WHEN ?5 THEN ?4 ELSE ended_at END WHERE id = ?1",
        params![id, status.as_str(), error, now, status.is_final()],
    )?;
    if status.is_final() {
        // Results that never reported end with the job.
        let left = if status == JobStatus::Cancelled {
            "cancelled"
        } else {
            "failed"
        };
        db.conn().execute(
            "UPDATE mc_creative_job_results SET status = ?2 WHERE job_id = ?1 AND status = 'pending'",
            params![id, left],
        )?;
    }
    group_job(db, group, id)
}

/// Record one result. A saved file is written to the record first and then
/// registered; a registration that fails leaves the path for `reconcile`.
pub fn record_result(
    db: &Database,
    group: &ProjectGroupRecord,
    id: &str,
    index: i64,
    path: Option<&Path>,
    facts: &FileFacts,
    error: Option<&str>,
) -> Result<Job> {
    let job = group_job(db, group, id)?;
    let Some(result) = job.results.iter().find(|result| result.index == index) else {
        return Err(anyhow!("INVALID_ARGUMENT: no such result"));
    };
    if result.asset_id.is_some() {
        return Ok(job);
    }
    match path {
        Some(path) => {
            if !in_project(group, path) {
                return Err(anyhow!(
                    "PERMISSION_DENIED: results are saved inside the project folder"
                ));
            }
            db.conn().execute(
                "UPDATE mc_creative_job_results SET status = 'saved', path = ?3, error = NULL WHERE job_id = ?1 AND idx = ?2",
                params![id, index, path.to_string_lossy()],
            )?;
            register_result(db, group, &job, index, path, facts)?;
        }
        None => {
            db.conn().execute(
                "UPDATE mc_creative_job_results SET status = 'failed', error = ?3 WHERE job_id = ?1 AND idx = ?2",
                params![id, index, error.unwrap_or("failed")],
            )?;
        }
    }
    settle(db, group, id)
}

fn register_result(
    db: &Database,
    group: &ProjectGroupRecord,
    job: &Job,
    index: i64,
    path: &Path,
    facts: &FileFacts,
) -> Result<()> {
    let origin = if job.entry == "code" {
        Origin::Code
    } else {
        Origin::Model
    };
    let title = job
        .snapshot
        .get("prompt")
        .and_then(Value::as_str)
        .unwrap_or("")
        .chars()
        .take(60)
        .collect::<String>();
    let category = snapshot_category(&job.snapshot);
    let asset = insert_asset(
        db,
        &group.id,
        origin,
        path,
        facts,
        &title,
        Some((&job.id, index)),
        &category,
    )?;
    for (position, reference) in snapshot_references(&job.snapshot).iter().enumerate() {
        db.conn().execute(
            "INSERT OR IGNORE INTO mc_creative_asset_refs (asset_id, ref_asset_id, position, role) VALUES (?1, ?2, ?3, ?4)",
            params![asset.id, reference.asset_id, position as i64, reference.role],
        )?;
    }
    db.conn().execute(
        "UPDATE mc_creative_job_results SET status = 'done', asset_id = ?3 WHERE job_id = ?1 AND idx = ?2",
        params![job.id, index, asset.id],
    )?;
    Ok(())
}

/// Close the job once every result has reported.
fn settle(db: &Database, group: &ProjectGroupRecord, id: &str) -> Result<Job> {
    let job = group_job(db, group, id)?;
    if job.status.is_final() || job.results.iter().any(|result| result.status == "pending") {
        return Ok(job);
    }
    let done = job
        .results
        .iter()
        .filter(|result| result.status == "done")
        .count();
    let status = match done {
        0 => JobStatus::Failed,
        n if n == job.results.len() => JobStatus::Done,
        _ => JobStatus::Partial,
    };
    set_job_status(db, group, id, status, None)
}

/// Complete registrations that a crash or an error cut off: a result whose
/// file was saved but has no asset is registered from its record, without
/// calling the model again. Returns how many were registered.
pub fn reconcile(db: &Database, group: &ProjectGroupRecord) -> Result<usize> {
    ensure_schema(db)?;
    let mut stmt = db.conn().prepare(
        "SELECT r.job_id, r.idx, r.path FROM mc_creative_job_results r JOIN mc_creative_jobs j ON j.id = r.job_id
         WHERE j.group_id = ?1 AND r.path IS NOT NULL AND r.asset_id IS NULL",
    )?;
    let pending: Vec<(String, i64, String)> = stmt
        .query_map(params![group.id], |row| {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?))
        })?
        .collect::<rusqlite::Result<_>>()?;
    let mut registered = 0;
    for (job_id, index, path) in pending {
        let path = PathBuf::from(path);
        if !path.is_file() {
            continue;
        }
        let Some(job) = get_job(db, &job_id)? else {
            continue;
        };
        register_result(db, group, &job, index, &path, &FileFacts::default())?;
        registered += 1;
        if !job.status.is_final() {
            settle(db, group, &job_id)?;
        }
    }
    Ok(registered)
}

/// At startup nothing can still be generating: Electron main runs every job.
/// Unfinished jobs are marked interrupted so the queue does not wait forever.
pub fn interrupt_unfinished(db: &Database) -> Result<usize> {
    ensure_schema(db)?;
    let now = now_ms();
    let changed = db.conn().execute(
        "UPDATE mc_creative_jobs SET status = 'interrupted', updated_at = ?1, ended_at = ?1
         WHERE status IN ('pending', 'running', 'saving')",
        params![now],
    )?;
    db.conn().execute(
        "UPDATE mc_creative_job_results SET status = 'failed', error = 'interrupted'
         WHERE status = 'pending' AND job_id IN (SELECT id FROM mc_creative_jobs WHERE status = 'interrupted')",
        [],
    )?;
    Ok(changed)
}

pub fn list_jobs(db: &Database, group: &ProjectGroupRecord, limit: usize) -> Result<Vec<Job>> {
    ensure_schema(db)?;
    let mut stmt = db.conn().prepare(
        "SELECT id FROM mc_creative_jobs WHERE group_id = ?1 ORDER BY created_at DESC LIMIT ?2",
    )?;
    let ids: Vec<String> = stmt
        .query_map(params![group.id, limit.clamp(1, 500) as i64], |row| {
            row.get(0)
        })?
        .collect::<rusqlite::Result<_>>()?;
    let mut jobs = Vec::with_capacity(ids.len());
    for id in ids {
        if let Some(job) = get_job(db, &id)? {
            jobs.push(job);
        }
    }
    Ok(jobs)
}

/// Register an image a script drew, with the script as its snapshot. The
/// image is moved into the category's folder when it is inside the project
/// and copied there otherwise; the script is kept under `scripts/`.
pub fn register_code_drawing(
    db: &Database,
    group: &ProjectGroupRecord,
    image: &Path,
    script: Option<&Path>,
    command: &str,
    session_id: Option<&str>,
    facts: &FileFacts,
    category: &str,
) -> Result<Job> {
    ensure_schema(db)?;
    let store = storage(db, group)?;
    let category = normalize_category(category)?;
    if !image.is_file() {
        return Err(anyhow!("INVALID_ARGUMENT: the image does not exist"));
    }
    let mut snapshot = json!({ "command": command.chars().take(4000).collect::<String>() });
    if let Some(script) = script {
        if !script.is_file() {
            return Err(anyhow!("INVALID_ARGUMENT: the script does not exist"));
        }
        let (sha, bytes) = sha256_file(script)?;
        if bytes > 1024 * 1024 {
            return Err(anyhow!("INVALID_ARGUMENT: the script is too large"));
        }
        let dir = store.scripts.clone();
        fs::create_dir_all(&dir)?;
        let name = script
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_default();
        let kept = dir.join(format!("{}-{}", &sha[..8], safe_file_name(&name)));
        if !kept.exists() {
            fs::copy(script, &kept)?;
        }
        snapshot["script"] = json!({
            "source": script.to_string_lossy(),
            "kept": kept.to_string_lossy(),
            "sha256": sha,
        });
    }
    // Results are filed in their category folder: a drawing already there
    // stays; one elsewhere in the project (say, its root) is moved in; one
    // outside the project (the session scratch) is copied in.
    let target = if within(&store.category_dir(&category), image) {
        image.to_path_buf()
    } else {
        let name = image
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_default();
        let target = output_dir(db, group, &category)?.join(format!(
            "{}-{}",
            &uuid::Uuid::new_v4().to_string()[..8],
            safe_file_name(&name)
        ));
        if in_project(group, image) {
            if fs::rename(image, &target).is_err() {
                fs::copy(image, &target)?;
                let _ = fs::remove_file(image);
            }
        } else {
            fs::copy(image, &target)?;
        }
        target
    };
    snapshot["category"] = json!(category);
    snapshot["prompt"] = json!(image
        .file_stem()
        .map(|stem| stem.to_string_lossy().into_owned())
        .unwrap_or_default());
    let job = create_job(
        db,
        group,
        JobInput {
            entry: "code".into(),
            session_id: session_id.map(str::to_string),
            provider_id: None,
            model_id: None,
            snapshot,
            count: 1,
        },
    )?;
    set_job_status(db, group, &job.id, JobStatus::Saving, None)?;
    record_result(db, group, &job.id, 0, Some(&target), facts, None)
}
