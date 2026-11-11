/**
 * mc-agent (#117): clear old, bulky tool results before a full summary is needed.
 *
 * A single command or search result can hold tens of thousands of tokens, and
 * until now every one of them stayed in the model context until the 90%
 * threshold replaced the whole history with a summary. Clearing the oldest of
 * them costs no model request and loses nothing the session cannot get back:
 * the transcript keeps the original, and the tools named here can be run again.
 *
 * Everything in this module is a pure function of its inputs. The runtime owns
 * the set of cleared call ids and re-derives it from the same rules after a
 * restart, so the projection never depends on when it was computed.
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";

/**
 * Tools whose results may be cleared. Each one can be called again for the
 * same information. Subagent reports, user answers, plan submissions and
 * plugin or MCP results are never touched: nothing guarantees a second call
 * returns them.
 */
export const PRUNABLE_TOOL_RESULTS: ReadonlySet<string> = new Set([
  "Read",
  "Grep",
  "Glob",
  "Bash",
  "BashOutput",
]);

/** Share of the safe budget at which clearing starts; below automatic compaction (0.9). */
export const TOOL_RESULT_PRUNE_TRIGGER_RATIO = 0.7;
/** Clearing continues until the context is at or below this share. */
export const TOOL_RESULT_PRUNE_TARGET_RATIO = 0.5;
/** Results smaller than this are not worth a placeholder. */
export const TOOL_RESULT_PRUNE_MIN_RESULT_TOKENS = 1_500;
/**
 * A pass must free at least this share of the safe budget. Every pass rewrites
 * the request prefix and so costs one prompt-cache miss; a pass that frees
 * little would pay that for nothing, and would be tried again on every turn.
 */
export const TOOL_RESULT_PRUNE_MIN_SAVING_RATIO = 0.05;
const MIN_SAVING_FLOOR_TOKENS = 2_000;
/** Characters of the original kept at each end of a cleared result. */
export const TOOL_RESULT_PRUNE_EXCERPT_CHARS = 400;

export const TOOL_RESULT_PRUNE_MARKER = "[Old tool output cleared to free context]";

type ToolResultLike = Extract<AgentMessage, { role: "toolResult" }>;

function isToolResult(message: AgentMessage): message is ToolResultLike {
  return message.role === "toolResult";
}

function resultText(message: ToolResultLike): string {
  const content: unknown = message.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    if (Reflect.get(block, "type") !== "text") continue;
    const text: unknown = Reflect.get(block, "text");
    if (typeof text === "string") parts.push(text);
  }
  return parts.join("\n");
}

/** True for a result this module already replaced. */
export function isClearedToolResult(message: AgentMessage): boolean {
  return isToolResult(message) && resultText(message).startsWith(TOOL_RESULT_PRUNE_MARKER);
}

/**
 * The stand-in for a cleared result: what it was, how large, and both ends of
 * the original — a Read header or a command's last lines are often all the
 * model needs to decide whether to fetch it again.
 */
export function clearedToolResult(
  message: ToolResultLike,
  originalTokens: number,
): ToolResultLike {
  const text = resultText(message);
  const excerpt = TOOL_RESULT_PRUNE_EXCERPT_CHARS;
  const head = text.slice(0, excerpt);
  const tail = text.length > excerpt * 2 ? text.slice(-excerpt) : text.slice(head.length);
  const omitted = Math.max(0, text.length - head.length - tail.length);
  const lines = [
    TOOL_RESULT_PRUNE_MARKER,
    `This ${message.toolName} result (about ${originalTokens.toLocaleString("en-US")} tokens) was removed from the conversation context. ` +
      "Nothing was undone: files and commands are as the call left them. Call the tool again if you still need the output.",
    "--- start of original output ---",
    head,
    ...(omitted > 0 ? [`[... ${omitted.toLocaleString("en-US")} characters omitted ...]`] : []),
    ...(tail ? [tail] : []),
    "--- end of original output ---",
  ];
  return {
    ...message,
    content: [{ type: "text", text: lines.join("\n") }],
  } as ToolResultLike;
}

