import type { UiMessage } from "@pi-desktop/shared";
import type { AssistantActivityItem } from "../../lib/assistant-turns";
import { delegationIdForMessage } from "../../lib/subagent-panel";
import {
  collectDelegationStatuses,
  collectDelegationTimings,
  delegationIsCreating,
  isDelegationActivityItem,
  subagentOutcome,
  type SubagentOutcome,
} from "../../lib/subagent-topology";
import { delegateAgentName } from "../chat/transcript/model";

/*
  mc-agent session info: the conversation's `Task` subagents (ADR 0062/0089),
  read from its transcript with the same status rules as the conversation's
  subagent cards, so the panel and the cards never disagree. Workers created
  as their own sessions are listed separately from host-core's relationships.
*/

export type SessionSubagent = {
  delegationId: string;
  agentName: string;
  /** "creating" while the delegate is still being spawned. */
  status: SubagentOutcome | "creating";
  startedAt?: number;
  completedAt?: number;
};

export function sessionSubagents(
  messages: readonly UiMessage[],
  options: { turnLive: boolean },
): SessionSubagent[] {
  // Only the parent's own rows: a delegate's rows carry its parent call id.
  const items: AssistantActivityItem[] = messages
    .filter((message) => message.role === "tool" && !message.parentToolCallId)
    .map((message) => ({ kind: "tool", message }));
  const statuses = collectDelegationStatuses(items, { turnLive: options.turnLive });
  const timings = collectDelegationTimings(items);
  const seen = new Set<string>();
  const list: SessionSubagent[] = [];
  for (const item of items) {
    if (!isDelegationActivityItem(item)) continue;
    const delegationId = delegationIdForMessage(item.message);
    if (seen.has(delegationId)) continue;
    seen.add(delegationId);
    const outcome = subagentOutcome(item.message, statuses);
    const timing = timings.get(delegationId);
    list.push({
      delegationId,
      agentName: delegateAgentName(item.message),
      status: outcome === "running" && delegationIsCreating(item.message) ? "creating" : outcome,
      ...(timing?.startedAt !== undefined ? { startedAt: timing.startedAt } : {}),
      ...(timing?.completedAt !== undefined ? { completedAt: timing.completedAt } : {}),
    });
  }
  return list;
}

/** Elapsed seconds as a short label: 42s, 3m 05s, 1h 02m. */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  if (total < 60) return `${total}s`;
  const minutes = Math.floor(total / 60);
  if (minutes < 60) return `${minutes}m ${String(total % 60).padStart(2, "0")}s`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}
