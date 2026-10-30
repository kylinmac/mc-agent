/**
 * Outbound headers for the context-compaction summary request.
 *
 * The desktop-owned compaction adapter assembles the request options and calls
 * `Models.completeSimple` directly, so the call never passes
 * the agent's `streamFn` where every other request of a session picks up its
 * provider headers. OpenCode Go answers 400 to a request without
 * `x-opencode-session`, which is why `/compact` failed on that provider while
 * ordinary turns worked, and a provider row's own custom headers were missing
 * from the same call. The adapter takes the model collection as an argument,
 * so the collection is the seam that reaches its request.
 */

import { accountModelResult, nativeCostStatus, requestUsageIdentity, type UsageObserver } from "./request-usage.js";
import { requestThinkingLevel } from "./thinking-level.js";
import type {
  Api,
  Context,
  Model,
  Models,
  ModelsSimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { clampOpenAIPromptCacheKey } from "@earendil-works/pi-ai/api/openai-prompt-cache";
import {
  openCodeEndpointFromProvider,
  withOpenCodeSessionHeaders,
} from "./opencode-session-headers.js";
import {
  copilotRequestHeaders,
  type RuntimeProviderConfig,
} from "./provider-binding.js";
import { mergeProviderHeaders, withProviderHeaders } from "./provider-headers.js";
import {
  providerUsesSessionAffinity,
  withSessionAffinityOptions,
  withSessionPromptCacheKey,
} from "./session-affinity.js";
import { compactionRequestShape, type CompactionRequestShape } from "./compaction-diagnostics.js";
import { completeCompactionStream, type CompactionRequestStage } from "./compaction-stream.js";

/**
 * mc-agent (R21.3): one summary attempt as measured, before deciding whether a
 * cache-sharing request is worth building. Counts only; no text.
 */
export type CompactionAttemptMeasure = {
  durationMs: number;
  stopReason: string;
  /** False when the provider reported no usage at all; zeros are then unknown, not zero. */
  usageReported: boolean;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
};

export function measureCompactionAttempt(
  result: { stopReason: string; usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; totalTokens?: number } },
  durationMs: number,
): CompactionAttemptMeasure {
  const usage = result.usage;
  const count = (value: number | undefined) => (typeof value === "number" && Number.isFinite(value) ? value : 0);
  const reported = !!usage && (count(usage.totalTokens) > 0 || count(usage.input) + count(usage.output) > 0);
  return {
    durationMs,
    stopReason: result.stopReason,
    usageReported: reported,
    input: count(usage?.input),
    output: count(usage?.output),
    cacheRead: count(usage?.cacheRead),
    cacheWrite: count(usage?.cacheWrite),
  };
}

/**
 * The header set `streamFn` puts on a turn, applied to a summary request.
 *
 * The session id is the runtime's own, not a per-call id, so the summary reaches
 * the same gateway backend as the conversation
 * it summarizes — the same id the session's turns already send.
 */
export function compactionRequestOptions(input: {
  provider: RuntimeProviderConfig;
  sessionId: string;
  model: Model<Api>;
  context: Pick<Context, "messages">;
  options?: ModelsSimpleStreamOptions;
}): ModelsSimpleStreamOptions {
  const { provider, sessionId, model, context, options } = input;
  return withSessionAffinityOptions(
    withProviderHeaders(
      withOpenCodeSessionHeaders(
        { ...options, sessionId,
          ...(options?.reasoning !== undefined ? { reasoning: requestThinkingLevel(model, options.reasoning) } : {}) },
        { ...openCodeEndpointFromProvider(provider, model), sessionId },
      ),
      mergeProviderHeaders(
        copilotRequestHeaders(provider, context),
        provider.headers,
      ),
      model.api,
    ),
    { provider, api: model.api, baseUrl: model.baseUrl, sessionId },
  );
}

/**
 * The two wire APIs that key a conversation by `prompt_cache_key`. A gateway
 * fronting a Codex backend rejects a request without it (400
 * `invalid_responses_request`), and the session's own turns always carry it.
 */
