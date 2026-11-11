/**
 * mc-agent (#116): which tool batches may run concurrently.
 *
 * pi runs a batch sequentially as soon as it holds one sequential tool, so a
 * batch only fans out when every call in it is marked parallel. Keeping the
 * decision in one table means a new tool is sequential until someone argues
 * otherwise here.
 *
 * Only tools host-core already treats as read-only qualify. Bash never does,
 * however harmless the command looks, and plugin, MCP and extension tools stay
 * sequential because nothing proves they are free of side effects.
 */
export const PARALLEL_READ_ONLY_TOOLS: ReadonlySet<string> = new Set([
  "Read",
  "Glob",
  "Grep",
]);

export type ToolExecutionMode = "parallel" | "sequential";

/** Execution mode for a catalog tool; `fanOutToolName` is the subagent tool. */
export function toolExecutionModeFor(
  toolName: string,
  fanOutToolName: string,
): ToolExecutionMode {
  return toolName === fanOutToolName || PARALLEL_READ_ONLY_TOOLS.has(toolName)
    ? "parallel"
    : "sequential";
}
