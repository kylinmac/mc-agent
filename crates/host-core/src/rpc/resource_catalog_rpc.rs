//! Resource catalog RPC surface (mc-agent R2/R3/R4): every
//! `project.resources.catalog.*` method. The rules live in
//! `crate::resource_catalog`; this module owns the wire shapes.

use serde_json::{json, Value};

use super::{rpc_err, AppState, JsonRpcError};
use crate::resource_catalog::{self, ResourceStatus, ResourceTarget};

const GOAL_NAMESPACE: &str = "mcProjectGoal";
const MAX_GOAL_CHARS: usize = 2_000;

pub fn handle(state: &AppState, method: &str, params: &Value) -> Result<Value, JsonRpcError> {
    let group_id = required(params, "groupId")?;
    let group = state
        .db
        .project_group(group_id)
        .map_err(internal)?
        .ok_or_else(|| rpc_err(1007, "project group not found", "NOT_FOUND"))?;
    let invalid = |error: anyhow::Error| rpc_err(1002, error.to_string(), "INVALID_PARAMS");
    match method {
        "project.resources.catalog.list" => {
            let listing = resource_catalog::list(&state.db, &group).map_err(internal)?;
            Ok(json!(listing))
        }
        "project.resources.catalog.setStatus" => {
            let key = required(params, "key")?;
            let status: ResourceStatus =
                serde_json::from_value(params.get("status").cloned().unwrap_or(Value::Null))
                    .map_err(|error| rpc_err(1002, error.to_string(), "INVALID_PARAMS"))?;
            resource_catalog::set_status(&state.db, &group, key, status).map_err(invalid)?;
            Ok(json!({ "ok": true }))
        }
        "project.resources.catalog.registerFile" => {
            let key = resource_catalog::register_file(
                &state.db,
                &group,
                required(params, "path")?,
                optional(params, "category"),
                params.get("title").and_then(Value::as_str),
            )
            .map_err(invalid)?;
            Ok(json!({ "key": key }))
        }
        "project.resources.catalog.registerUrl" => {
            let key = resource_catalog::register_url(
                &state.db,
                &group,
                required(params, "url")?,
                optional(params, "category"),
                params.get("title").and_then(Value::as_str),
            )
            .map_err(invalid)?;
            Ok(json!({ "key": key }))
        }
        "project.resources.catalog.unregister" => {
            resource_catalog::unregister(&state.db, &group, required(params, "key")?)
                .map_err(invalid)?;
            Ok(json!({ "ok": true }))
        }
        "project.resources.catalog.locate" => {
            match resource_catalog::locate(&state.db, &group, required(params, "key")?)
                .map_err(invalid)?
            {
                ResourceTarget::Path(path) => Ok(json!({ "path": path })),
                ResourceTarget::Url(url) => Ok(json!({ "url": url })),
            }
        }
        // R2: the project goal shown at the top of the overview.
        "project.resources.catalog.goal" => {
            let goal = state
                .db
                .kv_get(GOAL_NAMESPACE, &group.id)
                .map_err(internal)?
                .and_then(|value| {
                    value
                        .get("text")
                        .and_then(Value::as_str)
                        .map(str::to_string)
                })
                .unwrap_or_default();
            Ok(json!({ "goal": goal }))
        }
        "project.resources.catalog.setGoal" => {
            let goal = params
                .get("goal")
                .and_then(Value::as_str)
                .unwrap_or("")
                .trim();
            if goal.chars().count() > MAX_GOAL_CHARS {
                return Err(rpc_err(1002, "project goal is too long", "INVALID_PARAMS"));
            }
            state
                .db
                .kv_set(GOAL_NAMESPACE, &group.id, &json!({ "text": goal }))
                .map_err(internal)?;
            Ok(json!({ "goal": goal }))
        }
        _ => Err(rpc_err(
            -32601,
            format!("method not found: {method}"),
            "NOT_FOUND",
        )),
    }
}

fn required<'a>(params: &'a Value, key: &str) -> Result<&'a str, JsonRpcError> {
    params
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| rpc_err(1002, format!("{key} required"), "INVALID_PARAMS"))
}

fn optional<'a>(params: &'a Value, key: &str) -> &'a str {
    params.get(key).and_then(Value::as_str).unwrap_or("")
}

fn internal(error: anyhow::Error) -> JsonRpcError {
    rpc_err(1000, error.to_string(), "INTERNAL")
}
