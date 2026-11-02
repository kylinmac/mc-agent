import { expect, it, vi } from "vitest";
import { createAssistantMessageEventStream, type AssistantMessage, type Message } from "@earendil-works/pi-ai";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ContextCompactionRecord, UiMessage } from "@pi-desktop/shared";
import { DesktopAgentRuntime } from "./runtime.js";
import type { ContextBudget } from "./context-budget.js";

const history: UiMessage[] = Array.from({ length: 4 }, (_, index) => ({
  id: `history-${index}`, role: index % 2 ? "assistant" : "user",
  content: "historical facts ".repeat(2500), createdAt: new Date(index + 1).toISOString(),
}));
history.push({ id: "filtered", role: "user", content: "", createdAt: new Date(5).toISOString() });
const broken: ContextCompactionRecord = {
  id: "broken", throughMessageId: "filtered", summary: "Unusable checkpoint", tokensBefore: 100,
  retainedTail: [], createdAt: new Date(6).toISOString(),
};
type Internal = {
  activeCompaction?: ContextCompactionRecord;
  liveSessionContext: () => { messages: AgentMessage[] };
  contextBudget: (messages: AgentMessage[]) => ContextBudget;
  runCompaction: () => Promise<boolean>;
  models: { streamSimple: (_model: unknown, context: { messages: Message[] }) => ReturnType<typeof createAssistantMessageEventStream> };
};

function fixture(checkpoints = [broken], enabled = true) {
  const requests: Message[][] = [];
  const saved: ContextCompactionRecord[] = [];
  const errors: string[] = [];
  const runtime = new DesktopAgentRuntime({
    sessionId: "offline", mode: "agent", thinkingLevel: "off", history,
    compactions: checkpoints, compactionSettings: { enabled, reserveTokens: 16_384, keepRecentTokens: 20_000 },
    provider: { id: "offline", name: "Offline", modelId: "offline", apiKey: "", supportsReasoning: false, supportedThinkingLevels: ["off"], authKind: "none", baseUrl: "https://fixture.invalid/v1",
      modelConfig: { source: "generic", name: "Offline", baseUrl: "https://fixture.invalid/v1", reasoning: false, input: ["text"], contextWindow: 32768, maxTokens: 1024 } },
    commandShell: { id: "bash", label: "Bash", dialect: "posix", available: true, isDefault: true },
    host: { call: async <T>(method: string, params?: unknown): Promise<T> => {
      if (method === "session.appendCompaction") saved.push((params as { compaction: ContextCompactionRecord }).compaction);
      return undefined as T;
    } },
    onEvent: ({ event }) => { if (event.type === "error") errors.push(event.error.code); },
  });
  const internal = runtime as unknown as Internal;
  internal.models = { streamSimple: (_model, context) => {
    requests.push(structuredClone(context.messages));
    const stream = createAssistantMessageEventStream();
    const message: AssistantMessage = { role: "assistant", content: [{ type: "text", text: "Offline summary and answer." }],
      api: "openai-completions", provider: "offline", model: "offline", stopReason: "stop", timestamp: 10,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
    stream.push({ type: "done", reason: "stop", message }); stream.end(); return stream;
  } };
  return { runtime, internal, requests, saved, errors };
}

it("compacts oversized full-history recovery before dispatch and reuses the saved replacement after restart", async () => {
  const f = fixture();
  try {
    expect(f.internal.activeCompaction).toBeUndefined();
    const before = f.internal.contextBudget(f.internal.liveSessionContext().messages);
    expect(before.tokens).toBeGreaterThan(before.hardLimit);
    await f.runtime.prompt("budget-probe", "next");
    expect(f.errors).toEqual([]);
    expect(f.saved).toHaveLength(1);
    const requests = f.requests.filter((messages) => JSON.stringify(messages).includes("budget-probe"));
    expect(requests).toHaveLength(1);
    expect(f.requests.indexOf(requests[0])).toBeGreaterThan(0);
    const after = f.internal.contextBudget(f.internal.liveSessionContext().messages);
    expect(after.tokens).toBeLessThan(after.hardLimit);
    expect(f.saved[0].throughMessageId).not.toBe("filtered");
    const restarted = fixture([broken, ...f.saved]);
    try {
      expect(restarted.internal.activeCompaction?.id).toBe(f.saved[0].id);
      await restarted.runtime.prompt("restart-probe", "restart");
      expect(restarted.errors).toEqual([]);
      expect(restarted.saved).toHaveLength(0);
      expect(restarted.requests).toHaveLength(1);
    } finally { await restarted.runtime.dispose(); }
  } finally { await f.runtime.dispose(); }
});

it.each(["disabled", "failed", "still-oversized"])("blocks recovered history when compaction is %s", async (scenario) => {
  const f = fixture([broken], scenario !== "disabled");
  const compact = vi.spyOn(f.internal, "runCompaction").mockResolvedValue(scenario === "still-oversized");
  try {
    expect(f.internal.activeCompaction).toBeUndefined();
    await f.runtime.prompt("budget-probe", "next");
    expect(f.requests).toHaveLength(0);
    expect(f.errors).toContain(scenario === "failed" ? "CONTEXT_COMPACTION_FAILED" : "CONTEXT_TOO_LARGE");
    expect(compact).toHaveBeenCalledTimes(scenario === "disabled" ? 0 : 1);
  } finally { compact.mockRestore(); await f.runtime.dispose(); }
});
