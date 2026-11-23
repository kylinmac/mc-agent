use crate::transcripts::CompactionRecord;
use anyhow::{anyhow, Result};
use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const MODES: [&str; 3] = ["plan", "goal", "agent"];

/// Maximum number of Unicode scalar values accepted for a user-defined title.
pub const MAX_SESSION_TITLE_CHARS: usize = 80;
pub(super) const TITLE_SOURCE_DEFAULT: &str = "default";
pub(super) const TITLE_SOURCE_MANUAL: &str = "manual";
pub(super) const TITLE_SOURCE_GENERATED: &str = "generated";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AutoTitleContext {
    pub session_id: String,
    pub expected_title: String,
    pub user_prompt: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub assistant_reply: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model_key: Option<String>,
}

/// Compatibility normalization for v7 callers and imported records. The
/// persisted operating profile is now always `plan`, `goal` or `agent`.
pub fn normalize_mode(mode: Option<&str>) -> String {
    match mode {
        Some("plan") | Some("chat") => "plan".into(),
        Some("goal") => "goal".into(),
        Some("agent") => "agent".into(),
        _ => "agent".into(),
    }
}

pub fn is_valid_mode(mode: &str) -> bool {
    MODES.contains(&mode)
}

/// Plan and Goal negotiate a contract before executing (D198), so they share one
/// tool allowlist and one hard deny. Agent is the only executing mode.
pub fn is_contract_mode(mode: &str) -> bool {
    matches!(mode, "plan" | "goal")
}

/// Values accepted by the persisted per-session thinking selector.  Keep this
/// list in the host boundary so old clients cannot write arbitrary provider
/// options into the session row. `omit` is a client choice to send no thinking
/// override; it is not a catalog/binding capability (ADR 0295).
pub const THINKING_LEVELS: [&str; 8] = [
    "off", "minimal", "low", "medium", "high", "xhigh", "max", "omit",
];

pub fn is_valid_thinking_level(level: &str) -> bool {
    THINKING_LEVELS.contains(&level)
}

pub(super) fn default_thinking_level() -> String {
    "off".to_string()
}

/// Per-session permission mode (D115). `inherit` defers to the global
/// default in settings; the rest override it for this session only.
pub const PERMISSION_MODES: [&str; 4] = ["inherit", "ask", "accept-edits", "auto"];

pub fn is_valid_permission_mode(mode: &str) -> bool {
    PERMISSION_MODES.contains(&mode)
}

pub(super) fn default_permission_mode() -> String {
    "inherit".to_string()
}

pub(super) fn validate_permission_mode(mode: &str) -> Result<()> {
    if is_valid_permission_mode(mode) {
        Ok(())
    } else {
        Err(anyhow!(
            "permissionMode must be one of {}",
            PERMISSION_MODES.join(", ")
        ))
    }
}

pub(super) fn validate_thinking_level(level: &str) -> Result<()> {
    if is_valid_thinking_level(level) {
        Ok(())
    } else {
        Err(anyhow!(
            "thinkingLevel must be one of {}",
            THINKING_LEVELS.join(", ")
        ))
    }
}

