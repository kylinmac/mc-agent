//! Session-owned explicit file actions, separate from read projections.
use super::*;

pub(super) async fn handle(
    state: &Arc<Mutex<AppState>>,
    method: &str,
    params: Value,
) -> Result<Value, JsonRpcError> {
    let session = params
        .get("sessionId")
        .and_then(Value::as_str)
        .filter(|id| !id.is_empty())
        .ok_or_else(|| rpc_err(1002, "sessionId required", "INVALID_PARAMS"))?;
    let snapshot = params
        .get("snapshotId")
        .and_then(Value::as_str)
        .filter(|id| !id.is_empty())
        .ok_or_else(|| rpc_err(1002, "snapshotId required", "INVALID_PARAMS"))?;
    let _rollback_lease = if method == "review.rollbackFile" {
        Some(rollback_permit(state, session).await?)
    } else {
        None
    };
    let st = state.lock().await;
    if remote_tools::session_remote_workspace(&st, session)?.is_some() {
        return Err(rpc_err(
            1002,
            "remote review file actions are unavailable",
            "CAPABILITY_UNAVAILABLE",
        ));
    }
    let root = resolve_tool_workspace(&st, session)?;
    if method == "review.fileTarget" {
        return review::file_actions::file_target(
            &st.db,
            session,
            snapshot,
            root.as_deref().map(Path::new),
        )
        .map_err(|error| rpc_err(1002, error.to_string(), "INVALID_ARGUMENT"));
    }
    let result = review::file_actions::rollback_file(
        &st.db,
        session,
        snapshot,
        root.as_deref().map(Path::new),
    )
    .map_err(|error| rpc_err(1000, error.to_string(), "INTERNAL"))?;
    if result.status == "rolledBack" {
        for change in &result.changes {
            if let Some(root) = &root {
                let target = Path::new(root).join(&change.path);
                st.hashline
                    .invalidate_path(session, &crate::tools::hashline::canonical_key(&target));
            }
            sessions::update_tool_review_state(
                &st.db,
                session,
                &change.message_id,
                &change.snapshot_id,
                "rolledBack",
            )
            .map_err(|error| rpc_err(1000, error.to_string(), "INTERNAL"))?;
        }
    }
    serde_json::to_value(result).map_err(|error| rpc_err(1000, error.to_string(), "INTERNAL"))
}

/// Rollback waits until the session has no tool in flight and keeps new tools
/// of that session queued until it finishes. mc-agent has no upstream file
/// resource fence, so it takes the session-exclusive permit used around
/// worktree git operations. Never hold AppState while waiting; roots are
/// resolved again after admission.
pub(super) async fn rollback_permit(
    state: &Arc<Mutex<AppState>>,
    session: &str,
) -> Result<crate::tool_budget::SessionExclusivePermit, JsonRpcError> {
    let budget = {
        let st = state.lock().await;
        if remote_tools::session_remote_workspace(&st, session)?.is_some() {
            return Err(rpc_err(
                1002,
                "remote workspace rollback is unavailable",
                "CAPABILITY_UNAVAILABLE",
            ));
        }
        st.tool_budget.clone()
    };
    budget
        .acquire_session_exclusive(session, ROLLBACK_WAIT)
        .await
        .ok_or_else(|| {
            rpc_err(
                1000,
                "the conversation is still running tools; try the rollback again when they finish",
                "TOOL_BUSY",
            )
        })
}

const ROLLBACK_WAIT: std::time::Duration = std::time::Duration::from_secs(30);
