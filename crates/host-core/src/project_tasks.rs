//! Project tasks (mc-agent R6–R9).
//!
//! A task has a stable id, a goal, required acceptance criteria and the
//! resources it relies on. Starting it records a run bound to one session and
//! a snapshot of the referenced resources' states; a missing or changed
//! resource blocks the start. A run that ends never completes its task by
//! itself: a completed turn moves the task to awaiting review, a stopped or
//! failed one (or a deleted session) moves it to blocked, and only the user's
//! review marks it done. Runs are reconciled from the session's turns on every
//! read, so the state is right even when no window watched the run end.
//! Tasks live in their own kv namespace keyed by project group id.

use anyhow::{anyhow, Context, Result};
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};

use crate::db::{now_ms, Database, ProjectGroupRecord};
use crate::resource_catalog::{self, ResourceStatus};

const NAMESPACE: &str = "mcProjectTasks";
const MAX_TITLE_CHARS: usize = 200;
const MAX_TEXT_CHARS: usize = 8_000;
const MAX_RESOURCES: usize = 50;
/// A run whose session has not begun a turn this long after the start never
/// started (the first message failed, or the app quit in between). Well above
/// what a first message can wait for the session's MCP servers to connect
/// (connect and tool discovery are bounded at 10 s and 30 s per server).
const START_GRACE_MS: i64 = 10 * 60_000;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum TaskStatus {
    Todo,
    InProgress,
    AwaitingReview,
    Done,
    Blocked,
    Cancelled,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum RunOutcome {
    Running,
    Finished,
    Stopped,
    Failed,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ResourceSnapshot {
    pub key: String,
    pub title: String,
    pub status: ResourceStatus,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TaskRun {
    pub id: String,
    pub session_id: String,
    pub start_folder: String,
    pub started_at: i64,
    pub resources: Vec<ResourceSnapshot>,
    pub outcome: RunOutcome,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ended_at: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum Verdict {
    Accepted,
    Rejected,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TaskReview {
    pub run_id: String,
    pub verdict: Verdict,
    pub note: String,
    pub at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProjectTask {
    pub id: String,
    pub title: String,
    pub goal: String,
    pub acceptance: String,
    pub resources: Vec<String>,
    pub status: TaskStatus,
    pub revision: u64,
    pub runs: Vec<TaskRun>,
    pub reviews: Vec<TaskReview>,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskInput {
    pub title: String,
    pub goal: String,
    pub acceptance: String,
    #[serde(default)]
    pub resources: Vec<String>,
}

/// What a start would use, and what stops it.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Preflight {
    pub resources: Vec<ResourceSnapshot>,
    /// Keys whose resource is missing or changed since confirmation.
    pub blocking: Vec<String>,
    /// Keys still in draft: usable, but shown as unconfirmed.
    pub drafts: Vec<String>,
}

/// Every task of the project, with finished runs reconciled.
pub fn list(db: &Database, group: &ProjectGroupRecord) -> Result<Vec<ProjectTask>> {
    let mut tasks = load(db, &group.id)?;
    let mut changed = false;
    for task in &mut tasks {
        changed |= reconcile(db, task)?;
    }
    if changed {
        save(db, &group.id, &tasks)?;
    }
    Ok(tasks)
}

pub fn create(db: &Database, group: &ProjectGroupRecord, input: TaskInput) -> Result<ProjectTask> {
    let input = validate(db, group, input)?;
    let now = now_ms();
    let task = ProjectTask {
        id: uuid::Uuid::new_v4().to_string(),
        title: input.title,
        goal: input.goal,
        acceptance: input.acceptance,
        resources: input.resources,
        status: TaskStatus::Todo,
        revision: 1,
        runs: Vec::new(),
        reviews: Vec::new(),
        created_at: now,
        updated_at: now,
    };
    let mut tasks = load(db, &group.id)?;
    tasks.push(task.clone());
    save(db, &group.id, &tasks)?;
    Ok(task)
}

/// Edit a task. `revision` must match the stored one, so two editors cannot
/// silently overwrite each other; a running task cannot be edited.
pub fn update(
    db: &Database,
    group: &ProjectGroupRecord,
    task_id: &str,
    revision: u64,
    input: TaskInput,
) -> Result<ProjectTask> {
    let input = validate(db, group, input)?;
    mutate(db, group, task_id, revision, |task| {
        if task.status == TaskStatus::InProgress {
            return Err(anyhow!("CONFLICT: a running task cannot be edited"));
        }
        task.title = input.title;
        task.goal = input.goal;
        task.acceptance = input.acceptance;
        task.resources = input.resources;
        Ok(())
    })
}

pub fn cancel(
    db: &Database,
    group: &ProjectGroupRecord,
    task_id: &str,
    revision: u64,
) -> Result<ProjectTask> {
    mutate(db, group, task_id, revision, |task| {
        // A run with no turn yet may still be starting: its first message can
        // be waiting on the session (MCP servers connecting) and would begin
        // the agent after a cancel. It settles by itself (`reconcile` fails it
        // after the start grace, or the start reports its failure), and the
        // blocked task can then be cancelled.
        if task.status == TaskStatus::InProgress {
            return Err(anyhow!(
                "CONFLICT: the task is running or still starting; stop its session, or wait for the start to settle, before cancelling"
            ));
        }
        task.status = TaskStatus::Cancelled;
        Ok(())
    })
}

/// Settle a run whose start failed after it was recorded (the first message
/// could not be sent): it fails and the task is blocked, so it can be started
/// again. A run that already has a turn is left to `reconcile`.
pub fn abandon_run(
    db: &Database,
    group: &ProjectGroupRecord,
    task_id: &str,
    run_id: &str,
    reason: &str,
) -> Result<ProjectTask> {
    let mut tasks = load(db, &group.id)?;
    let task = tasks
        .iter_mut()
        .find(|task| task.id == task_id)
        .ok_or_else(|| anyhow!("NOT_FOUND: task not found"))?;
    reconcile(db, task)?;
    let Some(run) = task.runs.last_mut() else {
        return Ok(task.clone());
    };
    if run.id != run_id
        || run.outcome != RunOutcome::Running
        || latest_turn_status(db, run)?.is_some()
    {
        return Ok(task.clone());
    }
    let reason: String = reason.trim().chars().take(500).collect();
    run.outcome = RunOutcome::Failed;
    run.ended_at = Some(now_ms());
    run.note = Some(if reason.is_empty() {
        "the run could not start".to_string()
    } else {
        format!("the run could not start: {reason}")
    });
    if task.status == TaskStatus::InProgress {
        task.status = TaskStatus::Blocked;
    }
    task.revision += 1;
    task.updated_at = now_ms();
    let updated = task.clone();
    save(db, &group.id, &tasks)?;
    Ok(updated)
}

pub fn reopen(
    db: &Database,
    group: &ProjectGroupRecord,
    task_id: &str,
    revision: u64,
) -> Result<ProjectTask> {
    mutate(db, group, task_id, revision, |task| {
        if !matches!(task.status, TaskStatus::Cancelled | TaskStatus::Blocked) {
            return Err(anyhow!(
                "CONFLICT: only cancelled or blocked tasks can be reopened"
            ));
        }
        task.status = TaskStatus::Todo;
        Ok(())
    })
}

pub fn preflight(db: &Database, group: &ProjectGroupRecord, task_id: &str) -> Result<Preflight> {
    let task = load(db, &group.id)?
        .into_iter()
        .find(|task| task.id == task_id)
        .ok_or_else(|| anyhow!("NOT_FOUND: task not found"))?;
    resource_preflight(db, group, &task.resources)
}

/// Record a run for a session the caller just created in `start_folder`.
/// Refused while another run of the task is active, when the task is not
/// startable, when the folder is not part of the project, or when a
/// referenced resource is missing or changed.
pub fn start_run(
    db: &Database,
    group: &ProjectGroupRecord,
    task_id: &str,
    revision: u64,
    session_id: &str,
    start_folder: &str,
) -> Result<ProjectTask> {
    if !group.roots.iter().any(|root| root.path == start_folder) {
        return Err(anyhow!(
            "PERMISSION_DENIED: start folder is not part of this project"
        ));
    }
    if session_project(db, session_id)?.as_deref() != Some(start_folder) {
        return Err(anyhow!(
            "INVALID_ARGUMENT: the session does not start in that folder"
        ));
    }
    let mut tasks = load(db, &group.id)?;
    let task = tasks
        .iter_mut()
        .find(|task| task.id == task_id)
        .ok_or_else(|| anyhow!("NOT_FOUND: task not found"))?;
    reconcile(db, task)?;
    if task.revision != revision {
        return Err(anyhow!(
            "CONFLICT: the task changed; reload it before starting"
        ));
    }
    if !matches!(task.status, TaskStatus::Todo | TaskStatus::Blocked) {
        return Err(anyhow!(
            "CONFLICT: only to-do or blocked tasks can be started"
        ));
    }
    let check = resource_preflight(db, group, &task.resources)?;
    if !check.blocking.is_empty() {
        return Err(anyhow!(
            "RESOURCES_BLOCKED: missing or changed resources: {}",
            check.blocking.join(", ")
        ));
    }
    let now = now_ms();
    task.runs.push(TaskRun {
        id: uuid::Uuid::new_v4().to_string(),
        session_id: session_id.to_string(),
        start_folder: start_folder.to_string(),
        started_at: now,
        resources: check.resources,
        outcome: RunOutcome::Running,
        ended_at: None,
        note: None,
    });
    task.status = TaskStatus::InProgress;
    task.revision += 1;
    task.updated_at = now;
    let started = task.clone();
    save(db, &group.id, &tasks)?;
    Ok(started)
}

/// The user's verdict on the latest finished run: accepted completes the
/// task, rejected sends it back to do with the reason kept.
pub fn review(
    db: &Database,
    group: &ProjectGroupRecord,
    task_id: &str,
    revision: u64,
    verdict: Verdict,
    note: &str,
) -> Result<ProjectTask> {
    let note = note.trim();
    if note.chars().count() > MAX_TEXT_CHARS {
        return Err(anyhow!("INVALID_ARGUMENT: review note is too long"));
    }
    if verdict == Verdict::Rejected && note.is_empty() {
        return Err(anyhow!(
            "INVALID_ARGUMENT: say why the result is not accepted"
        ));
    }
    mutate(db, group, task_id, revision, |task| {
        if task.status != TaskStatus::AwaitingReview {
            return Err(anyhow!("CONFLICT: the task is not awaiting review"));
        }
        let run = task
            .runs
            .last()
            .ok_or_else(|| anyhow!("CONFLICT: the task has no run to review"))?;
        task.reviews.push(TaskReview {
            run_id: run.id.clone(),
            verdict,
            note: note.to_string(),
            at: now_ms(),
        });
        task.status = match verdict {
            Verdict::Accepted => TaskStatus::Done,
            Verdict::Rejected => TaskStatus::Todo,
        };
        Ok(())
    })
}

/// Settle the task's active run from its session's turns. Returns whether the
/// task changed.
fn reconcile(db: &Database, task: &mut ProjectTask) -> Result<bool> {
    let Some(run) = task.runs.last_mut() else {
        return Ok(false);
    };
    if run.outcome != RunOutcome::Running {
        return Ok(false);
    }
    let (outcome, note) = match session_project(db, &run.session_id)? {
        None => (RunOutcome::Failed, Some("session was deleted".to_string())),
        Some(_) => {
            let turn = latest_turn_status(db, run)?;
            match turn.as_deref() {
                // No turn yet: still starting, unless the start was cut off.
                None if now_ms() - run.started_at > START_GRACE_MS => (
                    RunOutcome::Failed,
                    Some("the run never started".to_string()),
                ),
                None | Some("running") => return Ok(false),
                Some("completed") => (RunOutcome::Finished, None),
                Some("aborted") => (RunOutcome::Stopped, None),
                Some(other) => (RunOutcome::Failed, Some(format!("turn ended with {other}"))),
            }
        }
    };
    run.outcome = outcome;
    run.ended_at = Some(now_ms());
    run.note = note;
    if task.status == TaskStatus::InProgress {
        task.status = match outcome {
            RunOutcome::Finished => TaskStatus::AwaitingReview,
            _ => TaskStatus::Blocked,
        };
        task.revision += 1;
        task.updated_at = now_ms();
    }
    Ok(true)
}

/// The status of the newest turn the run's session began since the run
/// started (a minute of slack for clocks and the order of the two writes).
fn latest_turn_status(db: &Database, run: &TaskRun) -> Result<Option<String>> {
    Ok(db
        .conn()
        .query_row(
            "SELECT status FROM turns
             WHERE session_id = ?1 AND started_at >= ?2
             ORDER BY started_at DESC LIMIT 1",
            params![run.session_id, run.started_at - 60_000],
            |row| row.get(0),
        )
        .optional()?)
}

fn resource_preflight(
    db: &Database,
    group: &ProjectGroupRecord,
    keys: &[String],
) -> Result<Preflight> {
    let listing = resource_catalog::list(db, group)?;
    let mut preflight = Preflight {
        resources: Vec::new(),
        blocking: Vec::new(),
        drafts: Vec::new(),
    };
    for key in keys {
        let (title, status) = match listing.items.iter().find(|item| &item.key == key) {
            Some(item) => (item.title.clone(), item.status),
            None => (key.clone(), ResourceStatus::Missing),
        };
        match status {
            ResourceStatus::Missing | ResourceStatus::Changed => {
                preflight.blocking.push(key.clone())
            }
            ResourceStatus::Draft => preflight.drafts.push(key.clone()),
            ResourceStatus::Confirmed | ResourceStatus::Deprecated => {}
        }
        preflight.resources.push(ResourceSnapshot {
            key: key.clone(),
            title,
            status,
        });
    }
    Ok(preflight)
}

fn session_project(db: &Database, session_id: &str) -> Result<Option<String>> {
    Ok(db
        .conn()
        .query_row(
            "SELECT p.path FROM sessions s LEFT JOIN projects p ON p.id = s.project_id
             WHERE s.id = ?1 AND s.deleted_at IS NULL",
            params![session_id],
            |row| row.get::<_, Option<String>>(0),
        )
        .optional()?
        .map(|path| path.unwrap_or_default()))
}

fn validate(db: &Database, group: &ProjectGroupRecord, input: TaskInput) -> Result<TaskInput> {
    let title = input.title.trim().to_string();
    let goal = input.goal.trim().to_string();
    let acceptance = input.acceptance.trim().to_string();
    if title.is_empty() || title.chars().count() > MAX_TITLE_CHARS {
        return Err(anyhow!("INVALID_ARGUMENT: a task needs a title"));
    }
    if acceptance.is_empty() {
        return Err(anyhow!(
            "INVALID_ARGUMENT: a task needs acceptance criteria"
        ));
    }
    if goal.chars().count() > MAX_TEXT_CHARS || acceptance.chars().count() > MAX_TEXT_CHARS {
        return Err(anyhow!("INVALID_ARGUMENT: task text is too long"));
    }
    let mut resources = Vec::new();
    for key in input.resources {
        if !resources.contains(&key) {
            resources.push(key);
        }
    }
    if resources.len() > MAX_RESOURCES {
        return Err(anyhow!("INVALID_ARGUMENT: too many resources"));
    }
    // A key from another project cannot be smuggled in: it must resolve here.
    for key in &resources {
        resource_catalog::locate(db, group, key)
            .with_context(|| format!("INVALID_ARGUMENT: unknown resource {key}"))?;
    }
    Ok(TaskInput {
        title,
        goal,
        acceptance,
        resources,
    })
}

fn mutate(
    db: &Database,
    group: &ProjectGroupRecord,
    task_id: &str,
    revision: u64,
    change: impl FnOnce(&mut ProjectTask) -> Result<()>,
) -> Result<ProjectTask> {
    let mut tasks = load(db, &group.id)?;
    let task = tasks
        .iter_mut()
        .find(|task| task.id == task_id)
        .ok_or_else(|| anyhow!("NOT_FOUND: task not found"))?;
    reconcile(db, task)?;
    if task.revision != revision {
        return Err(anyhow!("CONFLICT: the task changed; reload it first"));
    }
    change(task)?;
    task.revision += 1;
    task.updated_at = now_ms();
    let updated = task.clone();
    save(db, &group.id, &tasks)?;
    Ok(updated)
}

fn load(db: &Database, group_id: &str) -> Result<Vec<ProjectTask>> {
    Ok(match db.kv_get(NAMESPACE, group_id)? {
        Some(value) => serde_json::from_value(value).context("parse project tasks")?,
        None => Vec::new(),
    })
}

fn save(db: &Database, group_id: &str, tasks: &[ProjectTask]) -> Result<()> {
    db.kv_set(NAMESPACE, group_id, &serde_json::to_value(tasks)?)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::canonical_project_path;
    use std::fs;
    use std::path::Path;

    struct Fixture {
        _dir: tempfile::TempDir,
        db: Database,
        group: ProjectGroupRecord,
        resources: String,
        web: String,
    }

    fn fixture() -> Fixture {
        let dir = tempfile::tempdir().unwrap();
        let resources = dir.path().join("resources");
        let web = dir.path().join("web");
        fs::create_dir_all(resources.join("requirements")).unwrap();
        fs::create_dir_all(&web).unwrap();
        fs::write(resources.join("requirements/login.md"), "v1").unwrap();
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
            resources: canonical(&resources),
            web: canonical(&web),
        }
    }

    fn input(resources: &[&str]) -> TaskInput {
        TaskInput {
            title: "登录接口".into(),
            goal: "实现 POST /login".into(),
            acceptance: "单元测试通过".into(),
            resources: resources.iter().map(|key| key.to_string()).collect(),
        }
    }

    fn session_in(db: &Database, folder: &str) -> String {
        let project = db.ensure_project(folder, false).unwrap();
        let id = uuid::Uuid::new_v4().to_string();
        db.conn()
            .execute(
                "INSERT INTO sessions (id, title, mode, project_id, created_at, updated_at)
                 VALUES (?1, 't', 'agent', ?2, 0, 0)",
                params![id, project],
            )
            .unwrap();
        id
    }

    fn end_turn(db: &Database, session: &str, status: &str) {
        let turn = uuid::Uuid::new_v4().to_string();
        db.conn()
            .execute(
                "INSERT INTO turns (id, session_id, status, started_at, ended_at) VALUES (?1, ?2, ?3, ?4, ?4)",
                params![turn, session, status, now_ms()],
            )
            .unwrap();
    }

    #[test]
    fn a_run_whose_first_message_failed_is_settled_and_can_start_again() {
        let f = fixture();
        let task = create(&f.db, &f.group, input(&[])).unwrap();
        let session = session_in(&f.db, &f.web);
        let started =
            start_run(&f.db, &f.group, &task.id, task.revision, &session, &f.web).unwrap();
        let run = started.runs[0].id.clone();
        assert!(
            abandon_run(&f.db, &f.group, &task.id, "other-run", "x")
                .unwrap()
                .status
                == TaskStatus::InProgress
        );

        let settled = abandon_run(&f.db, &f.group, &task.id, &run, "network down").unwrap();
        assert_eq!(settled.status, TaskStatus::Blocked);
        assert_eq!(settled.runs[0].outcome, RunOutcome::Failed);
        assert!(settled.runs[0]
            .note
            .as_deref()
            .unwrap()
            .contains("network down"));
        let session2 = session_in(&f.db, &f.web);
        assert!(start_run(
            &f.db,
            &f.group,
            &task.id,
            settled.revision,
            &session2,
            &f.web
        )
        .is_ok());
    }

    #[test]
    fn a_run_that_never_began_a_turn_fails_after_the_grace_period() {
        let f = fixture();
        let task = create(&f.db, &f.group, input(&[])).unwrap();
        let session = session_in(&f.db, &f.web);
        start_run(&f.db, &f.group, &task.id, task.revision, &session, &f.web).unwrap();
        assert_eq!(
            list(&f.db, &f.group).unwrap()[0].status,
            TaskStatus::InProgress
        );

        // As after a restart that cut the start off long ago.
        let mut tasks = load(&f.db, &f.group.id).unwrap();
        tasks[0].runs[0].started_at = now_ms() - START_GRACE_MS - 1_000;
        save(&f.db, &f.group.id, &tasks).unwrap();
        let settled = list(&f.db, &f.group).unwrap().remove(0);
        assert_eq!(settled.status, TaskStatus::Blocked);
        assert_eq!(settled.runs[0].outcome, RunOutcome::Failed);
    }

    #[test]
    fn a_starting_task_cannot_be_cancelled_until_its_run_settles() {
        let f = fixture();
        let task = create(&f.db, &f.group, input(&[])).unwrap();
        let session = session_in(&f.db, &f.web);
        let started =
            start_run(&f.db, &f.group, &task.id, task.revision, &session, &f.web).unwrap();
        // No turn yet: the first message may still be waiting to start.
        assert!(cancel(&f.db, &f.group, &task.id, started.revision).is_err());

        let run = started.runs[0].id.clone();
        let settled = abandon_run(&f.db, &f.group, &task.id, &run, "not sent").unwrap();
        let cancelled = cancel(&f.db, &f.group, &task.id, settled.revision).unwrap();
        assert_eq!(cancelled.status, TaskStatus::Cancelled);
    }

    #[test]
    fn tasks_need_a_title_acceptance_criteria_and_project_resources() {
        let f = fixture();
        let mut no_acceptance = input(&[]);
        no_acceptance.acceptance = "  ".into();
        assert!(create(&f.db, &f.group, no_acceptance).is_err());
        assert!(create(&f.db, &f.group, input(&["folder:../escape"])).is_err());
        assert!(create(&f.db, &f.group, input(&["entry:other-project"])).is_err());
        let task = create(&f.db, &f.group, input(&["folder:requirements/login.md"])).unwrap();
        assert_eq!(task.status, TaskStatus::Todo);
        assert_eq!(list(&f.db, &f.group).unwrap()[0].id, task.id);
    }

    #[test]
    fn a_completed_run_waits_for_review_and_only_acceptance_finishes_it() {
        let f = fixture();
        let task = create(&f.db, &f.group, input(&["folder:requirements/login.md"])).unwrap();
        let session = session_in(&f.db, &f.web);
        let started =
            start_run(&f.db, &f.group, &task.id, task.revision, &session, &f.web).unwrap();
        assert_eq!(started.status, TaskStatus::InProgress);
        assert_eq!(started.runs[0].resources[0].status, ResourceStatus::Draft);
        assert!(
            start_run(
                &f.db,
                &f.group,
                &task.id,
                started.revision,
                &session,
                &f.web
            )
            .is_err(),
            "one active run per task"
        );

        assert_eq!(
            list(&f.db, &f.group).unwrap()[0].status,
            TaskStatus::InProgress
        );
        end_turn(&f.db, &session, "completed");
        let waiting = list(&f.db, &f.group).unwrap().remove(0);
        assert_eq!(waiting.status, TaskStatus::AwaitingReview);
        assert_eq!(waiting.runs[0].outcome, RunOutcome::Finished);

        assert!(review(
            &f.db,
            &f.group,
            &task.id,
            waiting.revision,
            Verdict::Rejected,
            ""
        )
        .is_err());
        let rejected = review(
            &f.db,
            &f.group,
            &task.id,
            waiting.revision,
            Verdict::Rejected,
            "缺少错误处理",
        )
        .unwrap();
        assert_eq!(rejected.status, TaskStatus::Todo);
        assert_eq!(rejected.reviews[0].note, "缺少错误处理");

        let session2 = session_in(&f.db, &f.resources);
        let second = start_run(
            &f.db,
            &f.group,
            &task.id,
            rejected.revision,
            &session2,
            &f.resources,
        )
        .unwrap();
        end_turn(&f.db, &session2, "completed");
        let waiting = list(&f.db, &f.group).unwrap().remove(0);
        let done = review(
            &f.db,
            &f.group,
            &task.id,
            waiting.revision,
            Verdict::Accepted,
            "",
        )
        .unwrap();
        assert_eq!(done.status, TaskStatus::Done);
        assert_eq!(done.runs.len(), 2);
        assert_eq!(second.runs[1].start_folder, f.resources);
    }

    #[test]
    fn stopped_failed_or_deleted_runs_block_the_task() {
        let f = fixture();
        for (status, outcome) in [
            ("aborted", RunOutcome::Stopped),
            ("error", RunOutcome::Failed),
        ] {
            let task = create(&f.db, &f.group, input(&[])).unwrap();
            let session = session_in(&f.db, &f.web);
            start_run(&f.db, &f.group, &task.id, task.revision, &session, &f.web).unwrap();
            end_turn(&f.db, &session, status);
            let task = list(&f.db, &f.group)
                .unwrap()
                .into_iter()
                .find(|t| t.id == task.id)
                .unwrap();
            assert_eq!(task.status, TaskStatus::Blocked);
            assert_eq!(task.runs[0].outcome, outcome);
        }
        let task = create(&f.db, &f.group, input(&[])).unwrap();
        let session = session_in(&f.db, &f.web);
        start_run(&f.db, &f.group, &task.id, task.revision, &session, &f.web).unwrap();
        f.db.conn()
            .execute("DELETE FROM sessions WHERE id = ?1", params![session])
            .unwrap();
        let task = list(&f.db, &f.group)
            .unwrap()
            .into_iter()
            .find(|t| t.id == task.id)
            .unwrap();
        assert_eq!(task.status, TaskStatus::Blocked);
        assert_eq!(task.runs[0].note.as_deref(), Some("session was deleted"));
        let reopened = reopen(&f.db, &f.group, &task.id, task.revision).unwrap();
        assert_eq!(reopened.status, TaskStatus::Todo);
    }

    #[test]
    fn missing_or_changed_resources_block_the_start() {
        let f = fixture();
        let key = "folder:requirements/login.md";
        resource_catalog::set_status(&f.db, &f.group, key, ResourceStatus::Confirmed).unwrap();
        let task = create(&f.db, &f.group, input(&[key])).unwrap();
        fs::write(Path::new(&f.resources).join("requirements/login.md"), "v2").unwrap();
        let check = preflight(&f.db, &f.group, &task.id).unwrap();
        assert_eq!(check.blocking, [key]);
        let session = session_in(&f.db, &f.web);
        let refused = start_run(&f.db, &f.group, &task.id, task.revision, &session, &f.web);
        assert!(refused
            .unwrap_err()
            .to_string()
            .starts_with("RESOURCES_BLOCKED"));

        resource_catalog::set_status(&f.db, &f.group, key, ResourceStatus::Confirmed).unwrap();
        assert!(preflight(&f.db, &f.group, &task.id)
            .unwrap()
            .blocking
            .is_empty());
        fs::remove_file(Path::new(&f.resources).join("requirements/login.md")).unwrap();
        assert_eq!(
            preflight(&f.db, &f.group, &task.id).unwrap().blocking,
            [key]
        );
    }

    #[test]
    fn starts_are_bound_to_the_project_session_and_revision() {
        let f = fixture();
        let task = create(&f.db, &f.group, input(&[])).unwrap();
        let session = session_in(&f.db, &f.web);
        let outside = f._dir.path().join("outside");
        fs::create_dir_all(&outside).unwrap();
        let outside = canonical_project_path(&outside.to_string_lossy()).unwrap();
        assert!(start_run(&f.db, &f.group, &task.id, task.revision, &session, &outside).is_err());
        assert!(start_run(
            &f.db,
            &f.group,
            &task.id,
            task.revision,
            &session,
            &f.resources
        )
        .is_err());
        assert!(start_run(
            &f.db,
            &f.group,
            &task.id,
            task.revision + 1,
            &session,
            &f.web
        )
        .is_err());
        let edited = update(&f.db, &f.group, &task.id, task.revision, input(&[])).unwrap();
        assert!(update(&f.db, &f.group, &task.id, task.revision, input(&[])).is_err());
        let cancelled = cancel(&f.db, &f.group, &task.id, edited.revision).unwrap();
        assert_eq!(cancelled.status, TaskStatus::Cancelled);
        assert!(start_run(
            &f.db,
            &f.group,
            &task.id,
            cancelled.revision,
            &session,
            &f.web
        )
        .is_err());
    }
}
