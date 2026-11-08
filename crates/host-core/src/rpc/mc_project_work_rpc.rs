//! R29: the agent's bounded view of its own project's tasks and resources.
//!
//! The project is the one the calling session belongs to (never a caller
//! supplied id). Responses are deliberately small: lists carry short ids,
//! titles and statuses; details are read one task at a time; writes answer
//! with what changed. Accepting work and confirming or deprecating resources
//! stay in the workbench: this surface has no action for them.
use super::mc_project_history_rpc::group_for_session;
use super::*;
use crate::db::{ms_to_ts, Database, ProjectGroupRecord};
use crate::project_tasks::{self, ProjectTask, TaskInput, TaskStatus};
use crate::resource_catalog::{self, ResourceItem, ResourceStatus, ResourceTarget};
use serde::Deserialize;
use std::path::Path;

const DEFAULT_LIMIT: usize = 10;
const MAX_LIMIT: usize = 20;
/// Goal and acceptance text kept per field unless `full` is asked for.
const DETAIL_CHARS: usize = 1_500;
const GOAL_CHARS: usize = 2_000;
const SHORT_ID: usize = 8;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Request {
    session_id: String,
    tool: String,
    action: String,
    task_id: Option<String>,
    revision: Option<u64>,
    title: Option<String>,
    goal: Option<String>,
    acceptance: Option<String>,
    resources: Option<Vec<String>>,
    status: Option<String>,
    query: Option<String>,
    category: Option<String>,
    key: Option<String>,
    path: Option<String>,
    url: Option<String>,
    full: Option<bool>,
    offset: Option<usize>,
    limit: Option<usize>,
}

fn invalid(message: impl Into<String>) -> JsonRpcError {
    rpc_err(1002, message, "INVALID_PARAMS")
}

fn internal(error: impl std::fmt::Display) -> JsonRpcError {
    rpc_err(1000, error.to_string(), "INTERNAL")
}

pub(super) async fn handle(
    state: &Arc<Mutex<AppState>>,
    params: &Value,
) -> Result<Value, JsonRpcError> {
    let request: Request = serde_json::from_value(params.clone())
        .map_err(|error| invalid(format!("Invalid arguments: {error}")))?;
    if request.limit.is_some_and(|n| n == 0 || n > MAX_LIMIT) {
        return Err(invalid(format!("limit must be 1-{MAX_LIMIT}")));
    }
    let st = state.lock().await;
    let (group, session) = group_for_session(&st.db, &request.session_id)?;
    let mut result = match request.tool.as_str() {
        "tasks" => tasks(&st.db, &group, &request)?,
        "resources" => resources(&st.db, &group, session.project_path.as_deref(), &request)?,
        _ => return Err(invalid("tool must be tasks or resources")),
    };
    result["project"] = json!(group.name);
    Ok(result)
}

// ---------------------------------------------------------------- tasks

fn tasks(
    db: &Database,
    group: &ProjectGroupRecord,
    request: &Request,
) -> Result<Value, JsonRpcError> {
    let action = request.action.as_str();
    let all = project_tasks::list(db, group).map_err(super::project_tasks_rpc::coded)?;
    match action {
        "list" => list_tasks(db, group, &all, request),
        "get" => {
            let task = find_task(&all, request.task_id.as_deref())?;
            task_detail(db, group, &all, task, request.full.unwrap_or(false))
        }
        "create" => {
            let input = TaskInput {
                title: request
                    .title
                    .clone()
                    .ok_or_else(|| invalid("title required"))?,
                goal: request.goal.clone().unwrap_or_default(),
                acceptance: request
                    .acceptance
                    .clone()
                    .ok_or_else(|| invalid("acceptance required"))?,
                resources: request.resources.clone().unwrap_or_default(),
            };
            let task =
                project_tasks::create(db, group, input).map_err(super::project_tasks_rpc::coded)?;
            let mut all = all;
            all.push(task.clone());
            Ok(
                json!({ "id": short_id(&all, &task.id), "revision": task.revision, "status": task.status }),
            )
        }
        "update" => {
            let task = find_task(&all, request.task_id.as_deref())?;
            let revision = request
                .revision
                .ok_or_else(|| invalid("revision required (from get)"))?;
            let mut changed = Vec::new();
            let mut pick = |name: &'static str, next: &Option<String>, current: &str| match next {
                Some(value) if value.trim() != current => {
                    changed.push(name);
                    value.clone()
                }
                _ => current.to_string(),
            };
            let title = pick("title", &request.title, &task.title);
            let goal = pick("goal", &request.goal, &task.goal);
            let acceptance = pick("acceptance", &request.acceptance, &task.acceptance);
            let resources = match &request.resources {
                Some(keys) if *keys != task.resources => {
                    changed.push("resources");
                    keys.clone()
                }
                _ => task.resources.clone(),
            };
            if changed.is_empty() {
                return Err(invalid("nothing to change"));
            }
            let updated = project_tasks::update(
                db,
                group,
                &task.id,
                revision,
                TaskInput {
                    title,
                    goal,
                    acceptance,
                    resources,
                },
            )
            .map_err(super::project_tasks_rpc::coded)?;
            Ok(
                json!({ "id": short_id(&all, &updated.id), "revision": updated.revision, "changed": changed }),
            )
        }
        _ => Err(invalid("tasks action must be list, get, create or update")),
    }
}

