import { orderSystemRows, SystemTranscriptJournal } from "./system-transcript-journal.js";
import { restoreHostedSearchReplay } from "./hosted-search-replay.js";
import { type AgentMessage } from "@earendil-works/pi-agent-core";
import {
  type Api,
  type AssistantMessage,
  type Model,
  type ToolResultMessage,
} from "@earendil-works/pi-ai";
import type { UiMessage } from "@pi-desktop/shared";
import { formatSessionMessage } from "@pi-desktop/shared";
import {
  isRecord,
  timestampMs,
  toJsonObject,
  toJsonValue,
  usageToPi,
} from "./agent-messages.js";
import { restoredToolContent } from "./tool-result-content.js";
import type { MessageEntry } from "./pi-runtime-types.js";
import { apiBindingForProviderModel, type RuntimeProviderConfig } from "./provider-binding.js";
import { promptContent, runtimeAttachmentFromMessage } from "./runtime-prompt.js";

export const TOOL_SEARCH_NAME = "ToolSearch";

function toolNameList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [
    ...new Set(
      value.filter(
        (name: unknown): name is string =>
          typeof name === "string" && name.length > 0,
      ),
    ),
  ];
}


/** Read canonical and historical activation markers from a ToolSearch row. */
export function toolSearchActivatedNames(
  details: unknown,
  legacyAddedToolNames?: unknown,
): string[] {
  const record = isRecord(details) ? details : undefined;
  const candidates = [
    record?.addedToolNames,
    record?.activated,
    legacyAddedToolNames,
  ];
  for (const candidate of candidates) {
    const names = toolNameList(candidate);
    if (names.length > 0) return names;
  }
  return [];
}


/** Rebuild a pi-ai tool result from a persisted tool row. Rows that never
 * finished (app quit / abort mid-tool) restore as errored results so the
 * model knows the call produced nothing. Exported for tests. */
export function toolResultFromUi(
  m: UiMessage,
  timestamp: number,
): ToolResultMessage {
  const raw: unknown = m.toolResult;
  const interrupted = m.toolStatus === "running";
  const rawRecord: Record<string, unknown> | undefined = isRecord(raw)
    ? raw
    : undefined;
  const rawAddedToolNames = rawRecord?.addedToolNames;
  const addedToolNames =
    m.toolName === TOOL_SEARCH_NAME
      ? toolSearchActivatedNames(rawRecord?.details, rawAddedToolNames)
      : toolNameList(rawAddedToolNames);
  return {
    role: "toolResult",
    toolCallId: m.toolCallId ?? "",
    toolName: m.toolName ?? "",
    content: restoredToolContent(raw, interrupted),
    ...(toJsonValue(rawRecord?.details) !== undefined || addedToolNames.length > 0
      ? {
          details: {
            ...toJsonObject(rawRecord?.details),
            ...(addedToolNames.length > 0 ? { addedToolNames } : {}),
          },
        }
      : {}),
    isError:
      interrupted ||
      m.toolStatus === "error" ||
      m.toolStatus === "denied" ||
      m.isError === true,
    timestamp,
  };
}

