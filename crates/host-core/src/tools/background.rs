//! mc-agent background commands (MC-ADR-0006).
//!
//! `Bash { runInBackground: true }` starts the command through the same
//! runner, permission gate and process-tree ownership as a foreground Bash
//! call, but returns at once with an id instead of waiting. The process keeps
//! running across turns; its combined stdout/stderr goes into a bounded
//! buffer the agent reads with `BashOutput` and stops with `KillBash`, and the
//! desktop lists and stops through `backgroundShells.*`.
//!
//! A background command ends when it exits, when it is killed (agent, user),
//! when its session is deleted, or when the host shuts down. If the host dies
//! outright, the runner sees its control pipe close and kills its own process
//! group, exactly as for a foreground call.

use super::{
    kill_and_reap, read_pipe, shell, spawn_tool_runner, wait_for_cancellation,
    BashExecutionOptions, OutputChunk, OutputStream, SpawnedToolRunner, ToolRunnerStartConfig,
    Utf8Decoder, OUTPUT_CHANNEL_CAPACITY, PIPE_DRAIN_TIMEOUT,
};
use serde_json::{json, Value};
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::sync::{mpsc, watch};

/// Running background commands one session may hold.
pub const MAX_RUNNING_PER_SESSION: usize = 8;
/// Running background commands across all sessions.
pub const MAX_RUNNING_TOTAL: usize = 32;
/// Records kept per session, finished ones included; the oldest finished
/// record is dropped first.
const MAX_KEPT_PER_SESSION: usize = 20;
/// Output kept per command; older output is dropped from the front.
const BUFFER_LIMIT_BYTES: usize = 1024 * 1024;
/// New output one `BashOutput` call returns at most (its tail).
const READ_LIMIT_BYTES: usize = 32 * 1024;
/// Output the desktop's full view returns at most (its tail).
const VIEW_LIMIT_BYTES: usize = 256 * 1024;
/// Output the desktop's list returns per command (its tail).
const LIST_TAIL_BYTES: usize = 4 * 1024;
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

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Status {
    Running,
    Exited,
    Killed,
    Failed,
}

impl Status {
    fn as_str(self) -> &'static str {
        match self {
            Self::Running => "running",
            Self::Exited => "exited",
            Self::Killed => "killed",
            Self::Failed => "failed",
        }
    }
}

struct Shell {
    id: String,
    session_id: String,
    command: String,
    cwd: String,
    started_at: i64,
    ended_at: Option<i64>,
    status: Status,
    exit_code: Option<i32>,
    error: Option<String>,
    /// The retained output; `dropped` bytes before it are gone.
    buffer: String,
    dropped: u64,
    /// Absolute offset (in all output ever written) the agent has read up to.
    read_cursor: u64,
    kill: watch::Sender<bool>,
}

impl Shell {
    fn written(&self) -> u64 {
        self.dropped + self.buffer.len() as u64
    }

    fn append(&mut self, text: &str) {
        self.buffer.push_str(text);
        if self.buffer.len() > BUFFER_LIMIT_BYTES {
            let cut = floor_char_boundary(&self.buffer, self.buffer.len() - BUFFER_LIMIT_BYTES);
            self.buffer.drain(..cut);
            self.dropped += cut as u64;
        }
    }

    fn summary(&self) -> Value {
        let mut summary = json!({
            "id": self.id,
            "command": self.command,
            "cwd": self.cwd,
            "status": self.status.as_str(),
            "error": self.error,
            "startedAt": self.started_at,
            "endedAt": self.ended_at,
        });
        // Only an exited command has a code. The transcript reads any
        // `exitCode` as a command outcome, so a running or stopped command
        // must not report a missing one (that would read as a failure).
        if let Some(code) = self.exit_code {
            summary["exitCode"] = json!(code);
        }
        summary
    }
}

/// The host's background commands, shared by tool calls and desktop RPCs.
#[derive(Clone, Default)]
pub struct BackgroundShells {
    shells: Arc<Mutex<Vec<Arc<Mutex<Shell>>>>>,
}

fn now_ms() -> i64 {
    crate::db::now_ms()
}

fn floor_char_boundary(text: &str, mut index: usize) -> usize {
    index = index.min(text.len());
    while index > 0 && !text.is_char_boundary(index) {
        index -= 1;
    }
    index
}

