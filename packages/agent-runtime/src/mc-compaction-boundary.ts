import type { ContextCompactionRecord, UiMessage } from "@pi-desktop/shared";
import type { MessageEntry } from "./pi-runtime-types.js";

function isDurableMessage(id: string, role: string): boolean {
  return role !== "system" && !id.startsWith("approved-plan:") && !id.startsWith("approved-goal:");
}

/** System rows can move on replay; internal approval messages are not persisted. */
export function compactionBoundaryId(entries: readonly MessageEntry[]): string | undefined {
  return [...entries].reverse().find((entry) => isDurableMessage(entry.id, entry.message.role))?.id;
}

/** Roll back an unsafe checkpoint, not its messages. Never guess coverage from timestamps. */
export function restorableCompaction(
  history: readonly UiMessage[],
  checkpoints: readonly ContextCompactionRecord[],
): ContextCompactionRecord | undefined {
  const durableIds = new Set(history.filter((message) =>
    !message.parentToolCallId && isDurableMessage(message.id, message.role) &&
    (message.role !== "assistant" || (message.status !== "error" && message.status !== "aborted" &&
      !message.isError && !message.error)),
  ).map((message) => message.id));
  return [...checkpoints].reverse().find((checkpoint) => durableIds.has(checkpoint.throughMessageId));
}
