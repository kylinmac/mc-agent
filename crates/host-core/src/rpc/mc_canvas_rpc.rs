//! mc-agent creative canvas RPC: `creative.canvas.*` and
//! `creative.canvasComments.*` (docs/mc-agent/creative-canvas.md). The rules
//! live in `crate::mc_creative::canvas`.
//!
//! Methods named `agent…` act for a conversation and are reached only by
//! Electron main's canvas tools, never by the renderer: Main's allowlist
//! leaves them out, and every other method acts for the user.

use serde_json::{json, Value};

use super::{coded, parse, required, JsonRpcError};
use crate::db::{Database, ProjectGroupRecord};
use crate::mc_creative::canvas::{self, Actor, AnchorInput, Op, ThreadStatus};
use crate::rpc::rpc_err;

pub fn handle(
    db: &Database,
    group: &ProjectGroupRecord,
    method: &str,
    params: &Value,
) -> Result<Value, JsonRpcError> {
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
        "creative.canvas.list" => {
            canvas::list(db, group).map(|canvases| json!({ "canvases": canvases }))
        }
        "creative.canvas.create" => canvas::create(db, group, text_or(params, "title"))
            .map(|canvas| json!({ "canvas": canvas })),
        "creative.canvas.get" => {
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
        "creative.canvas.apply" => canvas::apply(
            db,
            group,
            canvas_id()?,
            base_version()?,
            &ops()?,
            &Actor::User,
        )
        .map(|applied| json!(applied)),
        "creative.canvas.agentApply" => {
            canvas::apply(db, group, canvas_id()?, base_version()?, &ops()?, &agent()?)
                .map(|applied| json!(applied))
        }
        "creative.canvas.rename" => {
            canvas::rename(db, group, canvas_id()?, text_or(params, "title"))
                .map(|canvas| json!({ "canvas": canvas }))
        }
        "creative.canvas.delete" => {
            canvas::delete(db, group, canvas_id()?).map(|()| json!({ "ok": true }))
        }
        "creative.canvas.resolveNode" => {
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
        "creative.canvas.boardDocument" => {
            let prefix = required(params, "assetUrlPrefix")?.to_string();
            canvas::board_document(
                db,
                group,
                canvas_id()?,
                required(params, "boardId")?,
                |asset| format!("{prefix}{asset}"),
            )
            .map(|(html, rev)| json!({ "html": html, "rev": rev }))
        }
        "creative.canvasComments.list" => canvas::comments(db, group, canvas_id()?)
            .map(|comments| json!({ "comments": comments })),
        "creative.canvasComments.add" => {
            canvas::add_comment(db, group, canvas_id()?, &anchor()?, text(), &Actor::User)
                .map(|(thread, comments)| json!({ "threadId": thread, "comments": comments }))
        }
        "creative.canvasComments.agentAdd" => {
            canvas::add_comment(db, group, canvas_id()?, &anchor()?, text(), &agent()?)
                .map(|(thread, comments)| json!({ "threadId": thread, "comments": comments }))
        }
        "creative.canvasComments.reply" => canvas::reply(
            db,
            group,
            canvas_id()?,
            required(params, "threadId")?,
            text(),
            &Actor::User,
        )
        .map(|comments| json!({ "comments": comments })),
        "creative.canvasComments.agentReply" => canvas::reply(
            db,
            group,
            canvas_id()?,
            required(params, "threadId")?,
            text(),
            &agent()?,
        )
        .map(|comments| json!({ "comments": comments })),
        "creative.canvasComments.setStatus" => canvas::set_status(
            db,
            group,
            canvas_id()?,
            required(params, "threadId")?,
            status()?,
            &Actor::User,
        )
        .map(|comments| json!({ "comments": comments })),
        "creative.canvasComments.agentSetStatus" => canvas::set_status(
            db,
            group,
            canvas_id()?,
            required(params, "threadId")?,
            status()?,
            &agent()?,
        )
        .map(|comments| json!({ "comments": comments })),
        "creative.canvasComments.assign" => canvas::assign(
            db,
            group,
            canvas_id()?,
            required(params, "threadId")?,
            required(params, "sessionId")?,
        )
        .map(|comments| json!({ "comments": comments })),
        "creative.canvasComments.delete" => {
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
