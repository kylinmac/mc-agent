import { describe, expect, it, vi } from "vitest";
import type { Api, AssistantMessage, Context, Model, Models, ModelsSimpleStreamOptions } from "@earendil-works/pi-ai";
import { compact } from "./pi-runtime-compaction-summary.js";
import type { CompactionPreparation, RuntimeThinkingLevel } from "./pi-runtime-types.js";

const model: Model<Api> = {
  id: "summary-test", name: "Summary test", api: "openai-responses", provider: "test",
  baseUrl: "https://example.invalid", reasoning: true, input: ["text"],
  contextWindow: 256_000, maxTokens: 64_000,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
const preparation: CompactionPreparation = {
  messagesToSummarize: [
    { role: "user", content: "Keep the production database unchanged. Finish issue TASK-42 in /workspace/src/store.ts; test case pending-auth remains unverified.", timestamp: 1 },
    { role: "user", content: "Correction: use CAS, not last-write-wins. Deployment still requires my approval.", timestamp: 2 },
  ],
  turnPrefixMessages: [], retainedTail: [], isSplitTurn: false, tokensBefore: 90_000,
  previousSummary: "Goal TASK-42; CAS avoids lost updates. Do not deploy. Blocking error E_CONFLICT.",
  fileOps: { read: new Set(["/workspace/README.md"]), edited: new Set(["/workspace/src/store.ts"]), written: new Set() },
  settings: { enabled: true, reserveTokens: 64_000, keepRecentTokens: 16_000 },
};

function fixture(stopReason: AssistantMessage["stopReason"] = "stop", text = "Goal TASK-42; keep production unchanged; CAS; deployment needs approval; pending-auth unverified.") {
  const response: AssistantMessage = {
    role: "assistant", content: [{ type: "text", text }], api: model.api, provider: model.provider,
    model: model.id, timestamp: 3, stopReason,
    usage: { input: 100, output: 30, cacheRead: 0, cacheWrite: 0, totalTokens: 130,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  };
  const completeSimple = vi.fn(async (_model: Model<Api>, _context: Context, _options?: ModelsSimpleStreamOptions) => response);
  const models = { completeSimple } as unknown as Models;
  return { completeSimple, models, response };
}

describe("compaction summary handoff", () => {
  it.each<RuntimeThinkingLevel>(["high", "xhigh", "max"])("caps %s summary reasoning without changing the conversation model", async (level) => {
    const { models, completeSimple } = fixture();
    await compact(preparation, models, model, undefined, level, undefined, undefined, undefined);
    expect(completeSimple.mock.calls[0]?.[2]?.reasoning).toBe("medium");
    expect(completeSimple.mock.calls[0]?.[0]).toBe(model);
  });

  it.each<RuntimeThinkingLevel>(["off", "low", "medium"])("keeps a user's lower summary effort %s", async (level) => {
    const { models, completeSimple } = fixture();
    await compact(preparation, models, model, undefined, level, undefined, undefined, undefined);
    expect(completeSimple.mock.calls[0]?.[2]?.reasoning).toBe(level === "off" ? undefined : level);
  });

  it("does not request reasoning from a non-reasoning model", async () => {
    const { models, completeSimple } = fixture();
    await compact(preparation, models, { ...model, reasoning: false }, undefined, "max", undefined, undefined, undefined);
    expect(completeSimple.mock.calls[0]?.[2]?.reasoning).toBeUndefined();
  });

  it("prefers low instead of raising an unsupported medium to high", async () => {
    const { models, completeSimple } = fixture();
    await compact(preparation, models, { ...model, thinkingLevelMap: { medium: null } }, undefined, "max", undefined, undefined, undefined);
    expect(completeSimple.mock.calls[0]?.[2]?.reasoning).toBe("low");
  });

  it("uses the minimum supported effort for a model that only allows high", async () => {
    const { models, completeSimple } = fixture();
    await compact(preparation, models, {
      ...model, thinkingLevelMap: { off: null, minimal: null, low: null, medium: null },
    }, undefined, "max", undefined, undefined, undefined);
    expect(completeSimple.mock.calls[0]?.[2]?.reasoning).toBe("high");
  });

  it("preserves omitted reasoning without mutating the session model", async () => {
    const { models, completeSimple } = fixture();
    const before = structuredClone(model);
    await compact(preparation, models, model, undefined, "omit", undefined, undefined, undefined);
    expect(completeSimple.mock.calls[0]?.[2]?.reasoning).toBeUndefined();
    expect(completeSimple.mock.calls[0]?.[0].thinkingLevelMap?.off).toBeNull();
    expect(model).toEqual(before);
  });

  it("keeps all source messages, the previous summary, and file references while asking for a concise handoff", async () => {
    const { models, completeSimple } = fixture();
    const before = structuredClone(preparation);
    const result = await compact(preparation, models, model, undefined, "max", undefined, undefined, undefined);
    const context = completeSimple.mock.calls[0]?.[1];
    const prompt = JSON.stringify(context);
    for (const message of preparation.messagesToSummarize) {
      if (message.role === "user") expect(prompt).toContain(String(message.content));
    }
    expect(prompt).toContain(preparation.previousSummary);
    expect(prompt).toContain("4,000–8,000 tokens");
    expect(prompt).toContain("authorization boundaries");
    expect(prompt).not.toContain("PRESERVE all existing information");
    expect(preparation).toEqual(before);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.summary).toContain("TASK-42");
      expect(result.value.summary).toContain("/workspace/src/store.ts");
      expect(result.value.summary).toContain("/workspace/README.md");
    }
  });

  it("does not enforce the soft target by slicing a complete summary", async () => {
    const text = "essential context ".repeat(4_000) + "FINAL_REQUIRED_CONSTRAINT";
    const { models } = fixture("stop", text);
    const result = await compact(preparation, models, model, undefined, "medium", undefined, undefined, undefined);
    expect(result.ok && result.value.summary.startsWith(text)).toBe(true);
  });

  it("prioritizes a complete handoff within a small model's generation budget without clipping its input", async () => {
    const { models, completeSimple } = fixture();
    await compact(preparation, models, { ...model, maxTokens: 1024 }, undefined, "low", undefined, undefined, undefined);
    const context = completeSimple.mock.calls[0]?.[1];
    expect(completeSimple.mock.calls[0]?.[2]?.maxTokens).toBe(1024);
    expect(context?.systemPrompt).toContain("generation budget is 1024 tokens");
    expect(context?.systemPrompt).toContain("takes precedence over the soft length target");
    const prompt = JSON.stringify(context);
    expect(prompt).toContain(preparation.previousSummary);
    for (const message of preparation.messagesToSummarize) {
      if (message.role === "user") expect(prompt).toContain(String(message.content));
    }
  });

  it("rejects a partially generated summary instead of treating the missing ending as complete", async () => {
    const { models, completeSimple } = fixture("length", "Partial summary without the final authorization constraints");
    const result = await compact(preparation, models, model, undefined, "medium", undefined, undefined, undefined);
    expect(completeSimple).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({ ok: false, error: { code: "summarization_failed" } });
  });

  it("retries a truncated summary once with a shorter target and the lowest reasoning", async () => {
    const { models, completeSimple, response } = fixture();
    completeSimple.mockResolvedValueOnce({ ...response, stopReason: "length", content: [{ type: "text", text: "Partial" }] });
    const onRetryScheduled = vi.fn();
    const result = await compact(preparation, models, model, undefined, "medium", undefined, { onRetryScheduled }, undefined);
    expect(completeSimple).toHaveBeenCalledTimes(2);
    expect(completeSimple.mock.calls[0]?.[2]?.reasoning).toBe("medium");
    expect(completeSimple.mock.calls[1]?.[2]?.reasoning).toBeUndefined();
    expect(completeSimple.mock.calls[0]?.[1]?.systemPrompt).not.toContain("previous attempt exceeded");
    expect(completeSimple.mock.calls[1]?.[1]?.systemPrompt).toContain("previous attempt exceeded the generation budget");
    expect(completeSimple.mock.calls[1]?.[1]?.systemPrompt).toContain("2,000–4,000 tokens");
    expect(onRetryScheduled).toHaveBeenCalledOnce();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.summary).toContain("TASK-42");
      expect(result.value.usage?.output).toBe(60);
    }
  });

  it("does not retry a truncated summary after the user stopped", async () => {
    const { models, completeSimple } = fixture("length", "Partial");
    const controller = new AbortController();
    completeSimple.mockImplementationOnce(async () => {
      controller.abort();
      return { ...fixture("length", "Partial").response };
    });
    const result = await compact(preparation, models, model, undefined, "medium", undefined, undefined, controller.signal);
    expect(completeSimple).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ ok: false, error: { code: "aborted" } });
  });

  it("scales the length target to an 8K output limit so reasoning still fits", async () => {
    const { models, completeSimple } = fixture();
    await compact(preparation, models, { ...model, maxTokens: 8_192 }, undefined, "medium", undefined, undefined, undefined);
    const systemPrompt = completeSimple.mock.calls[0]?.[1]?.systemPrompt;
    expect(completeSimple.mock.calls[0]?.[2]?.maxTokens).toBe(8_192);
    expect(systemPrompt).toContain("1,638–3,276 tokens");
    expect(systemPrompt).not.toContain("4,000–8,000");
  });

  it("gives a split turn's prefix its own short target", async () => {
    const { models, completeSimple } = fixture();
    await compact({
      ...preparation,
      isSplitTurn: true,
      turnPrefixMessages: [{ role: "user", content: "Refactor the store module.", timestamp: 3 }],
    }, models, model, undefined, "medium", undefined, undefined, undefined);
    expect(completeSimple).toHaveBeenCalledTimes(2);
    expect(completeSimple.mock.calls[0]?.[1]?.systemPrompt).toContain("4,000–8,000 tokens");
    const prefixPrompt = completeSimple.mock.calls[1]?.[1]?.systemPrompt;
    expect(prefixPrompt).toContain("prefix summary under about 2,000 tokens");
    expect(prefixPrompt).not.toContain("Aim for roughly");
  });

  it("asks for verbatim user boundaries without copying pasted material", async () => {
    const { models, completeSimple } = fixture();
    await compact(preparation, models, model, undefined, "medium", undefined, undefined, undefined);
    const prompt = JSON.stringify(completeSimple.mock.calls[0]?.[1]);
    expect(prompt).toContain("quote the operative sentence verbatim");
    expect(prompt).toContain("Never copy pasted logs, code, or long documents");
    expect(prompt).toContain("keep earlier verbatim user quotes unless the user revoked them");
  });
});
