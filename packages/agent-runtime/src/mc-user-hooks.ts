import { spawn } from "node:child_process";
import type { McUserHook, McUserHookEvent } from "@pi-desktop/shared";

/**
 * mc-agent (MC-ADR-0021): shell commands the user configured to run at fixed
 * points of a turn. Unlike instructions in a prompt, these always run.
 *
 * - `PreToolUse` runs before a matching tool call; exit code 2 blocks the
 *   call and its stderr (or stdout) is the reason the model reads.
 * - `PostToolUse` runs after a matching tool call; exit code 2 appends its
 *   output to the tool result, e.g. a formatter or linter complaining.
 * - `Stop` runs when the agent is about to end its turn; exit code 2 sends
 *   its output back as feedback and the agent keeps working (at most
 *   `MAX_STOP_CONTINUATIONS` times per prompt).
 *
 * Any other exit code is ignored, so a broken hook never stalls a turn. The
 * event is passed in environment variables; commands run in the session's
 * workspace through the user's shell.
 */

export const MAX_STOP_CONTINUATIONS = 3;
const DEFAULT_TIMEOUT_SECONDS = 60;
const MAX_TIMEOUT_SECONDS = 600;
/** Per environment value and per captured stream. */
const MAX_TEXT = 64 * 1024;
const FEEDBACK_CHARS = 4_000;

export type HookRun = { exitCode: number | null; stdout: string; stderr: string; timedOut: boolean };
export type HookRunner = (command: string, options: { cwd: string; env: Record<string, string>; timeoutMs: number; signal?: AbortSignal }) => Promise<HookRun>;

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

function stringify(value: unknown): string {
  if (typeof value === "string") return clip(value, MAX_TEXT);
  try {
    return clip(JSON.stringify(value) ?? "", MAX_TEXT);
  } catch {
    return "";
  }
}

/** Whether a hook applies; a matcher is a regular expression over the whole tool name. */
export function hookMatches(hook: McUserHook, event: McUserHookEvent, toolName?: string): boolean {
  if (hook.event !== event || hook.enabled === false || !hook.command.trim()) return false;
  const matcher = hook.matcher?.trim();
  if (!matcher || matcher === "*" || event === "Stop") return true;
  try {
    return new RegExp(`^(?:${matcher})$`).test(toolName ?? "");
  } catch {
    return false;
  }
}

/** Run a command through the user's shell, killing its process group on timeout or abort. */
export const shellHookRunner: HookRunner = (command, { cwd, env, timeoutMs, signal }) =>
  new Promise((resolve) => {
    const windows = process.platform === "win32";
    const child = windows
      ? spawn(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", command], { cwd, env: { ...process.env, ...env }, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] })
      : spawn(process.env.SHELL || "/bin/sh", ["-lc", command], { cwd, env: { ...process.env, ...env }, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const kill = () => {
      if (!child.pid || child.exitCode !== null) return;
      try {
        if (windows) spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
        else process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, timeoutMs);
    signal?.addEventListener("abort", kill, { once: true });
    child.stdout.on("data", (chunk: Buffer) => { if (stdout.length < MAX_TEXT) stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk: Buffer) => { if (stderr.length < MAX_TEXT) stderr += chunk.toString("utf8"); });
    const done = (exitCode: number | null) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", kill);
      resolve({ exitCode, stdout, stderr, timedOut });
    };
    child.once("error", (error) => {
      stderr += String(error);
      done(null);
    });
    child.once("close", (code) => done(code));
  });

export type HookEventInput = {
  event: McUserHookEvent;
  sessionId: string;
  cwd: string;
  toolName?: string;
  toolInput?: unknown;
  toolResult?: unknown;
  /** The agent's last reply, for `Stop`. */
  lastReply?: string;
  signal?: AbortSignal;
};

/**
 * Run every matching hook in order. Returns the feedback of the hooks that
 * exited with 2, joined; for `PreToolUse` the first such hook decides.
 */
export async function runUserHooks(
  hooks: readonly McUserHook[],
  input: HookEventInput,
  runner: HookRunner = shellHookRunner,
): Promise<string | undefined> {
  const matching = hooks.filter((hook) => hookMatches(hook, input.event, input.toolName));
  const feedback: string[] = [];
  for (const hook of matching) {
    if (input.signal?.aborted) break;
    const seconds = Math.min(MAX_TIMEOUT_SECONDS, Math.max(1, hook.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS));
    const env: Record<string, string> = {
      MC_HOOK_EVENT: input.event,
      MC_SESSION_ID: input.sessionId,
      MC_PROJECT_DIR: input.cwd,
      ...(input.toolName ? { MC_TOOL_NAME: input.toolName } : {}),
      ...(input.toolInput !== undefined ? { MC_TOOL_INPUT: stringify(input.toolInput) } : {}),
      ...(input.toolResult !== undefined ? { MC_TOOL_RESULT: stringify(input.toolResult) } : {}),
      ...(input.lastReply !== undefined ? { MC_LAST_REPLY: clip(input.lastReply, MAX_TEXT) } : {}),
    };
    const run = await runner(hook.command, { cwd: input.cwd, env, timeoutMs: seconds * 1000, signal: input.signal })
      .catch((error): HookRun => ({ exitCode: null, stdout: "", stderr: String(error), timedOut: false }));
    if (run.exitCode !== 2 || run.timedOut) continue;
    const text = (run.stderr.trim() || run.stdout.trim() || `Hook "${clip(hook.command, 80)}" exited with code 2.`);
    feedback.push(clip(text, FEEDBACK_CHARS));
    if (input.event === "PreToolUse") break;
  }
  return feedback.length ? feedback.join("\n\n") : undefined;
}

/** The text the model reads for a hook's feedback. */
export function hookFeedbackText(event: McUserHookEvent, feedback: string): string {
  switch (event) {
    case "PreToolUse":
      return `Blocked by a user-configured hook:\n${feedback}`;
    case "PostToolUse":
      return `[User-configured hook after this tool call]\n${feedback}`;
    case "Stop":
      return `[Automatic notice from a user-configured hook, not a message from the user] Before finishing, address this:\n${feedback}`;
  }
}