fn status_filter(value: Option<&str>) -> Result<Box<dyn Fn(TaskStatus) -> bool>, JsonRpcError> {
    let wanted: TaskStatus = match value.unwrap_or("open") {
        "open" => {
            return Ok(Box::new(|status| {
                !matches!(status, TaskStatus::Done | TaskStatus::Cancelled)
            }))
        }
        "all" => return Ok(Box::new(|_| true)),
        other => serde_json::from_value(json!(other)).map_err(|_| {
            invalid("status must be open, all, todo, inProgress, awaitingReview, done, blocked or cancelled")
        })?,
    };
    Ok(Box::new(move |status| status == wanted))
}

fn list_tasks(
    db: &Database,
    group: &ProjectGroupRecord,
    all: &[ProjectTask],
    request: &Request,
) -> Result<Value, JsonRpcError> {
    let keep = status_filter(request.status.as_deref())?;
    let query = request.query.as_deref().unwrap_or("").trim().to_lowercase();
    let mut counts = serde_json::Map::new();
    for task in all {
        let key = serde_json::to_value(task.status).map_err(internal)?;
        let key = key.as_str().unwrap_or_default().to_string();
        let count = counts.get(&key).and_then(Value::as_u64).unwrap_or(0);
        counts.insert(key, json!(count + 1));
    }
    let statuses = resource_statuses(db, group);
    let matching: Vec<&ProjectTask> = all
        .iter()
        .filter(|task| keep(task.status))
        .filter(|task| {
            query.is_empty()
                || task.title.to_lowercase().contains(&query)
                || task.goal.to_lowercase().contains(&query)
        })
        .collect();
    let offset = request.offset.unwrap_or(0);
    let limit = request.limit.unwrap_or(DEFAULT_LIMIT);
    let items: Vec<Value> = matching
        .iter()
        .skip(offset)
        .take(limit)
        .map(|task| {
            let mut row = json!({ "id": short_id(all, &task.id), "title": task.title, "status": task.status });
            if let Some(note) = attention(task, &statuses) {
                row["note"] = json!(note);
            }
            row
        })
        .collect();
    let mut out = json!({ "counts": counts, "matched": matching.len(), "tasks": items });
    if offset + limit < matching.len() {
        out["nextOffset"] = json!(offset + limit);
    }
    Ok(out)
}

/// One short reason a task needs attention, if any.
fn attention(task: &ProjectTask, statuses: &[(String, ResourceStatus)]) -> Option<String> {
    let blocking = task
        .resources
        .iter()
        .filter(|key| {
            !statuses.iter().any(|(k, status)| {
                k == *key && !matches!(status, ResourceStatus::Changed | ResourceStatus::Missing)
            })
        })
        .count();
    let mut notes = Vec::new();
    if blocking > 0 {
        notes.push(format!("{blocking} linked resource(s) changed or missing"));
    }
    if task.status == TaskStatus::Blocked {
        if let Some(run) = task.runs.last() {
            let outcome = serde_json::to_value(run.outcome).ok()?;
            notes.push(format!("last run {}", outcome.as_str().unwrap_or("ended")));
        }
    }
    (!notes.is_empty()).then(|| notes.join("; "))
}

