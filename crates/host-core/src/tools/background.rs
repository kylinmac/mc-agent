//! mc-agent background commands (MC-ADR-0006), on top of upstream's
//! background-task registry (`crate::background_tasks`).
//!
//! `Bash { runInBackground: true }` is approved like any Bash call, then
//! started in the registry, which owns the process past the turn, keeps
//! bounded output, and shows it in the composer's task dock. This module adds
//! what the agent needs on top: `BashOutput` reads the output it has not seen
//! yet, and `KillBash` stops the command and waits briefly for it to be gone.
//! Both only reach commands of the calling session.

use super::BashExecutionOptions;
use crate::background_tasks::{self, BackgroundTaskState};
use crate::state::AppState;
use serde_json::{json, Value};
use std::path::Path;
use std::time::Duration;
use tokio::sync::Mutex;

/// New output one `BashOutput` call returns at most, per stream (its tail).
const READ_LIMIT_BYTES: usize = 32 * 1024;
/// How long `KillBash` waits for the process tree to be gone.
const KILL_WAIT: Duration = Duration::from_secs(3);

pub const OUTPUT_TOOL: &str = "BashOutput";
pub const KILL_TOOL: &str = "KillBash";

/// Whether a Bash call asked to run in the background.
pub fn requested(args: &Value) -> bool {
    ["runInBackground", "run_in_background"]
        .iter()
        .any(|key| args.get(*key).and_then(Value::as_bool) == Some(true))
}

fn not_found() -> (String, String) {
    (
        "NOT_FOUND".into(),
        "no background command with that id in this session".into(),
    )
}

fn background_id(args: &Value) -> Result<&str, (String, String)> {
    [
        "backgroundId",
        "backgroundTaskId",
        "bash_id",
        "shellId",
        "id",
    ]
    .iter()
    .find_map(|key| args.get(*key).and_then(Value::as_str))
    .filter(|id| !id.is_empty())
    .ok_or_else(|| ("INVALID_ARGUMENT".into(), "backgroundId required".into()))
}

/// Start `args.command` in the background; returns at once.
pub async fn start(
    state: &Mutex<AppState>,
    workspace: Option<&Path>,
    scratch: Option<&Path>,
    args: &Value,
    options: BashExecutionOptions,
) -> Result<Value, (String, String)> {
    let root = super::require_workspace(workspace)?;
    let command = args
        .get("command")
        .and_then(Value::as_str)
        .filter(|command| !command.trim().is_empty())
        .ok_or_else(|| {
            (
                "INVALID_ARGUMENT".to_string(),
                "command required".to_string(),
            )
        })?;
    // Output goes to a pipe, which makes Python hold it back until its buffer
    // fills; a background server should print as it runs.
    let extra_env = options
        .extra_env
        .iter()
        .cloned()
        .chain([("PYTHONUNBUFFERED".to_string(), "1".to_string())])
        .collect();
    let id = background_tasks::spawn_background_task_with_env(
        state,
        &options.session_id,
        command,
        &options.command_shell_id,
        root,
        scratch,
        extra_env,
    )
    .await?;
    Ok(json!({
        "backgroundId": id,
        "backgroundTaskId": id,
        "status": "running",
        "command": command,
        "message": format!(
            "Started in the background as {id}. It keeps running after this turn. \
             Call BashOutput with this backgroundId to read new output and its status, \
             and KillBash to stop it when it is no longer needed."
        ),
    }))
}

/// New output since the agent's last read, plus status (`BashOutput`).
pub async fn read_new(
    state: &Mutex<AppState>,
    session_id: &str,
    args: &Value,
) -> Result<Value, (String, String)> {
    let id = background_id(args)?;
    let st = state.lock().await;
    let task = st
        .background_tasks
        .tasks
        .get(id)
        .filter(|task| task.session_id == session_id)
        .ok_or_else(not_found)?;
    let mut shared = task.shared.lock().await;
    let (stdout, stderr, skipped) = shared.take_unread();
    let (state, exit_code) = shared.status();
    let (stdout, stdout_cut) = newest(&stdout, READ_LIMIT_BYTES);
    let (stderr, stderr_cut) = newest(&stderr, READ_LIMIT_BYTES);
    let mut result = json!({
        "backgroundId": task.id,
        "command": task.command,
        "status": state,
        "output": stdout,
    });
    if !stderr.is_empty() {
        result["stderr"] = json!(stderr);
    }
    // Only a finished command has a code; a missing one must not read as a failure.
    if let Some(code) = exit_code {
        result["exitCode"] = json!(code);
    }
    if skipped || stdout_cut || stderr_cut {
        result["note"] = json!("earlier output was dropped; only the latest output is shown");
    }
    Ok(result)
}