/// Wire format is unchanged from v1: RFC3339 timestamps, `projectPath`
/// resolved from the projects table, flat tool fields on messages. Storage is
/// schema v7 (D119): transcript content lives in per-session JSONL files and
/// SQLite keeps session metadata plus per-message index rows (`seq`, `text`
/// for FTS, promoted filter columns).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionSummary {
    pub id: String,
    pub title: String,
    /// Number of messages in the current canonical transcript. This is the
    /// current value of the session's last_seq allocator after rewrites.
    #[serde(default)]
    pub message_count: i64,
    pub project_path: Option<String>,
    pub model_id: Option<String>,
    pub provider_id: Option<String>,
    pub mode: String,
    #[serde(default = "default_thinking_level")]
    pub thinking_level: String,
    #[serde(default = "default_permission_mode")]
    pub permission_mode: String,
    pub updated_at: String,
    pub created_at: String,
    /// True when this session is the transcript owned by a scheduled-task run.
    /// Automation transcripts are entered from the Scheduled page, so the
    /// sidebar and session search hide them (issue #1291). The value is derived
    /// from `task_runs.session_id` on read; no session column stores it, and
    /// deleting the task frees its sessions back into the ordinary lists.
    #[serde(default)]
    pub scheduled_run: bool,
    /// The session's isolated worktree (ADR 0329); absent for every other
    /// session. Filled in by the list and single-summary reads.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub worktree: Option<crate::session_worktrees::lifecycle::WorktreeSummary>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MessageUsage {
    pub input_tokens: i64,
    pub output_tokens: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cache_read_tokens: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cache_write_tokens: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reasoning_tokens: Option<i64>,
    pub total_tokens: i64,
    /// Additive accounting provenance and atomic operation ledger. Preserve these
    /// JSON fields verbatim, including fields introduced by a newer producer.
    #[serde(default, flatten)]
    pub accounting: serde_json::Map<String, Value>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MessageAttachment {
    pub kind: String,
    pub name: String,
    #[serde(rename = "ref")]
    pub reference: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mime_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub size: Option<i64>,
    /// Bounded excerpt of a referenced conversation (`kind: "session"`), written
    /// by Electron main when the prompt carried a `pi-desktop://session/<id>`
    /// link. Travels with the user message so the model keeps reading it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    /// The `@path` text this attachment occupies inside the message content when
    /// the user placed it between words. The transcript renders the attachment
    /// at that position instead of appending it after the body.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub inline_path: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UiMessage {
    pub id: String,
    pub role: String,
    pub content: String,
    /// Original text for a slash template or Skill invocation.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub command: Option<String>,
    /// Validated Skill tokens in `command`, with UTF-16 offsets for the renderer.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub skill_mentions: Option<Vec<SkillMention>>,
    /// Host-authenticated agent-to-agent origin, never a human authorization.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_message: Option<Value>,
    /// Minimal provenance for an accepted Live Voice work input.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub voice_origin: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub attachments: Option<Vec<MessageAttachment>>,
    /// Accepted input to an existing turn, preserved by Stop after renderer reload.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub steering: Option<bool>,
    pub created_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub thinking: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub provider_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub usage: Option<MessageUsage>,
    /// Elapsed model streaming time for the response throughput statistic.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub response_duration_ms: Option<i64>,
    /// Partial output estimate used when a user stops before final usage arrives.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub response_output_tokens: Option<i64>,
    /// Why the model ended this response ("stop", "length", "toolUse", ...),
    /// plus the provider's own spelling when it differs. A reply cut by the
    /// output limit reads as finished text without it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stop_reason: Option<Value>,
    /// Structured AppError for an assistant turn that failed.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<Value>,
    /// Stable regenerate-family key shared across rewritten user prompts.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub revision_root_id: Option<String>,
    /// For user messages that own regenerate history: total revision count.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub revision_count: Option<i64>,
    /// 1-based active revision index for the branch rooted at this user turn.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub active_revision: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_call_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_status: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_args: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_result: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_completed_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_duration_ms: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub is_error: Option<bool>,
    /// Set on rows a subagent produced: the `Task` tool call that spawned it
    /// (ADR 0062). The transcript nests these under that call, and the agent
    /// runtime excludes them from the parent's model context.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parent_tool_call_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub nested_parent_tool_call_id: Option<String>,
    /// Subagent definition name that produced the row.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub agent_name: Option<String>,
    /// Provider-hosted web search activity for this assistant turn. Persisted
    /// as an additive `hostedSearch` transcript block; no SQL migration.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hosted_search: Option<Value>,
    /// Internal model-context state, preserved outside visible message text.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model_system: Option<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillMention {
    pub start: usize,
    pub end: usize,
    pub id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionDetail {
    #[serde(flatten)]
    pub summary: SessionSummary,
    pub messages: Vec<UiMessage>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub plan_history: Vec<crate::plans::PlanHistoryEntry>,
    /// Owning Task for a nested messageAround target, outside the page cursors.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub navigation_parent: Option<UiMessage>,
    /// Task anchors for this page's children and roster, outside its cursors.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub message_parents: Vec<UiMessage>,
    /// Zero-based offset of the first returned message when the caller asked
    /// for a window. Omitted for the full-history form.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message_start: Option<i64>,
    /// Exclusive physical end of a bounded read, including deduplicated lines.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message_end: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub has_more_after: Option<bool>,
    /// True when older messages exist outside the returned window.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub has_more_before: Option<bool>,
    /// The checkpoint that governs the next model request, i.e. the last of
    /// `compactions`. Kept as its own field because that is what the runtime
    /// restores on load.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub compaction: Option<CompactionRecord>,
    /// The whole checkpoint chain, oldest first, so the transcript can show one
    /// row per compaction.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub compactions: Vec<CompactionRecord>,
}

#[derive(Debug, Clone, Default)]
pub struct SessionReadOptions {
    /// Center a bounded UI read on this stable message ID.
    pub message_around: Option<String>,
    /// Exclusive message sequence before which the window ends. When omitted,
    /// the window is taken from the end of the canonical transcript.
    pub message_before: Option<i64>,
    pub message_limit: Option<i64>,
    /// Maximum characters per UI text/value field. This is a presentation cap;
    /// the full transcript remains available to the sidecar's uncapped read.
    pub content_limit: Option<usize>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchHit {
    pub session_id: String,
    pub session_title: String,
    pub message_id: String,
    pub role: String,
    pub snippet: String,
    pub created_at: String,
}
