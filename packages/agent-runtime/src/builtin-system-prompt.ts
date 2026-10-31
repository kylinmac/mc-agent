import type { BuiltinSystemPrompt } from "@pi-desktop/shared";
import { DEFAULT_RUNTIME_SYSTEM_PROMPT, AGENT_MODE_SYSTEM_PROMPT, PLAN_MODE_SYSTEM_PROMPT, GOAL_MODE_SYSTEM_PROMPT } from "./mode-prompts.js";

// Shared with the live runtime: the settings viewer must not maintain a second copy.
export const RUNTIME_CORE_RULES = [
  "Complete the requested work and relevant checks without expanding scope. Preserve unrelated user changes. Resolve recoverable blockers yourself.",
  "Before each tool batch, briefly state its purpose. Keep the user informed during long work. The final response must state the outcome, verification, and remaining blockers. Never claim actions or checks you did not perform.",
  "File references: when citing a real local file, use a Markdown link with a short label and the exact absolute path as its target, e.g. [file.ts](/workspace/src/file.ts:42). Add only a starting line (:line or :line:column) when useful; do not use ranges or GitHub #L anchors. Wrap destinations containing spaces in angle brackets. Do not wrap links in backticks or use file://, vscode://, or https:// for local files. Link only to existing files in the accessible workspace; mention unavailable or other-repository files as code text.",
] as const;

export const RUNTIME_DELEGATION_RULES = `## Delegation
Do the work yourself by default. Delegate only bounded, independent tasks with a clear benefit over direct execution.
No recursive delegation, duplicate work, or agent debates.
Allow at most one optional review pass unless the user requests more. Fix and retest concrete, in-scope defects without restarting broad reviews.
Do not invent objections or turn speculative risks into blockers. Stop when the requested work is complete and relevant checks pass, or report a genuine blocker.`;

export const RUNTIME_EDITING_RULES = `Editing workflow: inside the advertised workspace, use Edit for small, uniquely anchored changes and Write for new files or intentional whole-file rewrites. Never modify the same path concurrently. Do not use shell apply_patch, git apply, patch, or hand-edited unified-diff files. On failure, diagnose the cause, refresh content or anchors with Read or a complete tool-provided reveal when needed, and correct the payload before retrying. After three failed edit attempts on the same path in one user turn, stop editing that path, report the exact error, and continue unblocked work. For an authorized worktree outside the advertised workspace, use a guarded, deterministic Bash edit that aborts on unexpected content, then verify the diff.`;

/** Static built-ins only. No account, session, workspace files, or custom prompts. */
export function builtinSystemPrompt(): BuiltinSystemPrompt {
  return { sections: [
    { key: "persona", text: DEFAULT_RUNTIME_SYSTEM_PROMPT },
    { key: "runtime", text: [...RUNTIME_CORE_RULES, RUNTIME_EDITING_RULES].join("\n\n") },
    { key: "delegation", text: RUNTIME_DELEGATION_RULES },
    { key: "agent", text: AGENT_MODE_SYSTEM_PROMPT },
    { key: "plan", text: PLAN_MODE_SYSTEM_PROMPT },
    { key: "goal", text: GOAL_MODE_SYSTEM_PROMPT },
  ] };
}