/// The last `limit` bytes of `text`, cut on a character boundary.
fn newest(text: &str, limit: usize) -> (&str, bool) {
    if text.len() <= limit {
        return (text, false);
    }
    let mut start = text.len() - limit;
    while start < text.len() && !text.is_char_boundary(start) {
        start += 1;
    }
    (&text[start..], true)
}

fn summary(st: &AppState, session_id: &str, id: &str) -> Option<Value> {
    st.background_tasks
        .summaries()
        .into_iter()
        .find(|task| task.id == id && task.session_id == session_id)
        .map(|task| {
            let mut result = json!({
                "backgroundId": task.id,
                "command": task.command,
                "status": task.state,
            });
            if let Some(code) = task.exit_code {
                result["exitCode"] = json!(code);
            }
            result
        })
}

/// Stop one command and wait briefly for it to be gone (`KillBash`).
pub async fn kill(
    state: &Mutex<AppState>,
    session_id: &str,
    args: &Value,
) -> Result<Value, (String, String)> {
    let id = background_id(args)?;
    {
        let st = state.lock().await;
        summary(&st, session_id, id).ok_or_else(not_found)?;
        background_tasks::stop_task(&st.background_tasks, id)
            .await
            .map_err(|message| ("INTERNAL".to_string(), message))?;
    }
    let deadline = tokio::time::Instant::now() + KILL_WAIT;
    loop {
        {
            let st = state.lock().await;
            let current = summary(&st, session_id, id).ok_or_else(not_found)?;
            if current["status"] != json!(BackgroundTaskState::Running)
                || tokio::time::Instant::now() >= deadline
            {
                return Ok(current);
            }
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tools::shell;

    #[test]
    fn recognizes_the_background_flag_in_either_spelling() {
        assert!(requested(
            &json!({ "command": "x", "runInBackground": true })
        ));
        assert!(requested(
            &json!({ "command": "x", "run_in_background": true })
        ));
        assert!(!requested(
            &json!({ "command": "x", "runInBackground": false })
        ));
        assert!(!requested(&json!({ "command": "x" })));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn runs_reads_only_new_output_and_kills_a_real_process() {
        let dir = tempfile::tempdir().unwrap();
        let state = Mutex::new(AppState::open(dir.path()).unwrap());
        let session_id = {
            let st = state.lock().await;
            crate::sessions::create_session(&st.db, Some("test".into()), None, None, None, None)
                .unwrap()
                .id
        };
        let mut options = BashExecutionOptions::local(shell::default_shell_id().to_string(), None);
        options.session_id = session_id.clone();
        let started = start(
            &state,
            Some(dir.path()),
            None,
            &json!({ "command": "echo ready; sleep 0.3; echo later; sleep 30", "runInBackground": true }),
            options,
        )
        .await
        .unwrap();
        let id = started["backgroundId"].as_str().unwrap().to_string();
        let read = |args: Value| {
            let state = &state;
            let session_id = session_id.clone();
            async move { read_new(state, &session_id, &args).await }
        };
        let mut output = String::new();
        for _ in 0..100 {
            let next = read(json!({ "backgroundId": id })).await.unwrap();
            let chunk = next["output"].as_str().unwrap();
            // Each read returns only what the previous one did not.
            assert!(
                !output.contains("ready") || !chunk.contains("ready"),
                "re-read: {chunk:?}"
            );
            output.push_str(chunk);
            if output.contains("later") {
                break;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        assert!(
            output.contains("ready") && output.contains("later"),
            "output: {output:?}"
        );
        // Another session cannot see it.
        assert!(read_new(&state, "other", &json!({ "backgroundId": id }))
            .await
            .is_err());

        let killed = kill(&state, &session_id, &json!({ "backgroundId": id }))
            .await
            .unwrap();
        assert_eq!(killed["status"], "stopped");
        // A stopped command reports no exit code, so it never reads as failed.
        assert!(killed.get("exitCode").is_none());
    }
}
