//! mc-agent prototype canvas RPC: `canvas.*` and `canvas.comments.*`
//! (docs/mc-agent/prototype-canvas.md). The rules live in `crate::mc_canvas`;
//! every method names the project (`groupId`) the canvas belongs to.
//!
//! Methods named `agent…` act for a conversation and are reached only by
//! Electron main's canvas tools, never by the renderer: Main's allowlist
//! leaves them out, and every other method acts for the user.

use serde_json::{json, Value};

use super::{rpc_err, AppState, JsonRpcError};
use crate::db::ProjectGroupRecord;
use crate::mc_canvas::{self as canvas, Actor, AnchorInput, Op, ThreadStatus};

pub fn handle(state: &AppState, method: &str, params: &Value) -> Result<Value, JsonRpcError> {
    let db = &state.db;
    let group = &group(state, params)?;
    let canvas_id = || required(params, "canvasId");
    let agent = || -> Result<Actor, JsonRpcError> {
        Ok(Actor::Agent {
            session_id: required(params, "sessionId")?.to_string(),
        })
    };
    let ops = || -> Result<Vec<Op>, JsonRpcError> {
        let raw = params.get("ops").cloned().unwrap_or(Value::Null);
        serde_json::from_value(raw)
            .map_err(|error| rpc_err(1002, format!("ops: {error}"), "INVALID_PARAMS"))
    };
    let base_version = || {
        params
            .get("baseVersion")
            .and_then(Value::as_u64)
            .ok_or_else(|| rpc_err(1002, "baseVersion required", "INVALID_PARAMS"))
    };
    let anchor = || -> Result<AnchorInput, JsonRpcError> {
        let raw = params.get("anchor").cloned().unwrap_or(Value::Null);
        serde_json::from_value(raw)
            .map_err(|error| rpc_err(1002, format!("anchor: {error}"), "INVALID_PARAMS"))
    };
    let status = || -> Result<ThreadStatus, JsonRpcError> {
        parse(params, "status")
            .ok_or_else(|| rpc_err(1002, "status is open or resolved", "INVALID_PARAMS"))
    };
    let text = || params.get("text").and_then(Value::as_str).unwrap_or("");
    let result = match method {
        "canvas.list" => canvas::list(db, group).map(|canvases| json!({ "canvases": canvases })),
        "canvas.create" => canvas::create(db, group, text_or(params, "title"))
            .map(|canvas| json!({ "canvas": canvas })),
        "canvas.get" => {
            let id = canvas_id()?;
            (|| {
                let canvas = canvas::get(db, group, id)?;
                let boards: Option<Vec<String>> = parse(params, "boards");
                let html = match (params.get("html").and_then(Value::as_bool), boards) {
                    (_, Some(boards)) => Some(canvas::board_sources(db, group, id, Some(&boards))?),
                    (Some(true), None) => Some(canvas::board_sources(db, group, id, None)?),
                    _ => None,
                };
                Ok(json!({ "canvas": canvas, "html": html }))
            })()
        }
        "canvas.apply" => canvas::apply(
            db,
            group,
            canvas_id()?,
            base_version()?,
            &ops()?,
            &Actor::User,
        )
        .map(|applied| json!(applied)),
        "canvas.agentApply" => {
            canvas::apply(db, group, canvas_id()?, base_version()?, &ops()?, &agent()?)
                .map(|applied| json!(applied))
        }
        "canvas.rename" => canvas::rename(db, group, canvas_id()?, text_or(params, "title"))
            .map(|canvas| json!({ "canvas": canvas })),
        "canvas.delete" => canvas::delete(db, group, canvas_id()?).map(|()| json!({ "ok": true })),
        "canvas.resolveNode" => {
            let node = params
                .get("node")
                .and_then(Value::as_u64)
                .ok_or_else(|| rpc_err(1002, "node required", "INVALID_PARAMS"))?;
            canvas::resolve_node(
                db,
                group,
                canvas_id()?,
                required(params, "boardId")?,
                node as usize,
            )
            .map(|node| json!({ "node": node }))
        }
        "canvas.boardDocument" => {
            canvas::board_document(db, group, canvas_id()?, required(params, "boardId")?)
                .map(|(html, rev)| json!({ "html": html, "rev": rev }))
        }
        "canvas.comments.list" => canvas::comments(db, group, canvas_id()?)
            .map(|comments| json!({ "comments": comments })),
        "canvas.comments.add" => {
            canvas::add_comment(db, group, canvas_id()?, &anchor()?, text(), &Actor::User)
                .map(|(thread, comments)| json!({ "threadId": thread, "comments": comments }))
        }
        "canvas.comments.agentAdd" => {
            canvas::add_comment(db, group, canvas_id()?, &anchor()?, text(), &agent()?)
                .map(|(thread, comments)| json!({ "threadId": thread, "comments": comments }))
        }
        "canvas.comments.reply" => canvas::reply(
            db,
            group,
            canvas_id()?,
            required(params, "threadId")?,
            text(),
            &Actor::User,
        )
        .map(|comments| json!({ "comments": comments })),
        "canvas.comments.agentReply" => canvas::reply(
            db,
            group,
            canvas_id()?,
            required(params, "threadId")?,
            text(),
            &agent()?,
        )
        .map(|comments| json!({ "comments": comments })),
        "canvas.comments.setStatus" => canvas::set_status(
            db,
            group,
            canvas_id()?,
            required(params, "threadId")?,
            status()?,
            &Actor::User,
        )
        .map(|comments| json!({ "comments": comments })),
        "canvas.comments.agentSetStatus" => canvas::set_status(
            db,
            group,
            canvas_id()?,
            required(params, "threadId")?,
            status()?,
            &agent()?,
        )
        .map(|comments| json!({ "comments": comments })),
        "canvas.comments.assign" => canvas::assign(
            db,
            group,
            canvas_id()?,
            required(params, "threadId")?,
            required(params, "sessionId")?,
        )
        .map(|comments| json!({ "comments": comments })),
        "canvas.comments.delete" => {
            canvas::delete_thread(db, group, canvas_id()?, required(params, "threadId")?)
                .map(|comments| json!({ "comments": comments }))
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

fn text_or<'a>(params: &'a Value, key: &str) -> &'a str {
    params.get(key).and_then(Value::as_str).unwrap_or("")
}

fn group(state: &AppState, params: &Value) -> Result<ProjectGroupRecord, JsonRpcError> {
    let group_id = required(params, "groupId")?;
    state
        .db
        .project_group(group_id)
        .map_err(|error| rpc_err(1000, error.to_string(), "INTERNAL"))?
        .ok_or_else(|| rpc_err(1007, "project group not found", "NOT_FOUND"))
}

fn required<'a>(params: &'a Value, key: &str) -> Result<&'a str, JsonRpcError> {
    params
        .get(key)
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| rpc_err(1002, format!("{key} required"), "INVALID_PARAMS"))
}

fn parse<T: serde::de::DeserializeOwned>(params: &Value, key: &str) -> Option<T> {
    params
        .get(key)
        .cloned()
        .and_then(|value| serde_json::from_value(value).ok())
}

/// The domain's coded errors (`NOT_FOUND: …`), as in `mc_creative_rpc`.
fn coded(error: anyhow::Error) -> JsonRpcError {
    let message = format!("{error:#}");
    let (code, kind) = match message.split(':').next().unwrap_or("") {
        "INVALID_ARGUMENT" => (1002, "INVALID_PARAMS"),
        "NOT_FOUND" => (1007, "NOT_FOUND"),
        "PRECONDITION" | "CONFLICT" => (1008, "CONFLICT"),
        "PERMISSION_DENIED" => (1004, "PERMISSION_DENIED"),
        _ => (1000, "INTERNAL"),
    };
    rpc_err(code, message, kind)
}
