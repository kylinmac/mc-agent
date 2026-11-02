import { describe, expect, it, vi } from "vitest";
import { createAssistantMessageEventStream, type AssistantMessage, type Message } from "@earendil-works/pi-ai";
import type { ContextCompactionRecord, UiMessage } from "@pi-desktop/shared";
import type { MessageEntry } from "./pi-runtime-types.js";
import { compactionBoundaryId, restorableCompaction } from "./mc-compaction-boundary.js";
import { orderSystemRows } from "./system-transcript-journal.js";
import { DesktopAgentRuntime, type AgentRuntimeDiagnostic } from "./runtime.js";

const row = (id: string, role: UiMessage["role"], content: string): UiMessage =>
  ({ id, role, content, createdAt: new Date(1).toISOString() });
const old = row("old", "user", "Old request");
const system: UiMessage = { ...row("system", "system", ""), modelSystem: {
  version: 1, afterMessageId: "approved-plan:missing",
  messageJson: JSON.stringify({ role: "system", content: "", timestamp: 2 }),
} };
const result = row("result", "assistant", "100 tables: 8 GiB 122.09s; 6 GiB 112.11s; 4 GiB 115.86s");
function checkpoint(id: string, throughMessageId: string): ContextCompactionRecord {
  return { id, throughMessageId, summary: "Earlier work", tokensBefore: 100,
    retainedTail: [], createdAt: new Date(3).toISOString(), details: { retainedTailMode: "completed_turn" } };
}
const valid = checkpoint("valid", "old");
const broken = checkpoint("broken", "system");