/** Replace every result whose call id is in `cleared`; other messages pass through untouched. */
export function applyToolResultPruning(
  messages: AgentMessage[],
  cleared: ReadonlyMap<string, { originalTokens: number }>,
): AgentMessage[] {
  if (cleared.size === 0) return messages;
  let changed = false;
  const projected = messages.map((message) => {
    if (!isToolResult(message)) return message;
    const entry = cleared.get(message.toolCallId);
    if (!entry || isClearedToolResult(message)) return message;
    changed = true;
    return clearedToolResult(message, entry.originalTokens);
  });
  return changed ? projected : messages;
}

export type ToolResultPruningPlan = {
  /** Call id → estimated tokens of the original result. */
  cleared: Map<string, { originalTokens: number; savedTokens: number }>;
  savedTokens: number;
};

export type ToolResultPruningInput = {
  /** The model context as it would be sent now, earlier clearing already applied. */
  messages: AgentMessage[];
  /** Estimated size of that context. */
  tokens: number;
  /** Safe request budget (`ContextBudget.hardLimit`). */
  hardLimit: number;
  /** Recent context that is never cleared (`ContextBudget.keepRecentTokens`). */
  keepRecentTokens: number;
  estimate: (message: AgentMessage) => number;
};

/**
 * Decide which results one pass clears, oldest first.
 *
 * Returns undefined when the context is below the trigger, when nothing
 * eligible sits outside the protected tail, or when the pass would free too
 * little to be worth a prompt-cache miss. A pass stops as soon as the target is
 * reached, so the results nearest the protected tail survive when they can.
 */
export function planToolResultPruning(
  input: ToolResultPruningInput,
): ToolResultPruningPlan | undefined {
  const { messages, tokens, hardLimit, keepRecentTokens, estimate } = input;
  if (tokens < Math.floor(hardLimit * TOOL_RESULT_PRUNE_TRIGGER_RATIO)) return undefined;
  const target = Math.floor(hardLimit * TOOL_RESULT_PRUNE_TARGET_RATIO);

  // The tail is protected whole, and always includes the newest message: the
  // result that just came back is the one the model is about to read.
  let protectedFrom = messages.length;
  let tailTokens = 0;
  for (let index = messages.length - 1; index >= 0; index--) {
    protectedFrom = index;
    tailTokens += estimate(messages[index]!);
    if (tailTokens >= keepRecentTokens) break;
  }

  const cleared: ToolResultPruningPlan["cleared"] = new Map();
  let savedTokens = 0;
  for (let index = 0; index < protectedFrom; index++) {
    if (tokens - savedTokens <= target) break;
    const message = messages[index]!;
    if (!isToolResult(message) || !PRUNABLE_TOOL_RESULTS.has(message.toolName)) continue;
    if (isClearedToolResult(message) || cleared.has(message.toolCallId)) continue;
    const originalTokens = estimate(message);
    if (originalTokens < TOOL_RESULT_PRUNE_MIN_RESULT_TOKENS) continue;
    const saved = originalTokens - estimate(clearedToolResult(message, originalTokens));
    if (saved <= 0) continue;
    cleared.set(message.toolCallId, { originalTokens, savedTokens: saved });
    savedTokens += saved;
  }

  const minimumSaving = Math.max(
    MIN_SAVING_FLOOR_TOKENS,
    Math.floor(hardLimit * TOOL_RESULT_PRUNE_MIN_SAVING_RATIO),
  );
  if (savedTokens < minimumSaving) return undefined;
  return { cleared, savedTokens };
}

/**
 * Tokens to take off a usage-anchored estimate.
 *
 * `estimateContextTokens` anchors on the last provider usage report, which
 * still counts every result cleared after it was issued. Until the next
 * response reports fresh usage, the savings of those results — the ones that
 * sit before the anchor and were cleared while it was current — have to be
 * subtracted, or the context reads as full right after it was emptied.
 */
export function pruningUsageCredit(
  messages: AgentMessage[],
  lastUsageIndex: number | null,
  cleared: ReadonlyMap<string, { savedTokens: number; anchorTimestamp: number | null }>,
): number {
  if (lastUsageIndex === null || cleared.size === 0) return 0;
  const anchorTimestamp = messages[lastUsageIndex]?.timestamp ?? null;
  let credit = 0;
  for (let index = 0; index < lastUsageIndex; index++) {
    const message = messages[index]!;
    if (!isToolResult(message)) continue;
    const entry = cleared.get(message.toolCallId);
    if (entry && entry.anchorTimestamp === anchorTimestamp) credit += entry.savedTokens;
  }
  return credit;
}
