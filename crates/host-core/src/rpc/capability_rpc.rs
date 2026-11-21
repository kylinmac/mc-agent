//! Project- and user-scoped MCP server and skill registry RPCs.
use serde_json::{json, Value};
use tokio::sync::Mutex;

use super::{parse_scope, require_id, rpc_err, JsonRpcError};
use crate::{agent_capabilities::CapabilityLevel, state::AppState};

pub(super) async fn handle(
    state: &Mutex<AppState>,
    method: &str,
    params: Value,
) -> Result<Value, JsonRpcError> {
    match method {
        "mcp.list" => {
            let (level, project_path) = parse_capability_query(&params)?;
            let mut st = state.lock().await;
            let servers = st
                .mcp_servers
                .list(level, project_path.as_deref())
                .map_err(scope_err)?;
            Ok(json!({ "servers": servers, "statuses": [] }))
        }
        "mcp.active" => {
            let project_path = params.get("projectPath").and_then(Value::as_str);
            let mut st = state.lock().await;
            let servers = st.mcp_servers.active_for(project_path).map_err(scope_err)?;
            Ok(json!({ "servers": servers, "statuses": [] }))
        }
        "mcp.upsert" => {
            let input: crate::mcp_servers::McpServerInput =
                serde_json::from_value(params.get("server").cloned().unwrap_or(params.clone()))
                    .map_err(|e| rpc_err(1002, e.to_string(), "INVALID_PARAMS"))?;
            let mut st = state.lock().await;
            let server = st.mcp_servers.upsert(input).map_err(scope_err)?;
            Ok(json!({ "server": server }))
        }
        "mcp.remove" => {
            let id = require_id(&params)?;
            let (level, project_path) = parse_capability_query(&params)?;
            let mut st = state.lock().await;
            let ok = st
                .mcp_servers
                .remove(&id, Some(level), project_path.as_deref())
                .map_err(scope_err)?;
            Ok(json!({ "ok": ok }))
        }
        "mcp.setEnabled" => {
            let id = require_id(&params)?;
            let enabled = params
                .get("enabled")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            let (level, project_path) = parse_capability_query(&params)?;
            let mut st = state.lock().await;
            let server = st
                .mcp_servers
                .set_enabled(&id, enabled, Some(level), project_path.as_deref())
                .map_err(scope_err)?;
            Ok(json!({ "server": server }))
        }
        "mcp.setScope" => {
            let id = require_id(&params)?;
            let scope = parse_scope(&params)?;
            let mut st = state.lock().await;
            let server = st.mcp_servers.set_scope(&id, scope).map_err(scope_err)?;
            Ok(json!({ "server": server }))
        }
        "mcp.transfer" => {
            let id = require_id(&params)?;
            let from = parse_capability_target(&params, "from")?;
            let to = parse_capability_target(&params, "to")?;
            let mut st = state.lock().await;
            let server = st
                .mcp_servers
                .transfer(&id, &from, &to)
                .map_err(scope_err)?;
            Ok(json!({ "server": server }))
        }

        "skills.list" => {
            let (level, project_path) = parse_capability_query(&params)?;
            let mut st = state.lock().await;
            let skills = st
                .user_skills
                .list(level, project_path.as_deref())
                .map_err(skill_err)?;
            Ok(json!({ "skills": skills }))
        }
        "skills.active" => {
            let project_path = params.get("projectPath").and_then(Value::as_str);
            let mut st = state.lock().await;
            let skills = st.user_skills.active_for(project_path).map_err(skill_err)?;
            Ok(json!({ "skills": skills }))
        }
        "skills.disabledBuiltins" => {
            let st = state.lock().await;
            Ok(json!({ "disabled": st.user_skills.disabled_builtins() }))
        }
        "skills.setBuiltinEnabled" => {
            let id = require_id(&params)?;
            let enabled = params
                .get("enabled")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            let mut st = state.lock().await;
            let id = st
                .user_skills
                .set_builtin_enabled(&id, enabled)
                .map_err(skill_err)?;
            Ok(json!({ "id": id, "enabled": enabled }))
        }
        "skills.create" => {
            let input = parse_skill_input(&params)?;
            let mut st = state.lock().await;
            let skill = st.user_skills.create(input).map_err(skill_err)?;
            Ok(json!({ "skill": skill }))
        }
        "skills.import" => {
            let source = params
                .get("path")
                .and_then(Value::as_str)
                .ok_or_else(|| rpc_err(1002, "path required", "INVALID_PARAMS"))?
                .to_string();
            let input = parse_skill_input(&params)?;
            let mut st = state.lock().await;
            let skill = st.user_skills.import(&source, input).map_err(skill_err)?;
            Ok(json!({ "skill": skill }))
        }
        "skills.update" => {
            let id = require_id(&params)?;
            let input = parse_skill_input(&params)?;
            let mut st = state.lock().await;
            let skill = st.user_skills.update(&id, input).map_err(skill_err)?;
            Ok(json!({ "skill": skill }))
        }
        "skills.read" => {
            let id = require_id(&params)?;
            let level = params
                .get("level")
                .and_then(Value::as_str)
                .map(|value| CapabilityLevel::parse(Some(value)))
                .transpose()
                .map_err(|error| rpc_err(1002, error.to_string(), "INVALID_PARAMS"))?;
            let project_path = params.get("projectPath").and_then(Value::as_str);
            let mut st = state.lock().await;
            match st
                .user_skills
                .read(&id, level, project_path)
                .map_err(skill_err)?
            {
                Some((skill, body)) => Ok(json!({ "skill": skill, "body": body })),
                None => Ok(json!({ "skill": null, "body": null })),
            }
        }
        "skills.remove" => {
            let id = require_id(&params)?;
            let level = params
                .get("level")
                .and_then(Value::as_str)
                .map(|value| CapabilityLevel::parse(Some(value)))
                .transpose()
                .map_err(|error| rpc_err(1002, error.to_string(), "INVALID_PARAMS"))?;
            let project_path = params.get("projectPath").and_then(Value::as_str);
            let mut st = state.lock().await;
            let ok = st
                .user_skills
                .remove(&id, level, project_path)
                .map_err(skill_err)?;
            Ok(json!({ "ok": ok }))
        }
        "skills.setEnabled" => {
            let id = require_id(&params)?;
            let enabled = params
                .get("enabled")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            let (level, project_path) = parse_capability_query(&params)?;
            let mut st = state.lock().await;
            let skill = st
                .user_skills
                .set_enabled(&id, enabled, Some(level), project_path.as_deref())
                .map_err(skill_err)?;
            Ok(json!({ "skill": skill }))
        }
        "skills.setScope" => {
            let id = require_id(&params)?;
            let scope = parse_scope(&params)?;
            let mut st = state.lock().await;
            let skill = st.user_skills.set_scope(&id, scope).map_err(skill_err)?;
            Ok(json!({ "skill": skill }))
        }
        "skills.transfer" => {
            let id = require_id(&params)?;
            let from = parse_capability_target(&params, "from")?;
            let to = parse_capability_target(&params, "to")?;
            let mut st = state.lock().await;
            let skill = st
                .user_skills
                .transfer(&id, &from, &to)
                .map_err(skill_err)?;
            Ok(json!({ "skill": skill }))
        }

        _ => Err(rpc_err(
            -32601,
            format!("method not found: {method}"),
            "NOT_FOUND",
        )),
    }
}