fn task_detail(
    db: &Database,
    group: &ProjectGroupRecord,
    all: &[ProjectTask],
    task: &ProjectTask,
    full: bool,
) -> Result<Value, JsonRpcError> {
    let items = resource_catalog::list(db, group)
        .map(|l| l.items)
        .unwrap_or_default();
    let resources: Vec<Value> = task
        .resources
        .iter()
        .map(|key| match items.iter().find(|item| &item.key == key) {
            Some(item) => json!({ "key": key, "title": item.title, "status": item.status }),
            None => json!({ "key": key, "status": ResourceStatus::Missing }),
        })
        .collect();
    let mut out = json!({
        "id": short_id(all, &task.id),
        "revision": task.revision,
        "title": task.title,
        "status": task.status,
        "resources": resources,
        "updatedAt": ms_to_ts(task.updated_at),
    });
    let mut truncated = Vec::new();
    for (name, text) in [("goal", &task.goal), ("acceptance", &task.acceptance)] {
        let (kept, cut) = clip(text, if full { usize::MAX } else { DETAIL_CHARS });
        out[name] = json!(kept);
        if cut {
            truncated.push(name);
        }
    }
    if !truncated.is_empty() {
        out["truncated"] = json!(truncated);
        out["more"] = json!("call get again with full=true for the complete text");
    }
    if !task.runs.is_empty() {
        let latest: Vec<Value> = task.runs.iter().rev().take(3).map(|run| {
            let mut row = json!({ "sessionId": run.session_id, "outcome": run.outcome, "startedAt": ms_to_ts(run.started_at) });
            if let Some(note) = &run.note {
                row["note"] = json!(clip(note, 300).0);
            }
            row
        }).collect();
        out["runs"] = json!({ "total": task.runs.len(), "latest": latest });
    }
    if let Some(review) = task.reviews.last() {
        out["lastReview"] = json!({ "verdict": review.verdict, "note": clip(&review.note, 500).0, "at": ms_to_ts(review.at) });
    }
    Ok(out)
}

fn clip(text: &str, max: usize) -> (String, bool) {
    if text.chars().count() <= max {
        return (text.to_string(), false);
    }
    (text.chars().take(max).collect::<String>() + "…", true)
}

/// The shortest prefix (at least 8 characters) no other task shares.
fn short_id(all: &[ProjectTask], id: &str) -> String {
    let mut len = SHORT_ID.min(id.len());
    while len < id.len()
        && all
            .iter()
            .any(|t| t.id != id && t.id.starts_with(&id[..len]))
    {
        len += 4;
    }
    id[..len.min(id.len())].to_string()
}

fn find_task<'a>(
    all: &'a [ProjectTask],
    id: Option<&str>,
) -> Result<&'a ProjectTask, JsonRpcError> {
    let id = id
        .map(str::trim)
        .filter(|id| !id.is_empty())
        .ok_or_else(|| invalid("taskId required"))?;
    let matches: Vec<&ProjectTask> = all.iter().filter(|task| task.id.starts_with(id)).collect();
    match matches.as_slice() {
        [task] => Ok(task),
        [] => Err(rpc_err(
            1007,
            format!("no task {id} in this project"),
            "NOT_FOUND",
        )),
        _ => Err(invalid(format!(
            "taskId {id} is ambiguous; use the id from list"
        ))),
    }
}

fn resource_statuses(db: &Database, group: &ProjectGroupRecord) -> Vec<(String, ResourceStatus)> {
    resource_catalog::list(db, group)
        .map(|listing| {
            listing
                .items
                .into_iter()
                .map(|item| (item.key, item.status))
                .collect()
        })
        .unwrap_or_default()
}

// ------------------------------------------------------------ resources

