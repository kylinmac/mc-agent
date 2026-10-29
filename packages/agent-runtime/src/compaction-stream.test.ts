import { afterEach, describe, expect, it, vi } from "vitest";
import { createAssistantMessageEventStream, retryAssistantCall, type Api, type AssistantMessage, type Model, type Models, type ModelsSimpleStreamOptions } from "@earendil-works/pi-ai";
import { withCompactionRequestHeaders } from "./compaction-request.js";
import type { RuntimeProviderConfig } from "./provider-binding.js";

const model: Model<Api> = {
  id: "summary-model", name: "Summary", api: "openai-responses", provider: "test",
  baseUrl: "https://example.invalid", reasoning: true, input: ["text"],
  contextWindow: 128_000, maxTokens: 8_192,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
const provider: RuntimeProviderConfig = {
  id: "test", name: "Test", modelId: model.id, apiStyle: "responses",
  baseUrl: model.baseUrl, apiKey: "test-only", supportsReasoning: true,
  supportedThinkingLevels: ["off", "low", "medium"],
};
const message = (): AssistantMessage => ({
  role: "assistant", content: [{ type: "text", text: "Preserved context" }],
  api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(),
  stopReason: "stop", usage: { input: 2, output: 2, cacheRead: 0, cacheWrite: 0,
    totalTokens: 4, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
});

afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });

function fixture(onStage?: (stage: "waiting" | "generating") => void) {
  const attempts: { stream: ReturnType<typeof createAssistantMessageEventStream>; signal?: AbortSignal }[] = [];
  const streamSimple = vi.fn((_model: Model<Api>, _context: unknown, options?: ModelsSimpleStreamOptions) => {
    const stream = createAssistantMessageEventStream();
    attempts.push({ stream, signal: options?.signal });
    return stream;
  });
  const models = { streamSimple, completeSimple: (...args: Parameters<typeof streamSimple>) => streamSimple(...args).result() } as unknown as Models;
  return { attempts, wrapped: withCompactionRequestHeaders(models, provider, "summary", undefined, undefined, onStage) };
}

describe("compaction request lifetime", () => {
  it("aborts a silent attempt before retrying and releases the old stream", async () => {
    vi.useFakeTimers();
    vi.stubEnv("PI_DESKTOP_STREAM_IDLE_TIMEOUT_MS", "30000");
    const { attempts, wrapped } = fixture();
    const pending = retryAssistantCall(() => wrapped.completeSimple(model, { messages: [] }), {
      enabled: true, maxRetries: 1, baseDelayMs: 2_000,
    }, undefined);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(attempts[0]?.signal?.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(attempts).toHaveLength(2);
    expect(attempts[1]?.signal?.aborted).toBe(false);
    attempts[1]!.stream.end(message());
    expect((await pending).stopReason).toBe("stop");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("stops immediately even when the provider ignores cancellation", async () => {
    vi.useFakeTimers();
    const stop = new AbortController();
    const remove = vi.spyOn(stop.signal, "removeEventListener");
    const { attempts, wrapped } = fixture();
    const pending = wrapped.completeSimple(model, { messages: [] }, { signal: stop.signal });
    stop.abort();
    expect(attempts[0]?.signal?.aborted).toBe(true);
    const result = await pending;
    expect(result.stopReason).toBe("aborted");
    expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
    expect(vi.getTimerCount()).toBe(0);
  });

  it("lets a continuously producing summary outlive the idle budget", async () => {
    vi.useFakeTimers();
    vi.stubEnv("PI_DESKTOP_STREAM_IDLE_TIMEOUT_MS", "30000");
    const stages: string[] = [];
    const { attempts, wrapped } = fixture((stage) => stages.push(stage));
    const pending = wrapped.completeSimple(model, { messages: [] });
    const response = message();
    for (let n = 0; n < 4; n++) {
      await vi.advanceTimersByTimeAsync(29_000);
      attempts[0]!.stream.push({ type: "text_delta", contentIndex: 0, delta: "context", partial: response });
      await vi.advanceTimersByTimeAsync(0);
      expect(attempts[0]?.signal?.aborted).toBe(false);
    }
    attempts[0]!.stream.end(response);
    expect(await pending).toMatchObject({ content: response.content, stopReason: "stop" });
    expect(stages).toEqual(["waiting", "generating"]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not dispatch when already stopped", async () => {
    const stop = new AbortController();
    stop.abort();
    const { attempts, wrapped } = fixture();
    expect((await wrapped.completeSimple(model, { messages: [] }, { signal: stop.signal })).stopReason).toBe("aborted");
    expect(attempts).toHaveLength(0);
  });

  it("does not return a successful checkpoint when completion races with Stop", async () => {
    vi.useFakeTimers();
    const stop = new AbortController();
    const { attempts, wrapped } = fixture();
    const pending = wrapped.completeSimple(model, { messages: [] }, { signal: stop.signal });
    attempts[0]!.stream.end(message());
    stop.abort();
    expect((await pending).stopReason).toBe("aborted");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("stops during retry backoff without sending another request", async () => {
    vi.useFakeTimers();
    vi.stubEnv("PI_DESKTOP_STREAM_IDLE_TIMEOUT_MS", "30000");
    const stop = new AbortController();
    const { attempts, wrapped } = fixture();
    const pending = retryAssistantCall(() => wrapped.completeSimple(model, { messages: [] }, { signal: stop.signal }), {
      enabled: true, maxRetries: 3, baseDelayMs: 2_000,
    }, stop.signal);
    await vi.advanceTimersByTimeAsync(30_000);
    stop.abort();
    expect((await pending).stopReason).toBe("aborted");
    expect(attempts).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("exhausts bounded idle retries instead of waiting forever", async () => {
    vi.useFakeTimers();
    vi.stubEnv("PI_DESKTOP_STREAM_IDLE_TIMEOUT_MS", "30000");
    const { attempts, wrapped } = fixture();
    const pending = retryAssistantCall(() => wrapped.completeSimple(model, { messages: [] }), {
      enabled: true, maxRetries: 3, baseDelayMs: 2_000,
    }, undefined);
    await vi.advanceTimersByTimeAsync(134_000);
    expect(await pending).toMatchObject({ stopReason: "error", errorMessage: expect.stringContaining("timeout") });
    expect(attempts).toHaveLength(4);
    expect(attempts.every(({ signal }) => signal?.aborted)).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
});
