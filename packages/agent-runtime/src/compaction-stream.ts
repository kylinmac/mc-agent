import type { Api, AssistantMessage, Context, Model, Models, ModelsSimpleStreamOptions } from "@earendil-works/pi-ai";
import { streamIdleTimeoutMs, withStreamIdleTimeout } from "./provider-retry.js";

export type CompactionRequestStage = "waiting" | "generating";

function abortedSummary(model: Model<Api>): AssistantMessage {
  return {
    role: "assistant", content: [], api: model.api, provider: model.provider,
    model: model.id, timestamp: Date.now(), stopReason: "aborted",
    errorMessage: "Summary request aborted",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  };
}

/** Keep summary generation observable and cancellable even if a provider stalls. */
export async function completeCompactionStream(
  models: Models,
  model: Model<Api>,
  context: Context,
  options: ModelsSimpleStreamOptions,
  onStage?: (stage: CompactionRequestStage) => void,
): Promise<AssistantMessage> {
  if (options.signal?.aborted) return abortedSummary(model);
  const attempt = new AbortController();
  onStage?.("waiting");
  const stream = models.streamSimple(model, context, { ...options, signal: attempt.signal });
  const cancel = () => {
    attempt.abort();
    // A provider may ignore its signal. End our read too, releasing the watchdog.
    stream.end(abortedSummary(model));
  };
  options.signal?.addEventListener("abort", cancel, { once: true });
  if (options.signal?.aborted) cancel();
  try {
    let stalled = false;
    const guarded = withStreamIdleTimeout(stream, model, streamIdleTimeoutMs(), () => {
      stalled = true;
      cancel();
    });
    let generating = false;
    for await (const event of guarded) {
      if (!generating && (event.type === "text_delta" || event.type === "thinking_delta")) {
        generating = true;
        onStage?.("generating");
      }
    }
    const result = await guarded.result();
    if (options.signal?.aborted) return abortedSummary(model);
    // pi-ai's summary retry classifier recognizes timeouts, not "stream stalled".
    return stalled ? { ...result, errorMessage: `Summary request timeout: ${result.errorMessage}` } : result;
  } finally {
    options.signal?.removeEventListener("abort", cancel);
  }
}
