import { createHash } from "node:crypto";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { LocalRequestError } from "@earendil-works/pi-ai";
import { normalizeHostedSearchContent } from "@earendil-works/pi-ai/utils/hosted-search";
import type { ContextCompactionRecord, UiMessage } from "@pi-desktop/shared";
import type { MessageEntry } from "./pi-runtime-types.js";

export function contextIdKey(id: string | undefined): string | undefined {
  return id === undefined ? undefined : createHash("sha256").update(id).digest("hex").slice(0, 24);
}

/** Fixed reasons only: never derive diagnostic fields from message text. */
function exclusion(message: UiMessage): string | undefined {
  if (message.parentToolCallId) return "delegate";
  if (message.role === "system") return "system";
  if (message.role === "tool") return message.toolCallId && message.toolName ? undefined : "incomplete_tool";
  if (message.role === "user") {
    return message.content?.trim() || message.attachments?.some((a) => a.data) ? undefined : "empty_user";
  }
  if (message.role === "assistant") {
    if (message.status === "error" || message.isError || message.error) return "failed_assistant";
    if (message.content?.trim() || message.thinking?.trim()) return undefined;
    const replay = message.hostedSearch?.replay;
    if (Array.isArray(replay) && replay.length) {
      try {
        replay.forEach((block) => normalizeHostedSearchContent(block));
        return undefined;
      } catch { return "unreplayable_assistant"; }
    }
    // Empty tool-call carriers are checked through their persisted tool rows.
    return "empty_assistant";
  }
  return "unsupported_role";
}

export function inspectContextRestore(input: {
  history: readonly UiMessage[];
  entries: readonly MessageEntry[];
  messages: readonly AgentMessage[];
  checkpoint?: ContextCompactionRecord;
}) {
  const boundary = input.checkpoint
    ? input.history.findIndex((message) => message.id === input.checkpoint?.throughMessageId)
    : -1;
  const exclusions: Record<string, number> = {};
  const expected: string[] = [];
  for (const message of input.history.slice(boundary + 1)) {
    const reason = exclusion(message);
    if (reason) exclusions[reason] = (exclusions[reason] ?? 0) + 1;
    else expected.push(message.id);
  }
  const expectedIds = new Set(expected);
  const identity = new Map(input.entries.map((entry) => [entry.message, entry.id]));
  const actual = input.messages.map((message) => identity.get(message))
    .filter((id): id is string => id !== undefined && expectedIds.has(id));
  const actualIds = new Set(actual);
  const missing = expected.filter((id) => !actualIds.has(id));
  const reordered = missing.length === 0 && (actual.length !== expected.length || expected.some((id, index) => actual[index] !== id));
  const boundaryMissing = input.checkpoint !== undefined && boundary < 0;
  return {
    ok: !boundaryMissing && missing.length === 0 && !reordered,
    historyCount: input.history.length,
    expectedCount: expected.length,
    restoredCount: input.messages.length,
    matchedCount: actual.length,
    missingCount: missing.length,
    missingKeys: missing.slice(0, 5).map((id) => contextIdKey(id)),
    reordered,
    boundaryMissing,
    exclusions,
    checkpointKey: contextIdKey(input.checkpoint?.id),
    boundaryKey: contextIdKey(input.checkpoint?.throughMessageId),
  };
}

/** Inspect each candidate before installing it; a second failure never reaches the model. */
export function verifiedContextRestore(
  history: readonly UiMessage[],
  entries: readonly MessageEntry[],
  checkpoint: ContextCompactionRecord | undefined,
  build: (checkpoint: ContextCompactionRecord | undefined) => AgentMessage[],
  report: (data: ReturnType<typeof inspectContextRestore> & { attempt: number; fallback: boolean }) => void,
): { checkpoint?: ContextCompactionRecord; messages: AgentMessage[] } {
  const candidates = checkpoint ? [checkpoint, undefined] : [undefined];
  for (const [attempt, candidate] of candidates.entries()) {
    const messages = build(candidate);
    const check = inspectContextRestore({ history, entries, messages, checkpoint: candidate });
    report({ ...check, attempt: attempt + 1, fallback: attempt > 0 });
    if (check.ok) return { checkpoint: candidate, messages };
  }
  throw new LocalRequestError("context-validation");
}

/** This is the provider-neutral request, not the adapter payload or server receipt. */
export function contextRequestShape(messages: readonly { role: string }[], tokens: number) {
  const roleCounts: Record<string, number> = {};
  for (const { role } of messages) {
    const key = ["system", "user", "assistant", "toolResult"].includes(role) ? role : "other";
    roleCounts[key] = (roleCounts[key] ?? 0) + 1;
  }
  return { requestCount: messages.length, roleCounts, estimatedTokens: tokens };
}