/// Capability query failures have their own code so callers can distinguish
/// a missing project context from a malformed MCP or skill document.
fn capability_err(message: impl Into<String>) -> JsonRpcError {
    rpc_err(1018, message, "CAPABILITY_INVALID")
}

/// Validation failures from the user-owned MCP registry are the user's typo,
/// not an internal fault, so they get a distinct code the UI can show inline.
fn scope_err(err: impl ToString) -> JsonRpcError {
    let msg = err.to_string();
    if msg.contains("CAPABILITY_INVALID") {
        capability_err(msg)
    } else if msg.contains("MCP_INVALID") {
        rpc_err(1015, msg, "MCP_INVALID")
    } else {
        rpc_err(1000, msg, "INTERNAL")
    }
}

fn skill_err(err: impl ToString) -> JsonRpcError {
    let msg = err.to_string();
    if msg.contains("CAPABILITY_INVALID") {
        capability_err(msg)
    } else if msg.contains("SKILL_INVALID") {
        rpc_err(1016, msg, "SKILL_INVALID")
    } else {
        rpc_err(1000, msg, "INTERNAL")
    }
}

/// Read the create/import/update payload for a user skill. Absent fields stay
/// absent so `update` can distinguish "unchanged" from "cleared".
fn parse_skill_input(params: &Value) -> Result<crate::user_skills::UserSkillInput, JsonRpcError> {
    let raw = params
        .get("skill")
        .cloned()
        .unwrap_or_else(|| params.clone());
    serde_json::from_value(raw).map_err(|e| rpc_err(1002, e.to_string(), "INVALID_PARAMS"))
}

