import { readSystemMessage } from "./system-transcript-journal.js";
/**
 * Project pi session entries into the model context.
 *
 * The runtime owns this synchronous projection because its transcript includes
 * desktop-only entries and persisted host checkpoints. It keeps the
 * `{ messages }` shape consumed by the agent loop.
 *
 * The slice-from-latest-compaction and compactionSummary-before-retainedTail
 * order preserve the behavior D203 depends on. Retained
 * reasoning turns (#296) sit between the summary and the user tail so strict
 * DeepSeek relays still see real thinking without replaying tool-call pairs.
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, ToolCall } from "@earendil-works/pi-ai";
import { usageToPi } from "./agent-messages.js";
import {
  createBranchSummaryMessage,
  createCompactionSummaryMessage,
  type CompactionSummaryMessage,
} from "./pi-runtime-messages.js";
import type { Entry } from "./pi-runtime-types.js";
import { restoredFilesFromDetails } from "./mc-compaction-file-restore.js";
import {
  retainedReasoningFromDetails,
  retainedReasoningToMessages,
  type ReasoningReplayIdentity,
} from "./reasoning-replay.js";

/**
 * Failed, aborted, and deferred assistants are transcript rows, not context.
 * An assistant with no content blocks is not worth resending either: the
 * runtime never appends one live, a restored transcript drops them, and a
 * provider would reject or silently skip it (D446).
 */
function isContextMessage(message: AgentMessage): boolean {
  return (
    message.role !== "assistant" ||
    (message.stopReason !== "error" &&
      message.stopReason !== "aborted" &&
      message.stopReason !== "deferred" &&
      message.content.length > 0)
  );
}

/** mc-agent (R21.2): attach the checkpoint's file snapshots, never re-read. */
function withRestoredFiles(message: CompactionSummaryMessage, details: unknown): AgentMessage {
  const restoredFiles = restoredFilesFromDetails(details);
  return (restoredFiles.length > 0 ? { ...message, restoredFiles } : message) as AgentMessage;
}

export function buildContextEntries(pathEntries: readonly Entry[]): Entry[] {
  for (let index = pathEntries.length - 1; index >= 0; index--) {
    const entry = pathEntries[index];
    if (entry?.type === "compaction") {
      return [entry, ...pathEntries.slice(index + 1)];
    }
  }
  return [...pathEntries];
}

export function sessionEntryToContextMessages(
  entry: Entry,
  identity?: ReasoningReplayIdentity,
): AgentMessage[] {
  switch (entry.type) {
    case "message":
      return isContextMessage(entry.message) ? [entry.message] : [];
    case "compaction":
      return [
        ...(entry.details && typeof entry.details === "object" && "systemMessageJson" in entry.details
          ? [readSystemMessage(entry.details.systemMessageJson)] : []),
        withRestoredFiles(
          createCompactionSummaryMessage(
            entry.summary,
            entry.tokensBefore,
            entry.timestamp,
          ),
          entry.details,
        ),
        ...(identity?.requiresCompletionsReasoningReplay === false
          ? []
          : retainedReasoningToMessages(
              retainedReasoningFromDetails(entry.details),
              entry.timestamp,
              identity,
            )),
        ...entry.retainedTail.filter((message) => isContextMessage(message) &&
          !(message.role === "system" && entry.details && typeof entry.details === "object" && "systemMessageJson" in entry.details)),
      ];
    case "branch_summary":
      return entry.summary
        ? [
            createBranchSummaryMessage(
              entry.summary,
              entry.fromId,
              entry.timestamp,
            ),
          ]
        : [];
    case "custom":
      return [];
  }
}

export function buildSessionContext(
  pathEntries: readonly Entry[],
  identity?: ReasoningReplayIdentity,
): {
  messages: AgentMessage[];
} {
  const contextEntries = buildContextEntries(pathEntries);
  const messages = contextEntries.flatMap((entry) => sessionEntryToContextMessages(entry, identity));
  if (contextEntries[0]?.type !== "compaction") return { messages };

  // A checkpoint can split a tool batch: restore only the calls whose results survived.
  const sources = new Map<string, { assistant: AssistantMessage; call: ToolCall }>();
  for (const entry of pathEntries.slice(0, pathEntries.indexOf(contextEntries[0]))) {
    const candidates = entry.type === "message" ? [entry.message]
      : entry.type === "compaction" ? entry.retainedTail : [];
    for (const message of candidates) {
      if (message.role !== "assistant" || !isContextMessage(message)) continue;
      for (const block of message.content) {
        if (block.type === "toolCall") sources.set(block.id, { assistant: message, call: block });
      }
    }
  }
  const calls = new Set<string>();
  const paired: AgentMessage[] = [];
  for (const message of messages) {
    if (message.role === "assistant") {
      for (const block of message.content) if (block.type === "toolCall") calls.add(block.id);
    } else if (message.role === "toolResult" && !calls.has(message.toolCallId)) {
      const source = sources.get(message.toolCallId);
      if (source) {
        calls.add(source.call.id);
        paired.push({ ...source.assistant,
          content: [
            ...(identity?.requiresCompletionsReasoningReplay
              ? source.assistant.content.filter((block) => block.type === "thinking") : []),
            source.call,
          ], stopReason: "toolUse", usage: usageToPi(undefined) });
      }
    }
    paired.push(message);
  }
  return { messages: paired };
}
