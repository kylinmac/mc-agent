use std::path::PathBuf;

use serde_json::{json, Value};
use tokio::sync::Mutex;

use super::{
    drop_session_side_data, mc_memory_rpc, project_tasks_rpc, resource_catalog_rpc,
    resource_dirs_rpc, rpc_err, JsonRpcError,
};
use crate::{sessions, state::AppState};

pub(super) async fn handle(
    state: &Mutex<AppState>,
    method: &str,
    params: Value,
) -> Result<Value, JsonRpcError> {
    match method {
        "workspace.get" => {
            let st = state.lock().await;
            Ok(json!({ "workspace": st.workspace.get() }))
        }
        "projects.list" => {
            let st = state.lock().await;
            let projects = st
                .db
                .list_projects()
                .map_err(|e| rpc_err(1000, e.to_string(), "INTERNAL"))?;
            Ok(json!({ "projects": projects }))
        }
        "project.groups.list" => {
            let st = state.lock().await;
            let groups = st
                .db
                .list_project_groups()
                .map_err(|e| rpc_err(1000, e.to_string(), "INTERNAL"))?;
            Ok(json!({ "groups": groups }))
        }
        "project.group.createRemote" => {
            let name = params
                .get("name")
                .and_then(Value::as_str)
                .ok_or_else(|| rpc_err(1002, "name required", "INVALID_PARAMS"))?;
            let remote: crate::db::RemoteWorkspace =
                serde_json::from_value(params.get("remote").cloned().unwrap_or(Value::Null))
                    .map_err(|e| rpc_err(1002, e.to_string(), "INVALID_PARAMS"))?;
            let st = state.lock().await;
            let group = st
                .db
                .create_remote_project_group(name, remote)
                .map_err(|e| rpc_err(1002, e.to_string(), "INVALID_PARAMS"))?;
            Ok(json!({ "group": group }))
        }
        "project.group.create" => {
            let name = params
                .get("name")
                .and_then(Value::as_str)
                .ok_or_else(|| rpc_err(1002, "name required", "INVALID_PARAMS"))?;
            let folders = params
                .get("folders")
                .and_then(Value::as_array)
                .ok_or_else(|| rpc_err(1002, "folders required", "INVALID_PARAMS"))?
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect::<Vec<_>>();
            let st = state.lock().await;
            let group = st
                .db
                .create_project_group(name, &folders)
                .map_err(|e| rpc_err(1002, e.to_string(), "INVALID_PARAMS"))?;
            Ok(json!({ "group": group }))
        }
        "project.group.update" => {
            let group_id = params
                .get("groupId")
                .and_then(Value::as_str)
                .ok_or_else(|| rpc_err(1002, "groupId required", "INVALID_PARAMS"))?;
            let name = params
                .get("name")
                .and_then(Value::as_str)
                .ok_or_else(|| rpc_err(1002, "name required", "INVALID_PARAMS"))?;
            let folders = params
                .get("folders")
                .and_then(Value::as_array)
                .ok_or_else(|| rpc_err(1002, "folders required", "INVALID_PARAMS"))?
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect::<Vec<_>>();
            let primary = params.get("primary").and_then(Value::as_str);
            let mut st = state.lock().await;
            resource_dirs_rpc::rename_guard(&st, group_id, name)?;
            let group = st
                .db
                .update_project_group(group_id, name, &folders, primary)
                .map_err(|e| rpc_err(1002, e.to_string(), "INVALID_PARAMS"))?;
            resource_dirs_rpc::after_rename(&mut st, group)
        }
        "project.resources.templates" => {
            let st = state.lock().await;
            resource_dirs_rpc::templates(&st)
        }
        "project.resources.templates.save" | "project.resources.templates.delete" => {
            let _st = state.lock().await;
            resource_dirs_rpc::edit_template(method, &params)
        }
        "project.folders.missing" => {
            let st = state.lock().await;
            resource_dirs_rpc::missing_folders(&st)
        }
        "project.resources.ensure" => {
            let st = state.lock().await;
            resource_dirs_rpc::ensure(&st, &params)
        }
        "project.resources.ensureDraft" => {
            let st = state.lock().await;
            resource_dirs_rpc::ensure_draft(&st, &params)
        }
        method if method.starts_with("project.resources.home.") => {
            let mut st = state.lock().await;
            resource_dirs_rpc::home(&mut st, method, &params)
        }
        method if method.starts_with("project.tasks.") => {
            let st = state.lock().await;
            project_tasks_rpc::handle(&st, method, &params)
        }
        method if method.starts_with("project.resources.catalog.") => {
            let st = state.lock().await;
            resource_catalog_rpc::handle(&st, method, &params)
        }
        "project.workspaces.notes" => {
            let st = state.lock().await;
            resource_dirs_rpc::notes(&st, &params)
        }
        "project.workspaces.setNote" => {
            let st = state.lock().await;
            resource_dirs_rpc::set_note(&st, &params)
        }
        "project.group.rename" => {
            let id = params
                .get("groupId")
                .and_then(Value::as_str)
                .ok_or_else(|| rpc_err(1002, "groupId required", "INVALID_PARAMS"))?;
            let name = params
                .get("name")
                .and_then(Value::as_str)
                .ok_or_else(|| rpc_err(1002, "name required", "INVALID_PARAMS"))?;
            let mut st = state.lock().await;
            resource_dirs_rpc::rename_guard(&st, id, name)?;
            let group = st
                .db
                .rename_project_group(id, name)
                .map_err(|e| rpc_err(1002, e.to_string(), "INVALID_PARAMS"))?;
            resource_dirs_rpc::after_rename(&mut st, group)
        }
        "project.group.memory.get" => {
            let id = params
                .get("groupId")
                .and_then(Value::as_str)
                .ok_or_else(|| rpc_err(1002, "groupId required", "INVALID_PARAMS"))?;
            let st = state.lock().await;
            let memory = st
                .db
                .get_project_group_memory(id)
                .map_err(|e| rpc_err(1002, e.to_string(), "INVALID_PARAMS"))?;
            Ok(json!({ "memory": memory }))
        }
        "project.group.memory.set" => {
            let id = params
                .get("groupId")
                .and_then(Value::as_str)
                .ok_or_else(|| rpc_err(1002, "groupId required", "INVALID_PARAMS"))?;
            let entries = params
                .get("entries")
                .ok_or_else(|| rpc_err(1002, "entries required", "INVALID_PARAMS"))?;
            let st = state.lock().await;
            if let Some(expected) = params.get("expectedMemory") {
                let current = st
                    .db
                    .get_project_group_memory(id)
                    .map_err(|e| rpc_err(1002, e.to_string(), "INVALID_PARAMS"))?;
                mc_memory_rpc::check_expected(expected, current)?;
            }
            let memory = st
                .db
                .set_project_group_memory(id, entries)
                .map_err(|e| rpc_err(1002, e.to_string(), "INVALID_PARAMS"))?;
            Ok(json!({ "memory": memory }))
        }
        "project.group.instructions.get" => {
            let id = params
                .get("groupId")
                .and_then(Value::as_str)
                .ok_or_else(|| rpc_err(1002, "groupId required", "INVALID_PARAMS"))?;
            let st = state.lock().await;
            let content = st
                .db
                .get_project_group_instructions(id)
                .map_err(|e| rpc_err(1002, e.to_string(), "INVALID_PARAMS"))?;
            Ok(json!({ "content": content }))
        }
        "project.group.instructions.set" => {
            let id = params
                .get("groupId")
                .and_then(Value::as_str)
                .ok_or_else(|| rpc_err(1002, "groupId required", "INVALID_PARAMS"))?;
            let content = params
                .get("content")
                .and_then(Value::as_str)
                .ok_or_else(|| rpc_err(1002, "content required", "INVALID_PARAMS"))?;
            let st = state.lock().await;
            let content = st
                .db
                .set_project_group_instructions(id, content)
                .map_err(|e| rpc_err(1002, e.to_string(), "INVALID_PARAMS"))?;
            Ok(json!({ "content": content }))
        }
        "project.group.context" => {
            let path = params
                .get("path")
                .and_then(Value::as_str)
                .ok_or_else(|| rpc_err(1002, "path required", "INVALID_PARAMS"))?;
            let st = state.lock().await;
            resource_dirs_rpc::group_context(&st, path)
        }
        "projects.create" => {
            let path = params
                .get("path")
                .and_then(|v| v.as_str())
                .ok_or_else(|| rpc_err(1002, "path required", "INVALID_PARAMS"))?;
            let st = state.lock().await;
            let id = st
                .db
                .ensure_project(path, false)
                .map_err(|e| rpc_err(1002, e.to_string(), "INVALID_PARAMS"))?;
            let project = st
                .db
                .get_project(id)
                .map_err(|e| rpc_err(1000, e.to_string(), "INTERNAL"))?
                .ok_or_else(|| rpc_err(1000, "project disappeared after creation", "INTERNAL"))?;
            Ok(json!({ "project": project }))
        }

        "projects.remove" => {
            let path = params
                .get("path")
                .and_then(|v| v.as_str())
                .ok_or_else(|| rpc_err(1002, "path required", "INVALID_PARAMS"))?;
            let path = crate::db::canonical_project_path(path)
                .ok_or_else(|| rpc_err(1002, "path required", "INVALID_PARAMS"))?;
            let st = state.lock().await;
            let transaction = st
                .db
                .conn()
                .unchecked_transaction()
                .map_err(|e| rpc_err(1000, e.to_string(), "INTERNAL"))?;
            if crate::scheduled::project::has_running_tasks(&st.db, &path)
                .map_err(|e| rpc_err(1000, e.to_string(), "INTERNAL"))?
            {
                return Err(rpc_err(
                    1008,
                    "project has running scheduled tasks",
                    "CONFLICT",
                ));
            }
            let session_ids = st
                .db
                .project_session_ids(&path)
                .map_err(|e| rpc_err(1000, e.to_string(), "INTERNAL"))?;
            // A running turn still owns its session's tools and working
            // directory and is still writing to that session's transcript, so
            // the bulk delete waits until every attached session is idle.
            for id in &session_ids {
                if sessions::session_has_running_turn(&st.db, id)
                    .map_err(|e| rpc_err(1000, e.to_string(), "INTERNAL"))?
                {
                    return Err(rpc_err(1008, "project has running sessions", "CONFLICT"));
                }
            }
            // Check for a running session before changing group membership.
            // A busy project must remain in its original group.
            // Once the project is known to be idle, detach its root as part of
            // this delete because the group editor keeps its primary root
            // fixed and preserves chats on detached non-primary roots (#1358).
            // If the primary is removed, the first remaining root becomes primary. A
            // single-folder group is just a wrapper around one project, so
            // deleting that project also removes the now-empty group record.
            if let Some(group) = st
                .db
                .stored_project_group_for_path(&path)
                .map_err(|e| rpc_err(1000, e.to_string(), "INTERNAL"))?
            {
                if group.roots.len() > 1 {
                    st.db
                        .remove_project_from_group(&group.id, &path)
                        .map_err(|e| rpc_err(1000, e.to_string(), "INTERNAL"))?;
                } else {
                    st.db
                        .delete_project_group_record(&group.id)
                        .map_err(|e| rpc_err(1000, e.to_string(), "INTERNAL"))?;
                }
            }
            crate::scheduled::project::pause(&st.db, &transaction, &path)
                .map_err(|e| rpc_err(1000, e.to_string(), "INTERNAL"))?;
            let mut removed_ids = Vec::new();
            for id in &session_ids {
                if sessions::delete_session_row(&st.db, id)
                    .map_err(|e| rpc_err(1000, e.to_string(), "INTERNAL"))?
                {
                    removed_ids.push(id);
                }
            }
            let removed = st
                .db
                .delete_project(&path)
                .map_err(|e| rpc_err(1000, e.to_string(), "INTERNAL"))?;
            st.db
                .delete_project_memory(&path)
                .map_err(|e| rpc_err(1000, e.to_string(), "INTERNAL"))?;
            transaction
                .commit()
                .map_err(|e| rpc_err(1000, e.to_string(), "INTERNAL"))?;
            for id in &removed_ids {
                sessions::remove_deleted_session_files(&st.db, id);
                drop_session_side_data(&st, id);
            }
            Ok(json!({ "removed": removed, "sessionsRemoved": removed_ids.len() }))
        }
        "project.memory.get" => {
            let path = params
                .get("path")
                .and_then(|v| v.as_str())
                .ok_or_else(|| rpc_err(1002, "path required", "INVALID_PARAMS"))?;
            let st = state.lock().await;
            let memory = st
                .db
                .get_project_memory(path)
                .map_err(|e| rpc_err(1002, e.to_string(), "INVALID_PARAMS"))?;
            Ok(json!({ "memory": memory }))
        }
        "project.memory.set" => {
            let path = params
                .get("path")
                .and_then(|v| v.as_str())
                .ok_or_else(|| rpc_err(1002, "path required", "INVALID_PARAMS"))?;
            let st = state.lock().await;
            if let Some(expected) = params.get("expectedMemory") {
                let current = st
                    .db
                    .get_project_memory(path)
                    .map_err(|e| rpc_err(1002, e.to_string(), "INVALID_PARAMS"))?;
                mc_memory_rpc::check_expected(expected, current)?;
            }
            if let Some(entries) = params.get("entries") {
                let memory = st
                    .db
                    .set_project_memory_entries(path, entries)
                    .map_err(|e| rpc_err(1002, e.to_string(), "INVALID_PARAMS"))?;
                return Ok(json!({ "memory": memory }));
            }
            let content = params
                .get("content")
                .and_then(|v| v.as_str())
                .ok_or_else(|| rpc_err(1002, "content required", "INVALID_PARAMS"))?;
            let memory = st
                .db
                .set_project_memory(path, content)
                .map_err(|e| rpc_err(1002, e.to_string(), "INVALID_PARAMS"))?;
            Ok(json!({ "memory": memory }))
        }
        "workspace.set" => {
            let path = params
                .get("path")
                .and_then(|v| v.as_str())
                .ok_or_else(|| rpc_err(1002, "path required", "INVALID_PARAMS"))?;
            let mut st = state.lock().await;
            st.hashline.drop_all();
            let ws = if path.starts_with(crate::db::REMOTE_PROJECT_PREFIX) {
                let group = st
                    .db
                    .project_group_for_path(path)
                    .map_err(|e| rpc_err(1002, e.to_string(), "INVALID_PARAMS"))?
                    .filter(|group| group.remote.is_some())
                    .ok_or_else(|| rpc_err(1007, "remote project not found", "NOT_FOUND"))?;
                st.workspace.set_remote(&group)
            } else {
                st.workspace.set(PathBuf::from(path))
            };
            let pid = st
                .db
                .ensure_project(&ws.path, true)
                .map_err(|e| rpc_err(1000, e.to_string(), "INTERNAL"))?;
            st.db
                .kv_set("app", "currentProjectId", &json!(pid))
                .map_err(|e| rpc_err(1000, e.to_string(), "INTERNAL"))?;
            Ok(json!({ "workspace": ws }))
        }
        "workspace.clear" => {
            let mut st = state.lock().await;
            st.hashline.drop_all();
            st.workspace.clear();
            st.db
                .kv_delete("app", "currentProjectId")
                .map_err(|e| rpc_err(1000, e.to_string(), "INTERNAL"))?;
            Ok(json!({ "ok": true }))
        }
        _ => Err(rpc_err(
            -32601,
            format!("method not found: {method}"),
            "NOT_FOUND",
        )),
    }
}