/// The last `limit` bytes of `text`, cut on a character boundary.
fn tail(text: &str, limit: usize) -> (&str, bool) {
    if text.len() <= limit {
        return (text, false);
    }
    let mut start = text.len() - limit;
    while start < text.len() && !text.is_char_boundary(start) {
        start += 1;
    }
    (&text[start..], true)
}

fn not_found() -> (String, String) {
    (
        "NOT_FOUND".into(),
        "no background command with that id in this session".into(),
    )
}

impl BackgroundShells {
    fn find(&self, session_id: &str, id: &str) -> Option<Arc<Mutex<Shell>>> {
        let shells = self.shells.lock().ok()?;
        shells
            .iter()
            .find(|shell| {
                shell
                    .lock()
                    .map(|shell| shell.id == id && shell.session_id == session_id)
                    .unwrap_or(false)
            })
            .cloned()
    }

    fn running_counts(&self, session_id: &str) -> (usize, usize) {
        let Ok(shells) = self.shells.lock() else {
            return (0, 0);
        };
        let mut session = 0;
        let mut total = 0;
        for shell in shells.iter() {
            if let Ok(shell) = shell.lock() {
                if shell.status == Status::Running {
                    total += 1;
                    if shell.session_id == session_id {
                        session += 1;
                    }
                }
            }
        }
        (session, total)
    }

    fn register(&self, shell: Arc<Mutex<Shell>>, session_id: &str) {
        let Ok(mut shells) = self.shells.lock() else {
            return;
        };
        shells.push(shell);
        // Drop the oldest finished records beyond the per-session cap.
        loop {
            let owned: Vec<usize> = shells
                .iter()
                .enumerate()
                .filter(|(_, shell)| {
                    shell
                        .lock()
                        .map(|shell| shell.session_id == session_id)
                        .unwrap_or(false)
                })
                .map(|(index, _)| index)
                .collect();
            if owned.len() <= MAX_KEPT_PER_SESSION {
                break;
            }
            let finished = owned.into_iter().find(|index| {
                shells[*index]
                    .lock()
                    .map(|shell| shell.status != Status::Running)
                    .unwrap_or(true)
            });
            match finished {
                Some(index) => {
                    shells.remove(index);
                }
                None => break,
            }
        }
    }