fn resources(
    db: &Database,
    group: &ProjectGroupRecord,
    session_path: Option<&str>,
    request: &Request,
) -> Result<Value, JsonRpcError> {
    let refused = |error: anyhow::Error| invalid(format!("{error:#}"));
    match request.action.as_str() {
        "list" => {
            let listing = resource_catalog::list(db, group).map_err(refused)?;
            let wanted: Option<ResourceStatus> = match request.status.as_deref() {
                None | Some("all") => None,
                Some(other) => Some(serde_json::from_value(json!(other)).map_err(|_| {
                    invalid("status must be all, draft, confirmed, changed, deprecated or missing")
                })?),
            };
            let query = request.query.as_deref().unwrap_or("").trim().to_lowercase();
            let category = request
                .category
                .as_deref()
                .map(str::trim)
                .filter(|c| !c.is_empty());
            let matching: Vec<&ResourceItem> = listing
                .items
                .iter()
                .filter(|item| wanted.is_none_or(|status| item.status == status))
                .filter(|item| category.is_none_or(|c| item.category == c))
                .filter(|item| {
                    query.is_empty()
                        || item.title.to_lowercase().contains(&query)
                        || item.key.to_lowercase().contains(&query)
                })
                .collect();
            let offset = request.offset.unwrap_or(0);
            let limit = request.limit.unwrap_or(DEFAULT_LIMIT);
            let rows: Vec<Value> = matching
                .iter()
                .skip(offset)
                .take(limit)
                .map(|item| {
                    let mut row =
                        json!({ "key": item.key, "title": item.title, "status": item.status });
                    if !item.category.is_empty() {
                        row["category"] = json!(item.category);
                    }
                    row
                })
                .collect();
            let mut out =
                json!({ "counts": listing.summary, "matched": matching.len(), "resources": rows });
            if offset + limit < matching.len() {
                out["nextOffset"] = json!(offset + limit);
            }
            if listing.truncated {
                out["folderTruncated"] = json!(true);
            }
            Ok(out)
        }
        "get" => {
            let key = request
                .key
                .as_deref()
                .map(str::trim)
                .filter(|k| !k.is_empty())
                .ok_or_else(|| invalid("key required"))?;
            let listing = resource_catalog::list(db, group).map_err(refused)?;
            let item = listing.items.iter().find(|item| item.key == key);
            let mut out = json!({ "key": key });
            match item {
                Some(item) => {
                    out["title"] = json!(item.title);
                    out["status"] = json!(item.status);
                    if !item.category.is_empty() {
                        out["category"] = json!(item.category);
                    }
                    if let Some(at) = item.confirmed_at {
                        out["confirmedAt"] = json!(ms_to_ts(at));
                    }
                }
                None => out["status"] = json!(ResourceStatus::Missing),
            }
            match resource_catalog::locate(db, group, key) {
                Ok(ResourceTarget::Path(path)) => out["path"] = json!(path),
                Ok(ResourceTarget::Url(url)) => out["url"] = json!(url),
                Err(error) if item.is_none() => {
                    return Err(rpc_err(1007, format!("{error:#}"), "NOT_FOUND"))
                }
                Err(_) => {}
            }
            Ok(out)
        }
        "register" => {
            let category = request.category.as_deref().unwrap_or("");
            let title = request.title.as_deref();
            let key = match (request.path.as_deref(), request.url.as_deref()) {
                (Some(path), None) => {
                    let path = Path::new(path.trim());
                    let resolved = match session_path {
                        Some(base) if path.is_relative() => Path::new(base).join(path),
                        _ => path.to_path_buf(),
                    };
                    resource_catalog::register_file(
                        db,
                        group,
                        &resolved.to_string_lossy(),
                        category,
                        title,
                    )
                }
                (None, Some(url)) => {
                    resource_catalog::register_url(db, group, url, category, title)
                }
                _ => return Err(invalid("register needs exactly one of path or url")),
            }
            .map_err(refused)?;
            Ok(json!({ "key": key, "status": ResourceStatus::Draft }))
        }
        "goal" => {
            let goal = super::resource_catalog_rpc::read_goal(db, &group.id)?;
            let (goal, cut) = clip(
                &goal,
                if request.full.unwrap_or(false) {
                    usize::MAX
                } else {
                    GOAL_CHARS
                },
            );
            let mut out = json!({ "goal": goal });
            if cut {
                out["truncated"] = json!(["goal"]);
                out["more"] = json!("call goal again with full=true for the complete text");
            }
            Ok(out)
        }
        _ => Err(invalid(
            "resources action must be list, get, register or goal",
        )),
    }
}

#[cfg(test)]
#[path = "mc_project_work_rpc_tests.rs"]
mod tests;
