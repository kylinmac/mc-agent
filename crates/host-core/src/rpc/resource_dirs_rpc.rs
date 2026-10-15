//! Resource-directory RPC surface (mc-agent, MC-ADR-0003).
//!
//! `project.resources.templates` lists templates; `project.resources.ensure`
//! gives a project its resource directory if it has none;
//! `project.workspaces.notes` / `project.workspaces.setNote` read and edit the
//! workspace descriptions kept in that directory (R10). Kept beside the
//! shared dispatcher so `rpc::mod` only registers the methods; the rules live
//! in `crate::resource_dirs`.

use serde_json::{json, Value};

use super::{rpc_err, AppState, JsonRpcError};
use crate::{resource_dirs, workspace_notes};

pub fn templates(_state: &AppState) -> Result<Value, JsonRpcError> {
    let home = resource_dirs::home_dir().map_err(internal)?;
    let templates = resource_dirs::list_templates(&home).map_err(internal)?;
    Ok(json!({ "home": home.to_string_lossy(), "templates": templates }))
}

pub fn ensure(state: &AppState, params: &Value) -> Result<Value, JsonRpcError> {
    let group_id = required_str(params, "groupId")?;
    let template = match params.get("template") {
        None | Some(Value::Null) => resource_dirs::DEFAULT_TEMPLATE,
        Some(Value::String(name)) => name.as_str(),
        Some(_) => return Err(rpc_err(1002, "template must be a string", "INVALID_PARAMS")),
    };
    let home = resource_dirs::home_dir().map_err(internal)?;
    let group = resource_dirs::ensure_project_resources(&state.db, &home, group_id, template)
        .map_err(|error| rpc_err(1002, error.to_string(), "INVALID_PARAMS"))?;
    Ok(json!({ "group": group }))
}

/// `project.group.context`: the upstream group context plus the workspace
/// descriptions from the resource directory (R10), which every launch path
/// renders into the project-folders note. Descriptions are best effort: a
/// read failure is reported in `notesError` and never blocks a launch.
pub fn group_context(state: &AppState, path: &str) -> Result<Value, JsonRpcError> {
    let context = state
        .db
        .project_group_context_for_path(path)
        .map_err(|error| rpc_err(1002, error.to_string(), "INVALID_PARAMS"))?;
    let Some(context) = context else {
        return Ok(json!({ "context": null }));
    };
    let mut value = serde_json::to_value(&context).map_err(|error| internal(error.into()))?;
    let notes = state
        .db
        .project_group(&context.group_id)
        .and_then(|group| match group {
            Some(group) => workspace_notes::read(&group),
            None => Ok(Vec::new()),
        });
    match notes {
        Ok(notes) => value["notes"] = json!(notes),
        Err(error) => value["notesError"] = json!(error.to_string()),
    }
    Ok(json!({ "context": value }))
}

pub fn notes(state: &AppState, params: &Value) -> Result<Value, JsonRpcError> {
    let group = group(state, params)?;
    let notes = workspace_notes::read(&group).map_err(internal)?;
    Ok(json!({ "notes": notes }))
}

pub fn set_note(state: &AppState, params: &Value) -> Result<Value, JsonRpcError> {
    let group = group(state, params)?;
    let path = required_str(params, "path")?;
    let description = params
        .get("description")
        .and_then(Value::as_str)
        .ok_or_else(|| rpc_err(1002, "description required", "INVALID_PARAMS"))?;
    let note = workspace_notes::write(&group, path, description)
        .map_err(|error| rpc_err(1002, error.to_string(), "INVALID_PARAMS"))?;
    Ok(json!({ "note": note }))
}

fn group(state: &AppState, params: &Value) -> Result<crate::db::ProjectGroupRecord, JsonRpcError> {
    let group_id = required_str(params, "groupId")?;
    state
        .db
        .project_group(group_id)
        .map_err(internal)?
        .ok_or_else(|| rpc_err(1007, "project group not found", "NOT_FOUND"))
}

fn required_str<'a>(params: &'a Value, key: &str) -> Result<&'a str, JsonRpcError> {
    params
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| rpc_err(1002, format!("{key} required"), "INVALID_PARAMS"))
}

fn internal(error: anyhow::Error) -> JsonRpcError {
    rpc_err(1000, error.to_string(), "INTERNAL")
}
