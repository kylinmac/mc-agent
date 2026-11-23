import type { SubagentRun } from "./assistant-turns";
import type { UiMessage } from "@pi-desktop/shared";
import { toolResultPayload } from "./tool-presentation";

/**
 * The stable delegation id a transcript row is keyed by: the Task result's
 * `delegationId` when the runtime recorded one, else the call's own identity.
 * Shared by the delegation topology and the subagent transcript tab.
 */
export function delegationIdForMessage(message: UiMessage): string {
  const payload = toolResultPayload(message);
  if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    const delegationId = (payload as { delegationId?: unknown }).delegationId;
    if (typeof delegationId === "string" && delegationId) return delegationId;
  }
  return message.toolCallId || message.id;
}

export function delegateAgentName(
  message: UiMessage,
  delegate?: SubagentRun,
): string {
  if (delegate?.agentName) return delegate.agentName;
  const args = message.toolArgs;
  if (args && typeof args === "object" && !Array.isArray(args)) {
    const requested = (args as { agent?: unknown }).agent;
    if (typeof requested === "string") return requested;
  }
  return "";
}
