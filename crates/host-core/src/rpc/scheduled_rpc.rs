use super::{json, plan_rpc_err, rpc_err, AppState, JsonRpcError, Value};
use crate::{scheduled, sessions};

#[cfg(test)]
#[path = "scheduled_project_tests.rs"]
mod project_tests;

pub(super) fn handle(st: &AppState, method: &str, params: Value) -> Result<Value, JsonRpcError> {
    handle_with_workspace_policy(
        st,
        method,
        params,
        st.workspace.get().map(|workspace| workspace.path),
        true,
    )
}

pub(super) fn handle_in_workspace(
    st: &AppState,
    method: &str,
    params: Value,
    workspace: Option<String>,
) -> Result<Value, JsonRpcError> {
    handle_with_workspace_policy(st, method, params, workspace, false)
}

fn handle_with_workspace_policy(
    st: &AppState,
    method: &str,
    params: Value,
    workspace: Option<String>,
    allow_workspace_override: bool,
) -> Result<Value, JsonRpcError> {
    match method {
        "scheduled.list" => {
            let tasks = scheduled::list_tasks(&st.db)
                .map_err(|e| rpc_err(1000, e.to_string(), "INTERNAL"))?;
            Ok(json!({ "tasks": tasks }))
        }
        "scheduled.create" => {
            let mut params = params;
            if !params.is_object() {
                return Err(rpc_err(1002, "task must be an object", "INVALID_PARAMS"));
            }
            validate_schedule_input(&params)?;
            if params.get("providerId").is_none() && params.get("modelId").is_none() {
                let settings = st
                    .db
                    .get_setting("app")
                    .map_err(|e| rpc_err(1000, e.to_string(), "INTERNAL"))?;
                if let Some(model) = settings
                    .as_ref()
                    .and_then(|s| s["scheduledDefaultModel"].as_object())
                {
                    for key in ["providerId", "modelId", "thinkingLevel"] {
                        if let Some(value) = model.get(key).filter(|_| params.get(key).is_none()) {
                            params[key] = value.clone();
                        }
                    }
                }
            }
            validate_execution_input(&params)?;
            if !allow_workspace_override {
                if let Some(object) = params.as_object_mut() {
                    object.remove("workspacePath");
                }
            }
            if params.get("schedule").is_some() && params.get("workspacePath").is_none() {
                params["workspacePath"] = json!(workspace);
            }
            let task = scheduled::create_task(&st.db, &params)
                .map_err(|e| rpc_err(1000, e.to_string(), "INTERNAL"))?;
            Ok(json!({ "task": task }))
        }
        "scheduled.update" => {
            let mut params = params;
            validate_schedule_input(&params)?;
            validate_execution_input(&params)?;
            if matches!(
                params.get("cadence").and_then(Value::as_str),
                Some("daily" | "weekly")
            ) && params.get("schedule").is_none()
            {
                let id = params.get("id").and_then(Value::as_str).unwrap_or("");
                let existing = scheduled::get_task(&st.db, id)
                    .map_err(|e| rpc_err(1000, e.to_string(), "INTERNAL"))?;
                if existing.is_some_and(|task| task.schedule.is_some() && !task.calendar_configured)
                {
                    return Err(rpc_err(1002,
                        "Confirm a calendar time and provide schedule when changing this task to Daily or Weekly",
                        "INVALID_PARAMS"));
                }
            }
            if params.get("schedule").is_some() {
                let id = params.get("id").and_then(Value::as_str).unwrap_or("");
                let existing = scheduled::get_task(&st.db, id)
                    .map_err(|e| rpc_err(1000, e.to_string(), "INTERNAL"))?;
                if allow_workspace_override && params.get("workspacePath").is_some() {
                    // The desktop form may explicitly move a task to another
                    // saved project. Conversation tools stay project-scoped.
                } else if existing
                    .as_ref()
                    .is_some_and(|task| !task.workspace_bound && task.schedule.is_none())
                {
                    params["workspacePath"] = json!(workspace);
                } else if let Some(object) = params.as_object_mut() {
                    object.remove("workspacePath");
                }
            }
            let task = scheduled::update_task(&st.db, &params)
                .map_err(|e| rpc_err(1000, e.to_string(), "INTERNAL"))?
                .ok_or_else(|| rpc_err(1007, "task not found", "NOT_FOUND"))?;
            Ok(json!({ "task": task }))
        }
        "scheduled.delete" => {
            let id = params
                .get("id")
                .and_then(|v| v.as_str())
                .ok_or_else(|| rpc_err(1002, "id required", "INVALID_PARAMS"))?;
            let ok = scheduled::delete_task(&st.db, id)
                .map_err(|e| rpc_err(1000, e.to_string(), "INTERNAL"))?;
            Ok(json!({ "ok": ok }))
        }
        "scheduled.import" => {
            let tasks = params
                .get("tasks")
                .and_then(|v| v.as_array())
                .cloned()
                .unwrap_or_default();
            let imported = scheduled::import_tasks(&st.db, &tasks)
                .map_err(|e| rpc_err(1000, e.to_string(), "INTERNAL"))?;
            Ok(json!({ "imported": imported }))
        }
        "scheduled.run" => {
            if params
                .get("automatic")
                .is_some_and(|value| !value.is_boolean())
            {
                return Err(rpc_err(
                    1002,
                    "automatic must be a boolean",
                    "INVALID_PARAMS",
                ));
            }
            let id = params
                .get("id")
                .and_then(|v| v.as_str())
                .ok_or_else(|| rpc_err(1002, "id required", "INVALID_PARAMS"))?;
            let task = scheduled::get_task(&st.db, id)
                .map_err(|e| rpc_err(1000, e.to_string(), "INTERNAL"))?
                .ok_or_else(|| rpc_err(1007, "task not found", "NOT_FOUND"))?;
            let automatic = params
                .get("automatic")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            let now = crate::db::now_ms();
            if scheduled::automation::running(&st.db, id)
                .map_err(|e| rpc_err(1000, e.to_string(), "INTERNAL"))?
            {
                return Err(rpc_err(
                    1002,
                    "task is already running",
                    "SCHEDULE_ALREADY_RUNNING",
                ));
            }
            if automatic
                && (!task.enabled
                    || !scheduled::automation::due(&st.db, now)
                        .map_err(|e| rpc_err(1000, e.to_string(), "INTERNAL"))?
                        .iter()
                        .any(|due| due == id))
            {
                return Err(rpc_err(1002, "task is no longer due", "SCHEDULE_NOT_DUE"));
            }
            if automatic {
                scheduled::automation::reschedule(&st.db, id, now)
                    .map_err(|e| rpc_err(1000, e.to_string(), "INTERNAL"))?;
            }
            // Both contract modes need a human to approve their proposal (D198),
            // so neither can run unattended.
            if sessions::is_contract_mode(&task.mode) {
                return Err(plan_rpc_err("PLAN_REQUIRES_INTERACTIVE_SESSION"));
            }
            let settings = st
                .db
                .get_setting("app")
                .map_err(|e| rpc_err(1000, e.to_string(), "INTERNAL"))?
                .unwrap_or_else(|| json!({}));
            let options = sessions::SessionCreateOptions {
                title: Some(task.title.clone()),
                mode: Some("agent".into()),
                thinking_level: task.thinking_level.clone(),
                provider_id: task.provider_id.clone().or_else(|| {
                    settings
                        .get("defaultProviderId")
                        .and_then(|v| v.as_str())
                        .map(str::to_string)
                }),
                model_id: task.model_id.clone().or_else(|| {
                    settings
                        .get("defaultModelId")
                        .and_then(|v| v.as_str())
                        .map(str::to_string)
                }),
                project_path: if task.workspace_bound || task.schedule.is_some() {
                    task.workspace_path.clone()
                } else {
                    st.workspace.get().map(|w| w.path)
                },
                permission_mode: task
                    .permission_mode
                    .clone()
                    .or_else(|| automatic.then(|| "ask".into())),
            };
            let uses_task_execution_settings = task.permission_mode.is_some()
                || task.thinking_level.is_some()
                || (task.provider_id.is_some() && task.model_id.is_some());
            // A `reuse` task continues its own previous conversation, but only
            // while that conversation still exists and still belongs to the same
            // project; a deleted one, or a re-pointed task, opens a fresh one.
            let target_project = options.project_path.clone();
            let reused = if task.session_mode == "reuse" {
                scheduled::reusable_session(&st.db, id, target_project.as_deref())
                    .map_err(|e| rpc_err(1000, e.to_string(), "INTERNAL"))?
            } else {
                None
            };
            let starting_fresh = reused.is_none();
            let session_id = match reused {
                Some(session_id) => {
                    if let Some(permission) = options.permission_mode.as_deref() {
                        let mode = sessions::session_mode(&st.db, &session_id)
                            .map_err(|e| rpc_err(1000, e.to_string(), "INTERNAL"))?
                            .ok_or_else(|| rpc_err(1007, "session not found", "NOT_FOUND"))?;
                        if sessions::is_contract_mode(&mode) {
                            return Err(plan_rpc_err("PLAN_REQUIRES_INTERACTIVE_SESSION"));
                        }
                        sessions::configure_session_with_thinking(
                            &st.db,
                            &session_id,
                            &mode,
                            None,
                            None,
                            None,
                            Some(permission),
                        )
                        .map_err(|e| rpc_err(1002, e.to_string(), "INVALID_PARAMS"))?
                        .ok_or_else(|| rpc_err(1007, "session not found", "NOT_FOUND"))?;
                    }
                    session_id
                }
                None => {
                    let session = if automatic || uses_task_execution_settings {
                        sessions::create_session_with_options(&st.db, options)
                    } else {
                        sessions::create_session(
                            &st.db,
                            options.title,
                            options.mode,
                            options.provider_id,
                            options.model_id,
                            options.project_path,
                        )
                    }
                    .map_err(|e| rpc_err(1000, e.to_string(), "INTERNAL"))?;
                    session.id
                }
            };
            let run_id = match scheduled::begin_run(&st.db, id, Some(&session_id)) {
                Ok(run_id) => run_id,
                Err(error) => {
                    // Only a conversation this dispatch opened is cleaned up.
                    if starting_fresh {
                        let _ = sessions::delete_session(&st.db, &session_id);
                    }
                    return Err(rpc_err(1000, error.to_string(), "INTERNAL"));
                }
            };
            let task = scheduled::get_task(&st.db, id)
                .map_err(|e| rpc_err(1000, e.to_string(), "INTERNAL"))?
                .unwrap_or(task);
            Ok(json!({
                "sessionId": session_id,
                "prompt": task.prompt,
                "task": task,
                "runId": run_id
            }))
        }
        "scheduled.due" => {
            let ids = scheduled::automation::due(&st.db, crate::db::now_ms())
                .map_err(|e| rpc_err(1000, e.to_string(), "INTERNAL"))?;
            Ok(json!({ "ids": ids }))
        }
        "scheduled.finishRun" => {
            let run_id = params
                .get("runId")
                .and_then(|v| v.as_str())
                .ok_or_else(|| rpc_err(1002, "runId required", "INVALID_PARAMS"))?;
            let status = params
                .get("status")
                .and_then(|v| v.as_str())
                .unwrap_or("completed");
            let ok = scheduled::finish_run(
                &st.db,
                run_id,
                status,
                params.get("errorCode").and_then(|v| v.as_str()),
            )
            .map_err(|e| rpc_err(1000, e.to_string(), "INTERNAL"))?;
            Ok(json!({ "ok": ok }))
        }
        "scheduled.listRuns" => {
            let task_id = params.get("taskId").and_then(|v| v.as_str());
            // The task column needs each task's own newest run: a global window
            // would report an idle task as "never run" once other tasks fill it.
            if params
                .get("latestPerTask")
                .and_then(Value::as_bool)
                .unwrap_or(false)
            {
                if task_id.is_some() {
                    return Err(rpc_err(
                        1002,
                        "latestPerTask cannot be scoped to a single task",
                        "INVALID_PARAMS",
                    ));
                }
                let runs = scheduled::latest_run_per_task(&st.db)
                    .map_err(|e| rpc_err(1000, e.to_string(), "INTERNAL"))?;
                return Ok(json!({ "runs": runs }));
            }
            let limit = params.get("limit").and_then(|v| v.as_i64()).unwrap_or(50);
            let runs = scheduled::list_runs(&st.db, task_id, limit)
                .map_err(|e| rpc_err(1000, e.to_string(), "INTERNAL"))?;
            Ok(json!({ "runs": runs }))
        }

        _ => Err(rpc_err(1007, "unknown scheduled method", "NOT_FOUND")),
    }
}

fn validate_schedule_input(params: &Value) -> Result<(), JsonRpcError> {
    if let Some(schedule) = params.get("schedule").filter(|value| !value.is_null()) {
        let parsed: scheduled::timing::Schedule = serde_json::from_value(schedule.clone())
            .map_err(|e| rpc_err(1002, e.to_string(), "INVALID_PARAMS"))?;
        parsed
            .validate()
            .map_err(|e| rpc_err(1002, e.to_string(), "INVALID_PARAMS"))?;
        if params
            .get("prompt")
            .and_then(Value::as_str)
            .is_some_and(|prompt| prompt.trim().is_empty())
        {
            return Err(rpc_err(1002, "prompt required", "INVALID_PARAMS"));
        }
    }
    Ok(())
}

fn validate_execution_input(params: &Value) -> Result<(), JsonRpcError> {
    scheduled::automation::validate_execution_input(params)
        .map_err(|error| rpc_err(1002, error.to_string(), "INVALID_PARAMS"))
}

#[cfg(test)]
#[path = "scheduled_rpc_tests.rs"]
mod tests;