export function historyToEntries(
  history: UiMessage[],
  provider: RuntimeProviderConfig,
  model: Model<Api>,
  systemJournal: SystemTranscriptJournal,
): MessageEntry[] {
  const api = apiBindingForProviderModel(provider).api;
  const deepSeekCompletionsReplay =
    api === "openai-completions" &&
    (
      model.compat as
        | { requiresReasoningContentOnAssistantMessages?: boolean }
        | undefined
    )?.requiresReasoningContentOnAssistantMessages === true;
  const entries: MessageEntry[] = [];
  const append = (id: string, message: AgentMessage): MessageEntry => {
    const entry: MessageEntry = {
      type: "message",
      id,
      seq: entries.length,
      parentId: entries.at(-1)?.id ?? null,
      timestamp: timestampMs(message.timestamp),
      message,
    };
    entries.push(entry);
    return entry;
  };
  // Tool rows attach their calls to the assistant message that made them
  // (the nearest one above), keeping each call adjacent to its result as
  // the provider APIs require.
  let toolCarrier: AssistantMessage | undefined;
  for (const m of orderSystemRows(history)) {
    // Subagent rows belong to the transcript and to review, never to the
    // parent's model context (ADR 0062): the parent only ever saw the `Task`
    // report, and replaying a delegate's messages would both contradict that
    // and reintroduce the context cost delegation exists to avoid.
    if (m.parentToolCallId) continue;
    const timestamp = Date.parse(m.createdAt) || Date.now();
    if (m.role === "system" && m.modelSystem) {
      // An update recorded while a tool ran sits between the call and its
      // result. It keeps the carrier: Pi holds the update until the results
      // are written, which is the shape the live request had.
      append(m.id, systemJournal.restore(m));
    } else if (m.role === "user") {
      toolCarrier = undefined;
      const attachments = (m.attachments ?? []).map((attachment) =>
        runtimeAttachmentFromMessage(
          attachment,
          attachment.data,
        ),
      );
      const content = promptContent({
        text: m.sessionMessage ? formatSessionMessage(m.content, m.sessionMessage) : m.content,
        attachments,
      });
      if (
        !(m.content || "").trim() &&
        !attachments.some((attachment) => attachment.data)
      ) {
        continue;
      }
      append(m.id, { role: "user", content, timestamp });
    } else if (m.role === "assistant") {
      toolCarrier = undefined;
      // Failed provider responses belong in the transcript for diagnosis,
      // but must never become model context on the next turn.
      if (m.status === "error" || m.isError || m.error) continue;
      const content: AssistantMessage["content"] = [];
      if (m.thinking?.trim()) {
        // Completions DeepSeek replay needs thinkingSignature so convertMessages
        // maps the block to reasoning_content instead of dropping it (#296).
        content.push({
          type: "thinking" as const,
          thinking: m.thinking,
          ...(deepSeekCompletionsReplay
            ? { thinkingSignature: "reasoning_content" as const }
            : {}),
        });
      }
      content.push(...restoreHostedSearchReplay(m.hostedSearch));
      if (m.content?.trim()) {
        content.push({ type: "text" as const, text: m.content });
      }
      // Kept even when empty: a call-only turn has no text of its own and
      // becomes the carrier for the tool rows that follow. Assistants that
      // end up with no content and no calls are dropped at the end.
      const assistant: AssistantMessage = {
        role: "assistant",
        content,
        api,
        // Persisted providerId identifies a local account; Pi compares its
        // vendor identity to decide whether native thinking can be replayed.
        // Keep known account/model switches distinct; legacy rows have no
        // source identity and retain the existing current-model fallback.
        provider: !m.providerId || m.providerId === provider.id
          ? model.provider : m.providerId,
        model: m.modelId || model.id,
        usage: usageToPi(m.usage),
        stopReason: "stop",
        timestamp,
      };
      append(m.id, assistant);
      toolCarrier = assistant;
    } else if (m.role === "tool") {
      if (!m.toolCallId || !m.toolName) continue;
      if (!toolCarrier) {
        // Tool row whose assistant row was lost (truncated branch):
        // synthesize a carrier so the call/result pair stays well-formed.
        toolCarrier = {
          role: "assistant",
          content: [],
          api,
          provider: model.provider,
          model: model.id,
          usage: usageToPi(undefined),
          stopReason: "toolUse",
          timestamp,
        };
        append(`${m.id}:carrier`, toolCarrier);
      }
      toolCarrier.content.push({
        type: "toolCall",
        id: m.toolCallId,
        name: m.toolName,
        arguments: toJsonObject(m.toolArgs),
      });
      toolCarrier.stopReason = "toolUse";
      append(m.id, toolResultFromUi(m, timestamp));
    }
  }
  return entries.filter(
    (entry) =>
      entry.message.role !== "assistant" || entry.message.content.length > 0,
  );
}

/**
 * A `tool_use` id has to be unique across the request: Anthropic-family
 * endpoints (DeepSeek's included) reject the whole turn with "tool_use ids
 * must be unique" (issue #718), and a session that hits that 400 cannot
 * continue. Every message the next request carries passes through here, so
 * this is the one place that can guarantee the provider's rule for both a
 * rebuilt context and one that grew during this process.
 *
 * The transcript is append-only and tolerates a retried append, so the same
 * call can reach the request twice: under the same row id (which the host's
 * keep-last dedupe already collapses) or a new one (which it cannot). The
 * first pending occurrence wins; a later completed pair is retained under
 * a fresh request id. New streamed executions are normalized before they
 * reach this guard or the journal. What was dropped is logged with its ids,
 * because the next report should name the writer instead of only the
 * provider's sentence.
 */