const SUMMARY_CONVERSATION_APIS = new Set([
  "openai-responses",
  "openai-codex-responses",
]);

/**
 * pi-ai's Responses adapters attach `prompt_cache_key` only while the caller
 * keeps some cache retention, and the summary adapter asks for `"none"`,
 * so the summary alone loses the conversation identity the adapter would have
 * sent. Restore it for the Responses-shaped APIs and leave every other payload
 * byte-identical. The adapter's own object is never mutated: the key rides a
 * shallow copy that the caller's `onPayload` return value can still replace.
 */
function withSummaryPromptCacheKey(input: {
  payload: unknown;
  api: string;
  sessionId: string;
}): unknown {
  if (!SUMMARY_CONVERSATION_APIS.has(input.api)) return input.payload;
  if (!input.payload || typeof input.payload !== "object" || Array.isArray(input.payload)) {
    return input.payload;
  }
  const body = input.payload as Record<string, unknown>;
  if (body.prompt_cache_key !== undefined && body.prompt_cache_key !== null) {
    return input.payload;
  }
  const key = clampOpenAIPromptCacheKey(input.sessionId);
  if (!key) return input.payload;
  return { ...body, prompt_cache_key: key };
}

/**
 * `models` with compaction's request routed through that header boundary.
 *
 * Only `completeSimple` is reached from desktop compaction; every other member
 * stays the collection's own, so future adapter changes remain isolated here.
 */
export function withCompactionRequestHeaders(
  models: Models,
  provider: RuntimeProviderConfig,
  sessionId: string,
  onUsage?: UsageObserver,
  onRequestShape?: (shape: CompactionRequestShape) => void,
  onStage?: (stage: CompactionRequestStage) => void,
  onAttempt?: (attempt: CompactionAttemptMeasure) => void,
): Models {
  const completeSimple: Models["completeSimple"] = async (model, context, options) => {
    const started = Date.now();
    const identity = { ...requestUsageIdentity(model, provider.id), costStatus: nativeCostStatus(provider.modelConfig?.nativeCost) };
    const requestOptions = compactionRequestOptions({ provider, sessionId, model, context, options });
    const previousOnPayload = requestOptions.onPayload;
    if (
      SUMMARY_CONVERSATION_APIS.has(model.api) ||
      providerUsesSessionAffinity(provider, model.api, model.baseUrl) ||
      onRequestShape
    ) {
      requestOptions.onPayload = async (payload, requestModel) => {
        const replacement = await previousOnPayload?.(payload, requestModel);
        const base = replacement === undefined ? payload : replacement;
        // Two shapes, one owner each, and each pass is a no-op for the other's
        // API: the summary adapter asks for `"none"` retention on the Responses
        // APIs, which is what costs the adapter's own key there, while the
        // Completions adapter keys only `api.openai.com`. Both add only an
        // absent key, so a payload that already carries one is left alone.
        const summaryKeyed = withSummaryPromptCacheKey({
          payload: base,
          api: requestModel.api,
          sessionId,
        });
        const keyed = withSessionPromptCacheKey({
          payload: summaryKeyed,
          api: requestModel.api,
          sessionId,
          enabled: providerUsesSessionAffinity(
            provider,
            requestModel.api,
            requestModel.baseUrl,
          ),
        });
        // Nothing to change keeps the hook's own return value, so an untouched
        // payload stays the adapter's object instead of a copy of it.
        onRequestShape?.(compactionRequestShape({
          model: requestModel,
          payload: keyed ?? base,
          messages: context.messages,
          tools: (context as Context & { tools?: readonly unknown[] }).tools,
        }));
        return keyed === base ? replacement : keyed;
      };
    }
    const result = await completeCompactionStream(models, model, context, requestOptions, onStage);
    onAttempt?.(measureCompactionAttempt(result, Date.now() - started));
    return onUsage ? accountModelResult(result, identity, onUsage) : result;
  };
  return new Proxy(models, {
    get: (target, property, receiver) =>
      property === "completeSimple"
        ? completeSimple
        : Reflect.get(target, property, receiver),
  });
}
