//! mc-agent creative studio RPC surface: every `creative.*` method. The rules
//! live in `crate::mc_creative`; this module owns the wire shapes and maps the
//! domain's coded errors (same convention as `project.tasks.*`).

use std::path::Path;

use serde_json::{json, Value};

use super::{rpc_err, AppState, JsonRpcError};
use crate::db::ProjectGroupRecord;
use crate::mc_creative::{
    self as creative, AssetFilter, ComparisonInput, FileFacts, JobInput, JobStatus, Purpose,
};

pub fn handle(state: &AppState, method: &str, params: &Value) -> Result<Value, JsonRpcError> {
    let db = &state.db;
    // Methods that are not about one project.
    match method {
        "creative.purposes" => {
            return creative::purposes(db)
                .map(|purposes| json!({ "purposes": purposes }))
                .map_err(coded)
        }
        "creative.createProject" => {
            let folder = required(params, "folder")?;
            let name = params.get("name").and_then(Value::as_str).unwrap_or("");
            return creative::create_project(db, name, Path::new(folder))
                .map(|group| json!({ "group": group }))
                .map_err(coded);
        }
        "creative.accountImageModels" => {
            return creative::account_image_models(db)
                .map(|models| json!({ "models": models }))
                .map_err(coded)
        }
        "creative.setAccountImageModels" => {
            let ids: Vec<String> = parse(params, "modelIds").unwrap_or_default();
            return creative::set_account_image_models(db, required(params, "providerId")?, &ids)
                .map(|models| json!({ "modelIds": models }))
                .map_err(coded);
        }
        "creative.jobs.interruptUnfinished" => {
            return creative::interrupt_unfinished(db)
                .map(|count| json!({ "interrupted": count }))
                .map_err(coded)
        }
        _ => {}
    }
    let group = group(state, params)?;
    let result = match method {
        "creative.setPurpose" => set_purpose(state, &group, params),
        "creative.useWorkspace" => creative::use_workspace(
            db,
            &group,
            Path::new(required(params, "folder")?),
            params.get("add").and_then(Value::as_bool).unwrap_or(false),
        )
        .map(|(group, storage)| json!({ "group": group, "storage": storage })),
        "creative.storage" => {
            creative::storage(db, &group).map(|storage| json!({ "storage": storage }))
        }
        "creative.setStorage" => creative::set_storage(db, &group, required(params, "folder")?)
            .map(|storage| json!({ "storage": storage })),
        "creative.assets.list" => {
            let filter: AssetFilter = parse(params, "filter").unwrap_or_default();
            creative::list_assets(db, &group, &filter).map(|assets| json!({ "assets": assets }))
        }
        "creative.assets.get" => {
            let id = required(params, "assetId")?;
            (|| {
                let asset = creative::get_asset(db, id)?
                    .filter(|asset| asset.group_id == group.id)
                    .ok_or_else(|| anyhow::anyhow!("NOT_FOUND: asset not found"))?;
                let job = match &asset.job_id {
                    Some(job) => creative::get_job(db, job)?,
                    None => None,
                };
                let links = creative::asset_links(db, &group, id)?;
                Ok(json!({ "asset": asset, "job": job, "links": links }))
            })()
        }
        "creative.assets.importReference" => creative::import_reference(
            db,
            &group,
            Path::new(required(params, "path")?),
            &facts(params),
            params.get("category").and_then(Value::as_str).unwrap_or(""),
        )
        .map(|asset| json!({ "asset": asset })),
        "creative.assets.move" => {
            let ids: Vec<String> = parse(params, "assetIds").unwrap_or_default();
            creative::move_assets(
                db,
                &group,
                &ids,
                params.get("category").and_then(Value::as_str).unwrap_or(""),
            )
            .map(|assets| json!({ "assets": assets }))
        }
        "creative.categories.list" => creative::list_categories(db, &group)
            .map(|categories| json!({ "categories": categories })),
        "creative.categories.create" => {
            creative::create_category(db, &group, required(params, "path")?)
                .map(|path| json!({ "path": path }))
        }
        "creative.categories.rename" => creative::rename_category(
            db,
            &group,
            required(params, "from")?,
            required(params, "to")?,
        )
        .map(|path| json!({ "path": path })),
        "creative.categories.delete" => {
            creative::delete_category(db, &group, required(params, "path")?)
                .map(|()| json!({ "ok": true }))
        }
        "creative.assets.importExisting" => creative::import_existing(
            db,
            &group,
            Path::new(required(params, "path")?),
            &facts(params),
        )
        .map(|asset| json!({ "asset": asset })),
        "creative.assets.setFavorite" => creative::set_favorite(
            db,
            &group,
            required(params, "assetId")?,
            params
                .get("favorite")
                .and_then(Value::as_bool)
                .unwrap_or(false),
        )
        .map(|asset| json!({ "asset": asset })),
        "creative.assets.setTitle" => creative::set_title(
            db,
            &group,
            required(params, "assetId")?,
            params.get("title").and_then(Value::as_str).unwrap_or(""),
        )
        .map(|asset| json!({ "asset": asset })),
        "creative.assets.remove" => {
            creative::remove_asset(db, &group, required(params, "assetId")?)
                .map(|asset| json!({ "asset": asset }))
        }
        "creative.assets.restore" => {
            creative::restore_asset(db, &group, required(params, "assetId")?)
                .map(|asset| json!({ "asset": asset }))
        }
        "creative.assets.deleteFile" => {
            creative::delete_asset_file(db, &group, required(params, "assetId")?)
                .map(|asset| json!({ "asset": asset }))
        }
        "creative.jobs.create" => {
            let input: JobInput = parse(params, "job")
                .ok_or_else(|| rpc_err(1002, "job required", "INVALID_PARAMS"))?;
            creative::create_job(db, &group, input).and_then(|job| {
                let category = job
                    .snapshot
                    .get("category")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string();
                let dir = creative::output_dir(db, &group, &category)?;
                Ok(json!({ "job": job, "outputDir": dir.to_string_lossy() }))
            })
        }
        "creative.jobs.get" => creative::get_job(db, required(params, "jobId")?).and_then(|job| {
            job.filter(|job| job.group_id == group.id)
                .map(|job| json!({ "job": job }))
                .ok_or_else(|| anyhow::anyhow!("NOT_FOUND: generation not found"))
        }),
        "creative.jobs.list" => {
            let limit = params.get("limit").and_then(Value::as_u64).unwrap_or(100) as usize;
            creative::list_jobs(db, &group, limit).map(|jobs| json!({ "jobs": jobs }))
        }
        "creative.jobs.setStatus" => {
            let status: JobStatus = parse(params, "status")
                .ok_or_else(|| rpc_err(1002, "status required", "INVALID_PARAMS"))?;
            creative::set_job_status(
                db,
                &group,
                required(params, "jobId")?,
                status,
                params.get("error").and_then(Value::as_str),
            )
            .map(|job| json!({ "job": job }))
        }
        "creative.jobs.recordResult" => {
            let index = params
                .get("index")
                .and_then(Value::as_i64)
                .ok_or_else(|| rpc_err(1002, "index required", "INVALID_PARAMS"))?;
            creative::record_result(
                db,
                &group,
                required(params, "jobId")?,
                index,
                params.get("path").and_then(Value::as_str).map(Path::new),
                &facts(params),
                params.get("error").and_then(Value::as_str),
            )
            .map(|job| json!({ "job": job }))
        }
        "creative.jobs.reconcile" => {
            creative::reconcile(db, &group).map(|count| json!({ "registered": count }))
        }
        "creative.code.register" => creative::register_code_drawing(
            db,
            &group,
            Path::new(required(params, "imagePath")?),
            params
                .get("scriptPath")
                .and_then(Value::as_str)
                .map(Path::new),
            params.get("command").and_then(Value::as_str).unwrap_or(""),
            params.get("sessionId").and_then(Value::as_str),
            &facts(params),
            params.get("category").and_then(Value::as_str).unwrap_or(""),
        )
        .map(|job| json!({ "job": job })),
        "creative.comparisons.list" => creative::list_comparisons(db, &group)
            .map(|comparisons| json!({ "comparisons": comparisons })),
        "creative.comparisons.save" => {
            let input: ComparisonInput = parse(params, "comparison")
                .ok_or_else(|| rpc_err(1002, "comparison required", "INVALID_PARAMS"))?;
            creative::save_comparison(
                db,
                &group,
                params.get("comparisonId").and_then(Value::as_str),
                input,
            )
            .map(|comparison| json!({ "comparison": comparison }))
        }
        "creative.comparisons.delete" => {
            creative::delete_comparison(db, &group, required(params, "comparisonId")?)
                .map(|()| json!({ "ok": true }))
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

/// Mark a project creative, or back to code. Marking never moves or deletes
/// files; a creative project stores in its workspace unless told otherwise.
fn set_purpose(
    state: &AppState,
    group: &ProjectGroupRecord,
    params: &Value,
) -> anyhow::Result<Value> {
    let purpose: Purpose =
        serde_json::from_value(params.get("purpose").cloned().unwrap_or(Value::Null))
            .map_err(|_| anyhow::anyhow!("INVALID_ARGUMENT: purpose is code or creative"))?;
    creative::set_purpose(&state.db, group, purpose)?;
    Ok(json!({ "group": group, "purpose": purpose }))
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

fn facts(params: &Value) -> FileFacts {
    parse(params, "facts").unwrap_or_default()
}

/// The domain prefixes its refusals with a code; anything else is internal.
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
