import type { AssistantMessage, Context, Model, Api } from "@earendil-works/pi-ai";
import { effectiveModelContextWindow, estimateOutputCapInputTokens, type OutputCapContext } from "./output-cap.js";
import { textFromContent } from "./pi-runtime-messages.js";

/**
 * mc-agent (R21.3, #122): wire APIs that apply automatic server-side prompt prefix
 * caching without per-write cache surcharges, safe to mirror on compaction.
 */
export const CACHE_SHARED_SUMMARY_APIS: ReadonlySet<string> = new Set([
  "openai-codex-responses",
  "openai-responses",
  "openai-completions",
]);

export const CACHE_SHARED_SUMMARY_MARKER = "CRITICAL: Respond with TEXT ONLY. Do NOT call any tools.";

export type CompactionCachePrefix = {
  sessionId: string;
  context: Context;
};

/**
 * A prefix ending with an unresolved tool call must never have a user message
 * appended (providers reject missing tool outputs).
 */
export function hasUnansweredToolCalls(messages: Context["messages"]): boolean {
  const pending = new Set<string>();
  for (const message of messages) {
    if (message.role === "assistant" && Array.isArray(message.content)) {
      for (const block of message.content) {
        if (block && typeof block === "object" && block.type === "toolCall" && typeof block.id === "string") {
          pending.add(block.id);
        }
      }
    } else if (message.role === "toolResult" && typeof message.toolCallId === "string") {
      pending.delete(message.toolCallId);
    }
  }
  return pending.size > 0;
}

/**
 * Build a compaction request that preserves the conversation's exact system prompt,
 * tool declarations, and message prefix so provider prompt caches hit instead of
 * re-billing the entire window as cold input. Returns undefined when unsafe or oversized.
 */
export function buildCacheSharedSummaryContext(input: {
  model: Model<Api>;
  prefix: CompactionCachePrefix;
  maxTokens: number;
  summaryInstruction: string;
}): Context | undefined {
  if (!CACHE_SHARED_SUMMARY_APIS.has(input.model.api)) return undefined;
  if (!input.prefix.context.messages.some((m) => m.role === "user" || m.role === "assistant")) {
    return undefined;
  }
  if (hasUnansweredToolCalls(input.prefix.context.messages)) return undefined;

  const userPrompt: Context["messages"][number] = {
    role: "user",
    content: [{ type: "text", text: input.summaryInstruction }],
    timestamp: Date.now(),
  };
  const sharedContext: Context = {
    ...(input.prefix.context.systemPrompt !== undefined ? { systemPrompt: input.prefix.context.systemPrompt } : {}),
    messages: [...input.prefix.context.messages, userPrompt],
    ...(input.prefix.context.tools ? { tools: input.prefix.context.tools } : {}),
  };

  const window = effectiveModelContextWindow(input.model);
  if (window > 0) {
    const capContext: OutputCapContext = {
      ...(sharedContext.systemPrompt !== undefined ? { systemPrompt: sharedContext.systemPrompt } : {}),
      messages: sharedContext.messages as OutputCapContext["messages"],
      ...(sharedContext.tools ? { tools: sharedContext.tools } : {}),
    };
    if (estimateOutputCapInputTokens(capContext, input.model) + input.maxTokens > window) {
      return undefined;
    }
  }
  return sharedContext;
}

/**
 * Accept only a non-empty plain-text completion; tool calls, length cuts, errors,
 * or aborts trigger automatic fallback to standalone serialized summarization.
 */
export function isValidCacheSharedSummaryResponse(response: AssistantMessage): string | undefined {
  if (
    response.stopReason === "error" ||
    response.stopReason === "length" ||
    response.stopReason === "toolUse" ||
    response.stopReason === "aborted"
  ) {
    return undefined;
  }
  if (Array.isArray(response.content) && response.content.some((block) => block.type === "toolCall")) {
    return undefined;
  }
  const text = textFromContent(response.content);
  return text.trim() ? text : undefined;
}
