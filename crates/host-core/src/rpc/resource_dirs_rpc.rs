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

/// `project.resources.templates.save` / `.delete` (R1.4 in-app editing).
/// Both answer with the refreshed template list.
pub fn edit_template(method: &str, params: &Value) -> Result<Value, JsonRpcError> {
    let home = resource_dirs::home_dir().map_err(internal)?;
    let invalid = |error: anyhow::Error| rpc_err(1002, error.to_string(), "INVALID_PARAMS");
    if method == "project.resources.templates.delete" {
        crate::template_editor::delete(&home, required_str(params, "name")?).map_err(invalid)?;
    } else {
        let input: crate::template_editor::TemplateInput =
            serde_json::from_value(params.get("template").cloned().unwrap_or(Value::Null))
                .map_err(|error| rpc_err(1002, error.to_string(), "INVALID_PARAMS"))?;
        crate::template_editor::save(&home, &input).map_err(invalid)?;
    }
    let templates = resource_dirs::list_templates(&home).map_err(internal)?;
    Ok(json!({ "home": home.to_string_lossy(), "templates": templates }))
}

/// `project.folders.missing`: the local project folders host-core has on
/// record (projects and project-group roots) that no longer exist, so the
/// sidebar can hide stale entries. Takes no paths: the renderer cannot use it
/// to probe arbitrary locations.
pub fn missing_folders(state: &AppState) -> Result<Value, JsonRpcError> {
    let groups = state.db.list_project_groups().map_err(internal)?;
    let remote: std::collections::HashSet<String> = groups
        .iter()
        .filter(|group| group.remote.is_some())
        .flat_map(|group| group.roots.iter().map(|root| root.path.clone()))
        .collect();
    let mut known: std::collections::BTreeSet<String> = groups
        .iter()
        .filter(|group| group.remote.is_none())
        .flat_map(|group| group.roots.iter().map(|root| root.path.clone()))
        .collect();
    known.extend(
        state
            .db
            .list_projects()
            .map_err(internal)?
            .into_iter()
            .map(|project| project.path),
    );
    let missing: Vec<String> = known
        .into_iter()
        .filter(|path| !remote.contains(path))
        .filter(|path| std::path::Path::new(path).is_absolute())
        .filter(|path| !std::path::Path::new(path).is_dir())
        .collect();
    Ok(json!({ "folders": missing }))
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

/// `project.resources.ensureDraft` (MC-ADR-0023): a resource folder laid out
/// from a template the agent drafted for this project alone.
pub fn ensure_draft(state: &AppState, params: &Value) -> Result<Value, JsonRpcError> {
    let group_id = required_str(params, "groupId")?;
    let input: crate::template_editor::TemplateInput =
        serde_json::from_value(params.get("template").cloned().unwrap_or(Value::Null))
            .map_err(|error| rpc_err(1002, error.to_string(), "INVALID_PARAMS"))?;
    let home = resource_dirs::home_dir().map_err(internal)?;
    let group = crate::project_draft_template::ensure_project_resources_from_draft(
        &state.db, &home, group_id, &input,
    )
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
    let group = state.db.project_group(&context.group_id);
    // A launch refreshes the resource folder's RESOURCES.md, which the
    // project-folders note points sessions at. Best effort, like the notes.
    if let Ok(Some(group)) = &group {
        if group.resource_root().is_some() {
            let _ = crate::resource_catalog::list(&state.db, group);
        }
    }
    let notes = group.and_then(|group| match group {
        Some(group) => workspace_notes::read(&group),
        None => Ok(Vec::new()),
    });
    match notes {
        Ok(notes) => value["notes"] = json!(notes),
        Err(error) => value["notesError"] = json!(error.to_string()),
    }
    Ok(json!({ "context": value }))
}

/// `project.resources.home.*`: template metadata of a project's resource
/// folder (`meta`), recording a template as adopted (`adoptTemplate`), and
/// moving a foreign resource folder into the mc-agent home (`relocate`).
pub fn home(state: &mut AppState, method: &str, params: &Value) -> Result<Value, JsonRpcError> {
    let group = group(state, params)?;
    let home = resource_dirs::home_dir().map_err(internal)?;
    let templates = home.join("templates");
    let invalid = |error: anyhow::Error| rpc_err(1002, error.to_string(), "INVALID_PARAMS");
    match method {
        "project.resources.home.meta" => {
            let Some(resources) = group.resource_root() else {
                return Ok(json!({ "status": null }));
            };
            let status = crate::resource_templates::project_template_status(
                std::path::Path::new(&resources.path),
                &templates,
            )
            .map_err(internal)?;
            Ok(json!({ "status": status }))
        }
        "project.resources.home.adoptTemplate" => {
            let name = required_str(params, "template")?;
            if name.contains(['/', '\\']) || name.starts_with('.') {
                return Err(rpc_err(1002, "invalid template name", "INVALID_PARAMS"));
            }
            let resources = group
                .resource_root()
                .ok_or_else(|| rpc_err(1002, "project has no resource folder", "INVALID_PARAMS"))?;
            let source = templates.join(name);
            if !source.is_dir() {
                return Err(rpc_err(
                    1002,
                    format!("template not found: {name}"),
                    "INVALID_PARAMS",
                ));
            }
            let meta = crate::resource_templates::record_project_template(
                std::path::Path::new(&resources.path),
                name,
                &source,
            )
            .map_err(internal)?;
            Ok(json!({ "recorded": meta }))
        }
        "project.resources.home.setRootKind" => {
            let kind: crate::db::ProjectGroupRootKind =
                serde_json::from_value(params.get("kind").cloned().unwrap_or(Value::Null))
                    .map_err(|error| rpc_err(1002, error.to_string(), "INVALID_PARAMS"))?;
            let group = state
                .db
                .set_project_root_kind(&group.id, required_str(params, "path")?, kind)
                .map_err(invalid)?;
            Ok(json!({ "group": group }))
        }
        "project.resources.home.detach" => {
            let group =
                resource_dirs::detach_project_resources(&state.db, &group.id).map_err(invalid)?;
            Ok(json!({ "group": group }))
        }
        "project.resources.home.relocate" => {
            let moved =
                resource_dirs::relocate_into_home(&state.db, &home, &group.id).map_err(invalid)?;
            if let Some(moved) = &moved {
                if state
                    .workspace
                    .get()
                    .is_some_and(|workspace| workspace.path == moved.from)
                {
                    state.workspace.set(&moved.to);
                }
            }
            let group = state.db.project_group(&group.id).map_err(internal)?;
            Ok(json!({ "group": group, "resourcesMoved": moved }))
        }
        _ => Err(rpc_err(
            -32601,
            format!("method not found: {method}"),
            "NOT_FOUND",
        )),
    }
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

/// Before a project rename: refuse while a session in its resource folder is
/// running (R1.3). A save that keeps the name is never blocked.
pub fn rename_guard(state: &AppState, group_id: &str, new_name: &str) -> Result<(), JsonRpcError> {
    let current = state.db.project_group(group_id).map_err(internal)?;
    if current.is_none_or(|group| group.name == new_name.trim()) {
        return Ok(());
    }
    resource_dirs::ensure_rename_allowed(&state.db, group_id)
        .map_err(|error| rpc_err(1008, error.to_string(), "CONFLICT"))
}

/// After a project rename: move its resource folder to follow the new name.
/// The rename itself already succeeded, so a failed move is reported in
/// `resourcesRenameError` with the folder left where it was.
pub fn after_rename(
    state: &mut AppState,
    group: crate::db::ProjectGroupRecord,
) -> Result<Value, JsonRpcError> {
    let moved = resource_dirs::home_dir()
        .and_then(|home| resource_dirs::follow_project_name(&state.db, &home, &group.id));
    match moved {
        Ok(Some(moved)) => {
            if state
                .workspace
                .get()
                .is_some_and(|workspace| workspace.path == moved.from)
            {
                state.workspace.set(&moved.to);
            }
            let group = state
                .db
                .project_group(&group.id)
                .map_err(internal)?
                .unwrap_or(group);
            Ok(json!({ "group": group, "resourcesMoved": moved }))
        }
        Ok(None) => Ok(json!({ "group": group })),
        Err(error) => Ok(json!({ "group": group, "resourcesRenameError": error.to_string() })),
    }
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
