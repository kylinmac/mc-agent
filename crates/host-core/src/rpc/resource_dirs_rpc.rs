//! Resource-directory RPC surface (mc-agent, MC-ADR-0003).
//!
//! `project.resources.templates` lists templates; `project.resources.ensure`
//! gives a project its resource directory if it has none. Kept beside the
//! shared dispatcher so `rpc::mod` only registers the methods; the rules live
//! in `crate::resource_dirs`.

use serde_json::{json, Value};

use super::{rpc_err, AppState, JsonRpcError};
use crate::resource_dirs;

pub fn templates(_state: &AppState) -> Result<Value, JsonRpcError> {
    let home = resource_dirs::home_dir().map_err(internal)?;
    let templates = resource_dirs::list_templates(&home).map_err(internal)?;
    Ok(json!({ "home": home.to_string_lossy(), "templates": templates }))
}

pub fn ensure(state: &AppState, params: &Value) -> Result<Value, JsonRpcError> {
    let group_id = params
        .get("groupId")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| rpc_err(1002, "groupId required", "INVALID_PARAMS"))?;
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

fn internal(error: anyhow::Error) -> JsonRpcError {
    rpc_err(1000, error.to_string(), "INTERNAL")
}
