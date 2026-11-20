/**
 * mc-agent (R39): read-only programmatic tool orchestration (`RunScript`).
 *
 * Allows the model to run a short sandboxed JS script that batches read-only
 * tool calls (`callTool`, `listTools`) and aggregates/filters results in memory,
 * returning only the concise console output to the main conversation context.
 */

export const RUN_SCRIPT_TOOL_NAME = "RunScript";
export const PROGRAMMATIC_TOOLS_SKILL_ID = "mc-agent/programmatic-tools";

export const RUN_SCRIPT_MAX_CODE_CHARS = 32_000;
export const RUN_SCRIPT_DEFAULT_TIMEOUT_MS = 30_000;
export const RUN_SCRIPT_MAX_TIMEOUT_MS = 120_000;
export const RUN_SCRIPT_MIN_TIMEOUT_MS = 1_000;
export const RUN_SCRIPT_MAX_CALLS = 100;
export const RUN_SCRIPT_MAX_OUTPUT_CHARS = 16_000;

export type RunScriptSubCallSummary = {
  tool: string;
  count: number;
  failed: number;
};

export type RunScriptResultDetails = {
  kind: "run-script";
  durationMs: number;
  totalCalls: number;
  truncated: boolean;
  calls: RunScriptSubCallSummary[];
};

/** Built-in tools that are unconditionally read-only and safe to batch in `RunScript`. */
export const RUN_SCRIPT_READ_ONLY_TOOLS: ReadonlySet<string> = new Set([
  "Read",
  "Glob",
  "Grep",
  "CanvasRead",
  "WorkPanelList",
  "WorkPanelRead",
  "ContextHistory",
  "ProjectHistory",
  "ProjectTemplates",
  "ResolveRef",
]);

/** Tools whose read-only safety depends on their `action` argument. */
const ACTION_GATED_READ_ONLY_TOOLS: Readonly<Record<string, ReadonlySet<string>>> = {
  ProjectTasks: new Set(["list", "get"]),
  ProjectResources: new Set(["list", "overview", "read"]),
};

/** Tools that must always be called directly so they stay observable or guarded. */
const EXPLICITLY_DIRECT_TOOLS: ReadonlySet<string> = new Set([
  "Task",
  "SubagentRun",
  "SubagentWait",
  "SubagentList",
  "SubagentStop",
  "AskUserQuestion",
  "CreateProject",
  "ProposeAlchemyArtifact",
  RUN_SCRIPT_TOOL_NAME,
]);

export type RunScriptToolAccess =
  | { allowed: true }
  | { allowed: false; reason: string };

/**
 * Decide whether `RunScript` may invoke `toolName` with `args`.
 *
 * Phase 1 strictly limits `RunScript` to read-only tools so batched loops never
 * mutate files, run arbitrary shell commands, or trigger approval storms.
 */
export function checkRunScriptToolAccess(
  toolName: string,
  args?: Record<string, unknown>,
): RunScriptToolAccess {
  if (!toolName || typeof toolName !== "string") {
    return { allowed: false, reason: "Tool name must be a non-empty string." };
  }
  if (EXPLICITLY_DIRECT_TOOLS.has(toolName)) {
    return {
      allowed: false,
      reason: `Tool "${toolName}" cannot be called inside RunScript; call it directly so it remains observable and properly guarded.`,
    };
  }
  if (RUN_SCRIPT_READ_ONLY_TOOLS.has(toolName)) {
    return { allowed: true };
  }
  const allowedActions = ACTION_GATED_READ_ONLY_TOOLS[toolName];
  if (allowedActions) {
    const action = typeof args?.action === "string" ? args.action : "";
    if (allowedActions.has(action)) {
      return { allowed: true };
    }
    return {
      allowed: false,
      reason: `Tool "${toolName}" inside RunScript only allows read-only actions (${[...allowedActions].join(", ")}); call it directly for mutating actions.`,
    };
  }
  return {
    allowed: false,
    reason: `Tool "${toolName}" is not in the RunScript read-only allowlist; call it directly instead.`,
  };
}

/** True when a tool has at least one read-only entry point usable from `RunScript`. */
export function isRunScriptDiscoverableTool(toolName: string): boolean {
  return RUN_SCRIPT_READ_ONLY_TOOLS.has(toolName) || toolName in ACTION_GATED_READ_ONLY_TOOLS;
}

export function clampRunScriptTimeout(timeoutMs: unknown): number {
  if (typeof timeoutMs !== "number" || !Number.isFinite(timeoutMs)) {
    return RUN_SCRIPT_DEFAULT_TIMEOUT_MS;
  }
  const rounded = Math.round(timeoutMs);
  if (rounded < RUN_SCRIPT_MIN_TIMEOUT_MS) return RUN_SCRIPT_MIN_TIMEOUT_MS;
  if (rounded > RUN_SCRIPT_MAX_TIMEOUT_MS) return RUN_SCRIPT_MAX_TIMEOUT_MS;
  return rounded;
}
