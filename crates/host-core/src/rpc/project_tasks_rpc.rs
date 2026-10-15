//! Project task RPC surface (mc-agent R6–R9): every `project.tasks.*`
//! method. The rules live in `crate::project_tasks`; this module owns the
//! wire shapes and maps the domain's coded errors.

use serde_json::{json, Value};

use super::{rpc_err, AppState, JsonRpcError};
use crate::project_tasks::{self, TaskInput, Verdict};

pub fn handle(state: &AppState, method: &str, params: &Value) -> Result<Value, JsonRpcError> {
    let group_id = required(params, "groupId")?;
    let group = state
        .db
        .project_group(group_id)
        .map_err(|error| rpc_err(1000, error.to_string(), "INTERNAL"))?
        .ok_or_else(|| rpc_err(1007, "project group not found", "NOT_FOUND"))?;
    let db = &state.db;
    let result = match method {
        "project.tasks.list" => {
            project_tasks::list(db, &group).map(|tasks| json!({ "tasks": tasks }))
        }
        "project.tasks.create" => {
            project_tasks::create(db, &group, input(params)?).map(|task| json!({ "task": task }))
        }
        "project.tasks.update" => project_tasks::update(
            db,
            &group,
            required(params, "taskId")?,
            revision(params)?,
            input(params)?,
        )
        .map(|task| json!({ "task": task })),
        "project.tasks.cancel" => {
            project_tasks::cancel(db, &group, required(params, "taskId")?, revision(params)?)
                .map(|task| json!({ "task": task }))
        }
        "project.tasks.reopen" => {
            project_tasks::reopen(db, &group, required(params, "taskId")?, revision(params)?)
                .map(|task| json!({ "task": task }))
        }
        "project.tasks.preflight" => {
            project_tasks::preflight(db, &group, required(params, "taskId")?)
                .map(|preflight| json!(preflight))
        }
        "project.tasks.startRun" => project_tasks::start_run(
            db,
            &group,
            required(params, "taskId")?,
            revision(params)?,
            required(params, "sessionId")?,
            required(params, "startFolder")?,
        )
        .map(|task| json!({ "task": task })),
        "project.tasks.review" => {
            let verdict: Verdict =
                serde_json::from_value(params.get("verdict").cloned().unwrap_or(Value::Null))
                    .map_err(|error| rpc_err(1002, error.to_string(), "INVALID_PARAMS"))?;
            project_tasks::review(
                db,
                &group,
                required(params, "taskId")?,
                revision(params)?,
                verdict,
                params.get("note").and_then(Value::as_str).unwrap_or(""),
            )
            .map(|task| json!({ "task": task }))
        }
        _ => {
            return Err(rpc_err(
                -32601,
                format!("method not found: {method}"),
                "NOT_FOUND",
            ))
        }
    };
    result.map_err(coded)
}

/// The domain prefixes its refusals with a code; anything else is internal.
fn coded(error: anyhow::Error) -> JsonRpcError {
    let message = format!("{error:#}");
    let (code, kind) = match message.split(':').next().unwrap_or("") {
        "INVALID_ARGUMENT" => (1002, "INVALID_PARAMS"),
        "NOT_FOUND" => (1007, "NOT_FOUND"),
        "CONFLICT" => (1008, "CONFLICT"),
        "RESOURCES_BLOCKED" => (1008, "RESOURCES_BLOCKED"),
        "PERMISSION_DENIED" => (1004, "PERMISSION_DENIED"),
        _ => (1000, "INTERNAL"),
    };
    rpc_err(code, message, kind)
}

fn input(params: &Value) -> Result<TaskInput, JsonRpcError> {
    serde_json::from_value(params.get("task").cloned().unwrap_or(Value::Null))
        .map_err(|error| rpc_err(1002, error.to_string(), "INVALID_PARAMS"))
}

fn revision(params: &Value) -> Result<u64, JsonRpcError> {
    params
        .get("revision")
        .and_then(Value::as_u64)
        .ok_or_else(|| rpc_err(1002, "revision required", "INVALID_PARAMS"))
}

fn required<'a>(params: &'a Value, key: &str) -> Result<&'a str, JsonRpcError> {
    params
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| rpc_err(1002, format!("{key} required"), "INVALID_PARAMS"))
}
