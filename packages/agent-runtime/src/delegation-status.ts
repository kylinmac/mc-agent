import type {
  AgentActivity,
  AgentActivityAgent,
  AgentActivityAgentPhase,
  SubagentRunStatus,
  SubagentThinkingLevel,
  UiMessage,
} from "@pi-desktop/shared";
import { type SubagentRunResult } from "./subagent.js";


export type DelegationStatus =
  | "running"
  | SubagentRunStatus
  | "stopped";

/**
 * One background delegation owned by the session runtime. `completion`
 * resolves when the delegate settles; `abort` stops the delegate's agent.
 */
export type DelegationRecord = {
  delegationId: string;
  /**
   * Chain id under which host-core keeps this Write/Edit subagent's own git
   * worktree in an isolated session (ADR 0329); absent otherwise.
   */
  worktreeKey?: string;
  /** Original Task transcript snapshot, available after its immediate result. */
  taskMessage?: UiMessage;
  taskTurnId?: string;
  agentName: string;
  modelId: string;
  thinkingLevel: SubagentThinkingLevel;
  status: DelegationStatus;
  startedAt: number;
  completedAt?: number;
  result?: SubagentRunResult;
  completion: Promise<void>;
  resolveCompletion: () => void;
  abort: () => void;
  /** True when `TaskStop` asked for this stop, so an aborted run reads as
   * `stopped` rather than `aborted`. */
  stopRequested: boolean;
  /** System interruption preserves resume eligibility; explicit Stop wins. */
  parentErrorInterrupted?: boolean;
  turns: number;
  toolCalls: number;
  lastToolName?: string;
  lastPhase?: AgentActivityAgentPhase;
  lastActivityAt: number;
  /** `prompt()` / `executeApprovedPlan()` generation that started this run.
   * Resume-after-idle only waits for the current turn's delegates (D352). */
  startedEpoch: number;
  /** The settled report reached the parent's context once: through a
   * `TaskWait` result or the resume-after-idle prompt. Auto-delivery is a
   * single shot per record. */
  reportDelivered: boolean;
  /** Stable chain identity; never appears in a tool parameter (ADR 0279). */
  delegateSessionId: string;
  /** Prior `delegationId` this run continues, when `Task.resume` was set. */
  resumedFrom?: string;
  /** Model the run kept before the resume could not re-resolve it (ADR 0279
   * §4): recorded so the parent can see that the delegate's binding moved. */
  modelChangedFrom?: string;
  /** `toolCallId`s of this run's calls that have not ended yet: dropped when the
   * run settles, so an aborted call cannot pin its captured arguments. */
  pendingToolCallIds?: Set<string>;
};


/**
 * A `TaskWait` result is the parent's context; like a delegate's report, it
 * must not become the context problem delegation exists to avoid.
 */
const MAX_TASKWAIT_RESULT_CHARS = 50_000;

export function delegationSummary(record: DelegationRecord): Record<string, unknown> {
  return {
    delegationId: record.delegationId,
    agent: record.agentName,
    modelId: record.modelId,
    thinkingLevel: record.thinkingLevel,
    status: record.status,
    startedAt: record.startedAt,
    turns: record.result?.turns ?? record.turns,
    toolCalls: record.result?.toolCalls ?? record.toolCalls,
    ...(record.lastToolName ? { lastToolName: record.lastToolName } : {}),
    ...(record.completedAt ? { completedAt: record.completedAt } : {}),
    ...(record.result?.modelFailures ? { modelFailures: record.result.modelFailures } : {}),
    ...(record.result?.error ? { error: record.result.error } : {}),
    // A delegate that compacted or lost history says so in its lifecycle
    // details, not only in the report text (ADR 0299, decision 4).
    ...(record.result?.contextCompactions
      ? { contextCompactions: record.result.contextCompactions }
      : {}),
    ...(record.result?.contextDegraded
      ? { contextDegraded: record.result.contextDegraded }
      : {}),
    ...(record.result?.scratchReportPath
      ? { scratchReportPath: record.result.scratchReportPath }
      : {}),
    ...(record.resumedFrom ? { resumedFrom: record.resumedFrom } : {}),
    ...(record.modelChangedFrom
      ? { modelChangedFrom: record.modelChangedFrom }
      : {}),
  };
}

function elapsedSeconds(record: DelegationRecord, now = Date.now()): number {
  const end = record.completedAt ?? now;
  return Math.max(1, Math.round((end - record.startedAt) / 1000));
}

export function agentActivityEqual(
  left?: AgentActivity,
  right?: AgentActivity,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function waitingSubagentSnapshot(
  record: DelegationRecord,
): AgentActivityAgent {
  return {
    name: record.agentName,
    ...(record.lastPhase ? { lastPhase: record.lastPhase } : {}),
    ...(record.lastToolName ? { lastToolName: record.lastToolName } : {}),
  };
}

export function waitingSubagentsActivity(
  targets: DelegationRecord[],
  since: number,
): Extract<AgentActivity, { phase: "waiting-subagents" }> {
  const running = targets.filter((record) => record.status === "running");
  return {
    phase: "waiting-subagents",
    since,
    subagentCount: running.length,
    ...(running.length > 0
      ? { agents: running.map(waitingSubagentSnapshot) }
      : {}),
  };
}

export function formatDelegationHeartbeat(record: DelegationRecord): string {
  const parts = [
    `${record.agentName} (${record.delegationId})`,
    record.status,
    `${elapsedSeconds(record)}s`,
  ];
  const turns = record.result?.turns ?? record.turns;
  const toolCalls = record.result?.toolCalls ?? record.toolCalls;
  if (turns > 0) parts.push(`${turns} turns`);
  if (toolCalls > 0) parts.push(`${toolCalls} tool calls`);
  if (record.lastToolName) parts.push(`last tool ${record.lastToolName}`);
  return parts.join(", ");
}

export const DELEGATION_RESUME_PROMPT =
  "The following subagents have finished. Integrate their reports and continue the user's original task. Call TaskStop only if you have decided a still-running delegate should not continue.";

/** Join delegation results into one bounded text block for the model. */
export function formatDelegationResults(
  results: Array<{ delegationId: string; agent: string; status: string; report: string }>,
  note?: string,
): { text: string; includedDelegationIds: Set<string> } {
  const parts: string[] = [];
  const includedDelegationIds = new Set<string>();
  let total = 0;
  let omitted = 0;
  for (const result of results) {
    const block = `## ${result.agent} (${result.delegationId}) — ${result.status}\n${result.report}`;
    if (total + block.length > MAX_TASKWAIT_RESULT_CHARS) {
      omitted += 1;
      continue;
    }
    parts.push(block);
    includedDelegationIds.add(result.delegationId);
    total += block.length + 2;
  }
  if (omitted > 0) {
    parts.push(
      `[${omitted} more result${omitted === 1 ? "" : "s"} omitted to protect this context; call TaskWait with their delegationIds to re-read one.]`,
    );
  }
  return {
    text: [note, ...parts].filter((part) => part?.trim()).join("\n\n"),
    includedDelegationIds,
  };
}