fn parse_capability_query(
    params: &Value,
) -> Result<(CapabilityLevel, Option<String>), JsonRpcError> {
    let level = CapabilityLevel::parse(params.get("level").and_then(Value::as_str))
        .map_err(|error| capability_err(error.to_string()))?;
    let project_path = params
        .get("projectPath")
        .and_then(Value::as_str)
        .map(str::to_string)
        .filter(|value| !value.trim().is_empty());
    if level == CapabilityLevel::Project && project_path.is_none() {
        return Err(capability_err(
            "projectPath required for project capability queries",
        ));
    }
    Ok((level, project_path))
}

/// Read one end of a move from a nested `{ level, projectPath }` object.
///
/// A move names two directories at once, so unlike the single-level queries it
/// reads a named key instead of the flat params, and the two ends can never be
/// confused for each other. `level` must be present and a string: defaulting a
/// missing or non-string level to `global` would silently write a capability
/// into the wrong directory, so it is rejected as invalid params instead.
fn parse_capability_target(
    params: &Value,
    key: &str,
) -> Result<crate::agent_capabilities::CapabilityTarget, JsonRpcError> {
    let source = params
        .get(key)
        .ok_or_else(|| rpc_err(1002, format!("{key} required"), "INVALID_PARAMS"))?;
    let level = match source.get("level") {
        Some(Value::String(level)) => CapabilityLevel::parse(Some(level))
            .map_err(|error| capability_err(error.to_string()))?,
        _ => {
            return Err(rpc_err(
                1002,
                format!("{key}.level must be 'global' or 'project'"),
                "INVALID_PARAMS",
            ))
        }
    };
    let project_path = source
        .get("projectPath")
        .and_then(Value::as_str)
        .map(str::to_string)
        .filter(|value| !value.trim().is_empty());
    crate::agent_capabilities::CapabilityTarget::new(level, project_path.as_deref())
        .map_err(|error| capability_err(error.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn capability_errors_keep_their_protocol_code() {
        let missing_project = parse_capability_query(&json!({ "level": "project" }))
            .expect_err("project queries require a project path");
        assert_eq!(
            missing_project.data.unwrap()["errorCode"],
            "CAPABILITY_INVALID"
        );

        let unknown_level = parse_capability_query(&json!({ "level": "workspace" }))
            .expect_err("unknown capability levels are invalid");
        assert_eq!(
            unknown_level.data.unwrap()["errorCode"],
            "CAPABILITY_INVALID"
        );
        assert_eq!(
            scope_err("CAPABILITY_INVALID: missing project")
                .data
                .unwrap()["errorCode"],
            "CAPABILITY_INVALID"
        );
        assert_eq!(
            skill_err("CAPABILITY_INVALID: missing project")
                .data
                .unwrap()["errorCode"],
            "CAPABILITY_INVALID"
        );
        assert_eq!(
            capability_err("missing project").data.unwrap()["errorCode"],
            "CAPABILITY_INVALID"
        );
    }

    #[test]
    fn capability_target_requires_an_explicit_string_level() {
        // A missing or non-string level must not fall back to `global`: that
        // would write the capability into the wrong directory without telling
        // the caller.
        let missing = parse_capability_target(&json!({ "to": { "projectPath": "/p" } }), "to")
            .expect_err("a target without a level is invalid");
        assert_eq!(missing.code, 1002);
        assert_eq!(
            missing.data.as_ref().unwrap()["errorCode"],
            json!("INVALID_PARAMS")
        );

        let wrong_type = parse_capability_target(&json!({ "to": { "level": 5 } }), "to")
            .expect_err("a non-string level is invalid");
        assert_eq!(wrong_type.code, 1002);
        assert_eq!(
            wrong_type.data.as_ref().unwrap()["errorCode"],
            json!("INVALID_PARAMS")
        );

        let absent = parse_capability_target(&json!({}), "from")
            .expect_err("the named end of a move is required");
        assert_eq!(absent.code, 1002);

        let project = parse_capability_target(
            &json!({ "to": { "level": "project", "projectPath": "/p" } }),
            "to",
        )
        .unwrap();
        assert_eq!(project.level, CapabilityLevel::Project);
        let global =
            parse_capability_target(&json!({ "to": { "level": "global" } }), "to").unwrap();
        assert_eq!(global.level, CapabilityLevel::Global);
    }
}