describe("compaction replay boundaries", () => {
  it("keeps orphaned system rows at their persisted position across repeated restores", () => {
    const history = [old, system, result];
    expect(orderSystemRows(history)).toEqual(history);
    expect(orderSystemRows(orderSystemRows(history))).toEqual(history);
  });
  it("excludes system and virtual approval messages from new boundaries", () => {
    const entries: MessageEntry[] = [
      { type: "message", id: "result", seq: 0, parentId: null, timestamp: 1,
        message: { role: "user", content: "saved", timestamp: 1 } },
      { type: "message", id: "approved-plan:p", seq: 1, parentId: "result", timestamp: 2,
        message: { role: "user", content: "virtual", timestamp: 2 } },
      { type: "message", id: "system", seq: 2, parentId: "approved-plan:p", timestamp: 3,
        message: { role: "system", content: "", timestamp: 3 } },
    ];
    expect(compactionBoundaryId(entries)).toBe("result");
    expect(compactionBoundaryId(entries.slice(1))).toBeUndefined();
  });
  it("selects the last safe checkpoint without guessing timestamps", () => {
    const history = [old, system, result];
    const entries: MessageEntry[] = [old, result].map((message, seq) => ({
      type: "message", id: message.id, seq, parentId: null, timestamp: 1,
      message: { role: "user", content: message.content, timestamp: 1 },
    }));
    expect(restorableCompaction(history, [valid, broken], entries)).toBe(valid);
    expect(restorableCompaction(history, [broken], entries)).toBeUndefined();
    const newer = checkpoint("new", "result");
    expect(restorableCompaction(history, [valid, broken, newer], entries)).toBe(newer);
    expect(restorableCompaction(history, [checkpoint("missing", "absent")], entries)).toBeUndefined();
    expect(restorableCompaction([{ ...result, parentToolCallId: "delegate" }], [newer], entries)).toBeUndefined();
  });
  for (const boundary of [row("filtered", "user", ""), row("filtered", "assistant", ""), row("filtered", "tool", "")]) {
    it(`skips a checkpoint whose ${boundary.role} boundary disappears during conversion`, async () => {
      const diagnostics: AgentRuntimeDiagnostic[] = [];
      const runtime = new DesktopAgentRuntime({
        sessionId: "offline", mode: "agent", thinkingLevel: "off", history: [old, boundary, result],
        compactions: [valid, checkpoint("filtered-checkpoint", boundary.id)],
        provider: { id: "offline", name: "Offline", modelId: "offline", apiKey: "", supportsReasoning: false, supportedThinkingLevels: ["off"], authKind: "none", baseUrl: "https://fixture.invalid/v1" },
        commandShell: { id: "bash", label: "Bash", dialect: "posix", available: true, isDefault: true },
        host: { call: async <T>() => undefined as T }, onEvent: () => {}, onDiagnostic: (event) => diagnostics.push(event),
      });
      try {
        expect((runtime as unknown as { activeCompaction?: ContextCompactionRecord }).activeCompaction?.id).toBe("valid");
        expect(diagnostics.find((event) => event.kind === "context_restore")?.data).toMatchObject({ ok: true });
      } finally { await runtime.dispose(); }
    });
  }
  for (const checkpoints of [[valid, broken], [broken], [valid]]) {
    it(`keeps evidence in the next model request (${checkpoints.map((c) => c.id).join(", ")})`, async () => {
      const requests: Message[][] = [];
      const saved: ContextCompactionRecord[] = [];
      const diagnostics: AgentRuntimeDiagnostic[] = [];
      const runtime = new DesktopAgentRuntime({
        sessionId: "offline", mode: "agent", history: [old, system, result],
        compaction: checkpoints.at(-1), compactions: checkpoints,
        thinkingLevel: "off", provider: { id: "offline", name: "Offline", modelId: "offline",
          apiKey: "", authKind: "none", supportsReasoning: false, supportedThinkingLevels: ["off"], baseUrl: "https://fixture.invalid/v1" },
        commandShell: { id: "bash", label: "Bash", dialect: "posix", available: true, isDefault: true },
        host: { call: async (method: string, params: { compaction?: ContextCompactionRecord }) => {
          if (method === "session.appendCompaction" && params.compaction) saved.push(params.compaction);
          return undefined;
        } } as never, onEvent: () => {}, onDiagnostic: (event) => diagnostics.push(event),
      });
      const internal = runtime as unknown as { models: { streamSimple: (_model: unknown, context: { messages: Message[] }) => ReturnType<typeof createAssistantMessageEventStream> } };
      internal.models = { streamSimple: (_model, context) => {
        requests.push(structuredClone(context.messages));
        const stream = createAssistantMessageEventStream();
        const message: AssistantMessage = { role: "assistant", content: [{ type: "text", text: "Offline answer" }],
          api: "openai-completions", provider: "offline", model: "offline", stopReason: "stop", timestamp: 10,
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
        stream.push({ type: "done", reason: "stop", message }); stream.end(); return stream;
      } };
      try {
        await runtime.prompt("4 GiB is faster?", "next", "turn");
        expect(requests).toHaveLength(1);
        const restoration = diagnostics.find((d) => d.kind === "context_restore");
        const request = diagnostics.find((d) => d.kind === "context_request");
        expect(restoration?.data).toMatchObject({ ok: true });
        expect(request?.data).toMatchObject({ restoreId: restoration?.requestId, requestCount: requests[0].length });
        expect(JSON.stringify(diagnostics)).not.toContain(result.content);
        expect(JSON.stringify(requests[0])).toContain(result.content);
        expect(JSON.stringify(requests[0])).toContain("4 GiB is faster?");
        await runtime.compactManually();
        expect(saved).toHaveLength(1);
        expect(saved[0].throughMessageId).not.toBe("system");
        expect(saved[0].throughMessageId).not.toMatch(/^approved-/);
      } finally { await runtime.dispose(); }
    });
  }
});

// Fault injection verifies the real constructor stops before a model can be called.
it("rejects a restored projection that silently drops a required user row", () => {
  type Projection = { historyToEntries: (history: UiMessage[]) => MessageEntry[] };
  const prototype = DesktopAgentRuntime.prototype as unknown as Projection;
  const original = prototype.historyToEntries;
  const spy = vi.spyOn(prototype, "historyToEntries").mockImplementation(function (this: Projection, history) {
    return original.call(this, history).filter((entry) => entry.id !== "old");
  });
  const onClose = vi.fn();
  try {
    expect(() => new DesktopAgentRuntime({ sessionId: "offline", mode: "agent", thinkingLevel: "off", history: [old],
      provider: { id: "offline", name: "Offline", modelId: "offline", apiKey: "", authKind: "none", baseUrl: "https://fixture.invalid/v1", supportsReasoning: false, supportedThinkingLevels: ["off"] },
      commandShell: { id: "bash", label: "Bash", dialect: "posix", available: true, isDefault: true },
      host: { call: async () => undefined, onClose } as never, onEvent: () => {},
    })).toThrow();
    expect(onClose).not.toHaveBeenCalled();
  } finally { spy.mockRestore(); }
});