    /// Start `args.command` in the background; returns at once.
    pub async fn start(
        &self,
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
        let (session_running, total_running) = self.running_counts(&options.session_id);
        if session_running >= MAX_RUNNING_PER_SESSION || total_running >= MAX_RUNNING_TOTAL {
            return Err((
                "BACKGROUND_LIMIT".into(),
                format!(
                    "too many background commands are running ({MAX_RUNNING_PER_SESSION} per session, \
                     {MAX_RUNNING_TOTAL} in total); stop one with KillBash first"
                ),
            ));
        }

        let resolved = shell::resolve_shell(&options.command_shell_id)
            .map_err(|message| ("SHELL_NOT_FOUND".to_string(), message))?;
        let invocation = shell::build_invocation_for_platform(
            shell::current_platform(),
            &options.command_shell_id,
            resolved.program,
            command,
        )
        .map_err(|message| ("INVALID_ARGUMENT".to_string(), message))?;
        let config = ToolRunnerStartConfig {
            program: invocation.program,
            args: invocation.args,
            workspace: root.to_path_buf(),
            scratch_dir: scratch.map(|path| {
                shell::format_scratch_dir_for_shell(
                    shell::dialect_for_id(&options.command_shell_id),
                    path,
                )
            }),
            env_path: shell::user_login_path().map(str::to_string),
            // Output goes to a pipe, which makes Python hold it back until its
            // buffer fills; a background server should print as it runs.
            extra_env: options
                .extra_env
                .iter()
                .cloned()
                .chain([("PYTHONUNBUFFERED".to_string(), "1".to_string())])
                .collect(),
        };
        let runner = spawn_tool_runner(&config).await?;

        let id = format!("bg-{}", &uuid::Uuid::new_v4().simple().to_string()[..8]);
        let (kill_tx, kill_rx) = watch::channel(false);
        let shell = Arc::new(Mutex::new(Shell {
            id: id.clone(),
            session_id: options.session_id.clone(),
            command: command.to_string(),
            cwd: root.to_string_lossy().into_owned(),
            started_at: now_ms(),
            ended_at: None,
            status: Status::Running,
            exit_code: None,
            error: None,
            buffer: String::new(),
            dropped: 0,
            read_cursor: 0,
            kill: kill_tx,
        }));
        self.register(shell.clone(), &options.session_id);
        tokio::spawn(supervise(shell, runner, kill_rx));

        Ok(json!({
            "backgroundId": id,
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
    pub fn read_new(&self, session_id: &str, args: &Value) -> Result<Value, (String, String)> {
        let id = background_id(args)?;
        let shell = self.find(session_id, id).ok_or_else(not_found)?;
        let mut shell = shell.lock().map_err(|_| not_found())?;
        let skipped = shell.dropped.saturating_sub(shell.read_cursor);
        let start = floor_char_boundary(
            &shell.buffer,
            shell.read_cursor.saturating_sub(shell.dropped) as usize,
        );
        let (output, truncated) = tail(&shell.buffer[start..], READ_LIMIT_BYTES);
        let output = output.to_string();
        shell.read_cursor = shell.written();
        let mut result = shell.summary();
        result["backgroundId"] = json!(shell.id);
        result["output"] = json!(output);
        if skipped > 0 || truncated {
            result["note"] = json!("earlier output was dropped; only the latest output is shown");
        }
        Ok(result)
    }

    /// Stop one command and wait briefly for it to be gone (`KillBash`, desktop).
    pub async fn kill(&self, session_id: &str, id: &str) -> Result<Value, (String, String)> {
        let shell = self.find(session_id, id).ok_or_else(not_found)?;
        {
            let shell = shell.lock().map_err(|_| not_found())?;
            if shell.status != Status::Running {
                let mut result = shell.summary();
                result["backgroundId"] = json!(shell.id);
                return Ok(result);
            }
            let _ = shell.kill.send(true);
        }
        let deadline = tokio::time::Instant::now() + KILL_WAIT;
        loop {
            {
                let shell = shell.lock().map_err(|_| not_found())?;
                if shell.status != Status::Running || tokio::time::Instant::now() >= deadline {
                    let mut result = shell.summary();
                    result["backgroundId"] = json!(shell.id);
                    return Ok(result);
                }
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    }

    /// The session's commands for the desktop, newest first, with a short tail.
    pub fn list(&self, session_id: &str) -> Value {
        let Ok(shells) = self.shells.lock() else {
            return json!({ "shells": [] });
        };
        let items: Vec<Value> = shells
            .iter()
            .rev()
            .filter_map(|shell| {
                let shell = shell.lock().ok()?;
                if shell.session_id != session_id {
                    return None;
                }
                let mut item = shell.summary();
                item["tail"] = json!(tail(&shell.buffer, LIST_TAIL_BYTES).0);
                Some(item)
            })
            .collect();
        json!({ "shells": items })
    }

    /// One command's output for the desktop's full view; never moves the
    /// agent's read cursor.
    pub fn view(&self, session_id: &str, id: &str) -> Result<Value, (String, String)> {
        let shell = self.find(session_id, id).ok_or_else(not_found)?;
        let shell = shell.lock().map_err(|_| not_found())?;
        let (output, truncated) = tail(&shell.buffer, VIEW_LIMIT_BYTES);
        let mut result = shell.summary();
        result["output"] = json!(output);
        result["truncated"] = json!(truncated || shell.dropped > 0);
        Ok(result)
    }

    /// Kill every running command of a session and forget its records.
    pub fn drop_session(&self, session_id: &str) {
        let Ok(mut shells) = self.shells.lock() else {
            return;
        };
        shells.retain(|shell| {
            let Ok(shell) = shell.lock() else {
                return false;
            };
            if shell.session_id != session_id {
                return true;
            }
            let _ = shell.kill.send(true);
            false
        });
    }

    /// Kill every running command (host shutdown).
    pub fn kill_all(&self) {
        let Ok(shells) = self.shells.lock() else {
            return;
        };
        for shell in shells.iter() {
            if let Ok(shell) = shell.lock() {
                let _ = shell.kill.send(true);
            }
        }
    }
}

fn background_id(args: &Value) -> Result<&str, (String, String)> {
    ["backgroundId", "bash_id", "shellId", "id"]
        .iter()
        .find_map(|key| args.get(*key).and_then(Value::as_str))
        .filter(|id| !id.is_empty())
        .ok_or_else(|| ("INVALID_ARGUMENT".into(), "backgroundId required".into()))
}

enum Stop {
    Exited(Option<i32>),
    Killed,
    Failed(String),
}

/// Own one background process: collect its output, then record how it ended.
async fn supervise(
    shell: Arc<Mutex<Shell>>,
    runner: SpawnedToolRunner,
    kill_rx: watch::Receiver<bool>,
) {
    let SpawnedToolRunner {
        pid,
        mut ownership,
        mut control,
        stdout,
        stderr,
        mut wait_task,
    } = runner;
    let (chunk_tx, mut output_rx) = mpsc::channel::<OutputChunk>(OUTPUT_CHANNEL_CAPACITY);
    let stdout_task = tokio::spawn(read_pipe(stdout, OutputStream::Stdout, chunk_tx.clone()));
    let stderr_task = tokio::spawn(read_pipe(stderr, OutputStream::Stderr, chunk_tx.clone()));
    drop(chunk_tx);
    let mut decoders = [Utf8Decoder::default(), Utf8Decoder::default()];
    let append = |chunk: OutputChunk, decoders: &mut [Utf8Decoder; 2]| {
        let decoder = match chunk.stream {
            OutputStream::Stdout => &mut decoders[0],
            OutputStream::Stderr => &mut decoders[1],
        };
        let text = decoder.push(&chunk.bytes);
        if let Ok(mut shell) = shell.lock() {
            shell.append(&text);
        }
    };
    let mut kill = Some(kill_rx);
    let mut output_closed = false;
    let stop = loop {
        tokio::select! {
            waited = &mut wait_task => {
                break match waited {
                    Ok(Ok(status)) => Stop::Exited(status.code()),
                    Ok(Err(error)) => Stop::Failed(format!("wait failed: {error}")),
                    Err(error) => Stop::Failed(format!("wait task failed: {error}")),
                };
            }
            chunk = output_rx.recv(), if !output_closed => {
                match chunk {
                    Some(chunk) => append(chunk, &mut decoders),
                    None => output_closed = true,
                }
            }
            cancelled = wait_for_cancellation(&mut kill) => {
                if cancelled {
                    break match kill_and_reap(pid, &mut ownership, &mut control, &mut wait_task).await {
                        Ok(()) => Stop::Killed,
                        Err(error) => Stop::Failed(error),
                    };
                }
            }
        }
    };
    // Whatever the pipes still hold, bounded so a grandchild that kept them
    // open cannot hold this task forever.
    let drain = async {
        while let Some(chunk) = output_rx.recv().await {
            append(chunk, &mut decoders);
        }
    };
    if tokio::time::timeout(PIPE_DRAIN_TIMEOUT, drain)
        .await
        .is_err()
    {
        stdout_task.abort();
        stderr_task.abort();
    }
    let rest: String = decoders.iter_mut().map(Utf8Decoder::finish).collect();
    if let Ok(mut shell) = shell.lock() {
        shell.append(&rest);
        shell.ended_at = Some(now_ms());
        match stop {
            Stop::Exited(code) => {
                shell.status = Status::Exited;
                shell.exit_code = code;
            }
            Stop::Killed => shell.status = Status::Killed,
            Stop::Failed(error) => {
                shell.status = Status::Failed;
                shell.error = Some(error);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn record(session: &str, id: &str, status: Status) -> Arc<Mutex<Shell>> {
        let (kill, _) = watch::channel(false);
        Arc::new(Mutex::new(Shell {
            id: id.into(),
            session_id: session.into(),
            command: "echo".into(),
            cwd: "/tmp".into(),
            started_at: 0,
            ended_at: None,
            status,
            exit_code: None,
            error: None,
            buffer: String::new(),
            dropped: 0,
            read_cursor: 0,
            kill,
        }))
    }

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

    #[test]
    fn reads_only_new_output_and_reports_dropped_output() {
        let shells = BackgroundShells::default();
        let shell = record("s1", "bg-1", Status::Running);
        shells.register(shell.clone(), "s1");
        shell.lock().unwrap().append("hello\n");
        let first = shells
            .read_new("s1", &json!({ "backgroundId": "bg-1" }))
            .unwrap();
        assert_eq!(first["output"], "hello\n");
        shell.lock().unwrap().append("world\n");
        let second = shells
            .read_new("s1", &json!({ "backgroundId": "bg-1" }))
            .unwrap();
        assert_eq!(second["output"], "world\n");
        assert_eq!(second["status"], "running");
        // Another session cannot see it.
        assert!(shells
            .read_new("s2", &json!({ "backgroundId": "bg-1" }))
            .is_err());

        // Overflowing the buffer drops the front and says so.
        let big = "x".repeat(BUFFER_LIMIT_BYTES + 10);
        shell.lock().unwrap().append(&big);
        let third = shells
            .read_new("s1", &json!({ "backgroundId": "bg-1" }))
            .unwrap();
        assert!(third["note"].is_string());
        assert_eq!(third["output"].as_str().unwrap().len(), READ_LIMIT_BYTES);
    }

    #[test]
    fn keeps_a_bounded_number_of_records_per_session() {
        let shells = BackgroundShells::default();
        for index in 0..(MAX_KEPT_PER_SESSION + 5) {
            shells.register(record("s1", &format!("bg-{index}"), Status::Exited), "s1");
        }
        let listed = shells.list("s1");
        assert_eq!(
            listed["shells"].as_array().unwrap().len(),
            MAX_KEPT_PER_SESSION
        );
        // Newest first.
        assert_eq!(
            listed["shells"][0]["id"],
            format!("bg-{}", MAX_KEPT_PER_SESSION + 4)
        );
        shells.drop_session("s1");
        assert!(shells.list("s1")["shells"].as_array().unwrap().is_empty());
    }

    #[test]
    fn tail_cuts_on_character_boundaries() {
        let (text, cut) = tail("ab中文", 4);
        assert!(cut);
        assert_eq!(text, "文");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn runs_reads_and_kills_a_real_process() {
        let dir = tempfile::tempdir().unwrap();
        let shells = BackgroundShells::default();
        let shell_id = shell::catalog(None)
            .effective
            .map(|option| option.id)
            .unwrap_or_else(|| shell::default_shell_id().to_string());
        let mut options = BashExecutionOptions::local(shell_id, None);
        options.session_id = "s1".into();
        let started = shells
            .start(
                Some(dir.path()),
                None,
                &json!({ "command": "echo ready; sleep 30", "runInBackground": true }),
                options,
            )
            .await
            .unwrap();
        let id = started["backgroundId"].as_str().unwrap().to_string();
        let mut output = String::new();
        for _ in 0..100 {
            let read = shells
                .read_new("s1", &json!({ "backgroundId": id }))
                .unwrap();
            output.push_str(read["output"].as_str().unwrap());
            if output.contains("ready") {
                break;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        assert!(output.contains("ready"), "output: {output:?}");
        let killed = shells.kill("s1", &id).await.unwrap();
        assert_eq!(killed["status"], "killed");
        // A stopped command reports no exit code, so it never reads as failed.
        assert!(killed.get("exitCode").is_none());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn records_the_exit_code_of_a_finished_command() {
        let dir = tempfile::tempdir().unwrap();
        let shells = BackgroundShells::default();
        let shell_id = shell::catalog(None)
            .effective
            .map(|option| option.id)
            .unwrap_or_else(|| shell::default_shell_id().to_string());
        let mut options = BashExecutionOptions::local(shell_id, None);
        options.session_id = "s1".into();
        let started = shells
            .start(
                Some(dir.path()),
                None,
                &json!({ "command": "echo done; exit 3" }),
                options,
            )
            .await
            .unwrap();
        let id = started["backgroundId"].as_str().unwrap().to_string();
        let mut last = Value::Null;
        for _ in 0..100 {
            last = shells.view("s1", &id).unwrap();
            if last["status"] != "running" {
                break;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        assert_eq!(last["status"], "exited");
        assert_eq!(last["exitCode"], 3);
        assert!(last["output"].as_str().unwrap().contains("done"));
    }
}
