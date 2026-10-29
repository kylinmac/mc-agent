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

  it("rejects a partially generated summary instead of treating the missing ending as complete", async () => {
    const { models } = fixture("length", "Partial summary without the final authorization constraints");
    const result = await compact(preparation, models, model, undefined, "medium", undefined, undefined, undefined);
    expect(result).toMatchObject({ ok: false, error: { code: "summarization_failed" } });
  });
});
