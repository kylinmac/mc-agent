import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEEPSEEK_MODELS } from "@earendil-works/pi-ai/providers/deepseek.models";
import type { AgentEventEnvelope, UiMessage } from "@pi-desktop/shared";
import { modelConfigFromPi } from "./model-capabilities.js";
import {
  BACKGROUND_SUMMARY_TRIGGER_RATIO,
  keepsRetainedUserMessage,
  preparedSummaryDiscardReason,
  shouldPrepareSummary,
  usageAnchorIsStale,
} from "./mc-background-compaction.js";
import { DesktopAgentRuntime, type AgentRuntimeDiagnostic, type RuntimeProviderConfig } from "./runtime.js";

// mc-agent (MC-ADR-0028, #121): the compaction summary prepared ahead of the threshold.

describe("shouldPrepareSummary", () => {
  const base = { enabled: true, hardLimit: 100_000, automaticThreshold: 90_000, busy: false };
  it("starts only between the preparation line and the automatic threshold", () => {
    expect(BACKGROUND_SUMMARY_TRIGGER_RATIO).toBe(0.8);
    expect(shouldPrepareSummary({ ...base, tokens: 79_999 })).toBe(false);
    expect(shouldPrepareSummary({ ...base, tokens: 80_000 })).toBe(true);
    expect(shouldPrepareSummary({ ...base, tokens: 89_999 })).toBe(true);
    // At the threshold the inline path owns the request.
    expect(shouldPrepareSummary({ ...base, tokens: 90_000 })).toBe(false);
  });
  it("never starts when the option is off or a summary is already in hand", () => {
    expect(shouldPrepareSummary({ ...base, tokens: 85_000, enabled: false })).toBe(false);
    expect(shouldPrepareSummary({ ...base, tokens: 85_000, busy: true })).toBe(false);
  });
});

describe("preparedSummaryDiscardReason", () => {
  const basis = { boundaryId: "m9", activeCheckpointId: "c1", modelKey: "p\u0000m\u0000off" };
  const current = { hasMessage: (id: string) => id === "m9", activeCheckpointId: "c1", modelKey: basis.modelKey };
  it("accepts a summary whose basis still holds", () => {
    expect(preparedSummaryDiscardReason(basis, current)).toBeUndefined();
  });
  it("rejects a rewritten history, another checkpoint, or another model", () => {
    expect(preparedSummaryDiscardReason(basis, { ...current, hasMessage: () => false })).toBe("boundary_missing");
    expect(preparedSummaryDiscardReason(basis, { ...current, activeCheckpointId: "c2" })).toBe("checkpoint_changed");
    expect(preparedSummaryDiscardReason({ boundaryId: "m9", modelKey: basis.modelKey }, current)).toBe("checkpoint_changed");
    expect(preparedSummaryDiscardReason(basis, { ...current, modelKey: "p\u0000m\u0000high" })).toBe("model_changed");
  });
});

describe("install-time rules", () => {
  it("keeps the retained user message only while the same turn is still running", () => {
    expect(keepsRetainedUserMessage(true, false)).toBe(true);
    expect(keepsRetainedUserMessage(true, true)).toBe(false);
    expect(keepsRetainedUserMessage(false, false)).toBe(false);
  });
  it("treats usage reported at or before the install as stale, and nothing else", () => {
    expect(usageAnchorIsStale(1_000, 1_000)).toBe(true);
    expect(usageAnchorIsStale(999, 1_000)).toBe(true);
    expect(usageAnchorIsStale(1_001, 1_000)).toBe(false);
    expect(usageAnchorIsStale(1_000, undefined)).toBe(false);
    expect(usageAnchorIsStale(undefined, 1_000)).toBe(false);
    expect(usageAnchorIsStale(1_000, "1000")).toBe(false);
  });
});

function provider(): RuntimeProviderConfig {
  const model = Object.values(DEEPSEEK_MODELS).find((item) => item.id === "deepseek-flash")!;
  return { id: "background-fixture", name: "Flash", modelId: model.id, baseUrl: model.baseUrl,
    apiKey: "fixture", authKind: "api_key", supportsReasoning: false, supportedThinkingLevels: ["off"],
    modelConfig: { ...modelConfigFromPi(model), contextWindow: 64_000, maxTokens: 4_096 } };
}

type Payload = { tools?: unknown[]; messages: { role: string; content?: unknown }[] };
const SUMMARY = "SUMMARY-OF-EARLY-STEPS";

/**
 * A model that keeps asking for one more command until it sees the summary in
 * its context, then finishes. Summary requests (no tools) can be held open.
 */
async function scriptedModel(holdSummary = false) {
  const turns: Payload[] = [];
  const summaries: Payload[] = [];
  let step = 0;
  let releaseSummary: (() => void) | undefined;
  const held = new Promise<void>((resolve) => { releaseSummary = resolve; });
  const fetch = globalThis.fetch;
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString()) as Payload;
    const send = (delta: unknown, finish: string) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: finish }] })}\n\ndata: [DONE]\n\n`);
    };
    if (!body.tools || body.tools.length === 0) {
      summaries.push(body);
      if (holdSummary) await held;
      if (res.destroyed) return;
      send({ role: "assistant", content: SUMMARY }, "stop");
      return;
    }
    turns.push(body);
    if (JSON.stringify(body.messages).includes(SUMMARY)) {
      send({ role: "assistant", content: "Done." }, "stop");
      return;
    }
    step += 1;
    send({ role: "assistant", tool_calls: [{ index: 0, id: randomUUID(), type: "function",
      function: { name: "Bash", arguments: JSON.stringify({ command: `step-${step}` }) } }] }, "tool_calls");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing HTTP address");
  vi.stubGlobal("fetch", ((_url, init) => fetch(`http://127.0.0.1:${address.port}`, init)) satisfies typeof fetch);
  return {
    turns, summaries, steps: () => step,
    releaseSummary: () => releaseSummary?.(),
    close: () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }),
  };
}

function runtime(backgroundCompaction: boolean) {
  const events: AgentEventEnvelope["event"][] = [];
  const diagnostics: AgentRuntimeDiagnostic[] = [];
  const checkpoints: Array<{ throughMessageId: string; details?: unknown }> = [];
  const rows: UiMessage[] = [];
  const agent = new DesktopAgentRuntime({
    sessionId: "background", mode: "agent", provider: provider(), thinkingLevel: "off", history: rows,
    backgroundCompaction,
    projectPath: mkdtempSync(join(tmpdir(), "mc-background-")),
    commandShell: { id: "bash", label: "Bash", dialect: "posix", available: true, isDefault: true },
    host: { call: async <T>(method: string, params?: unknown): Promise<T> => {
      if (method === "session.appendCompaction") {
        checkpoints.push((params as { compaction: { throughMessageId: string; details?: unknown } }).compaction);
        return { ok: true } as T;
      }
      if (method !== "tools.execute") return undefined as T;
      const command = (params as { args: { command: string } }).args.command;
      // Under the size the tool-result clearing (R31) touches, so the context
      // really climbs to the preparation line.
      return { ok: true, content: `output-of-${command}\n`.padEnd(4_400, "z") } as T;
    } },
    onEvent: (envelope) => { events.push(envelope.event); },
    onDiagnostic: (diagnostic) => { diagnostics.push(diagnostic); },
  });
  const stages = () => diagnostics
    .filter((diagnostic) => diagnostic.kind === "background_compaction")
    .map((diagnostic) => `${diagnostic.data.stage}${diagnostic.data.reason ? `:${diagnostic.data.reason}` : ""}`);
  return { agent, events, diagnostics, checkpoints, stages };
}

afterEach(() => vi.unstubAllGlobals());

describe("background compaction in the runtime", () => {
  it("prepares the summary early and installs it at the threshold, keeping later steps verbatim", async () => {
    const model = await scriptedModel();
    const { agent, events, checkpoints, stages } = runtime(true);
    try {
      await agent.prompt("run the steps", "u1", "t1");
      expect(stages()).toEqual(["started", "installed"]);
      expect(model.summaries).toHaveLength(1);
      expect(checkpoints).toHaveLength(1);
      expect(events.filter((event) => event.type === "compaction_end" && event.ok)).toHaveLength(1);

      // Steps ran between the summary request and the install.
      const stepsSummarized = (JSON.stringify(model.summaries[0]!.messages).match(/output-of-step-\d+/g) ?? [])
        .map((match) => Number(match.split("-").at(-1)));
      const lastSummarized = Math.max(...stepsSummarized);
      expect(model.steps()).toBeGreaterThan(lastSummarized);

      // The request after the install: the summary, then those later steps as they were.
      const after = JSON.stringify(model.turns.at(-1)!.messages);
      expect(after).toContain(SUMMARY);
      expect(after).not.toContain("output-of-step-1\\n");
      expect(after).not.toContain(`output-of-step-${lastSummarized}\\n`);
      expect(after).toContain(`output-of-step-${lastSummarized + 1}\\n`);
      expect(after).toContain(`output-of-step-${model.steps()}\\n`);
      // The turn's request survives verbatim as the retained user message.
      expect(after).toContain("run the steps");
    } finally { await agent.dispose(); await model.close(); }
  });

  it("with the option off, nothing is requested before the threshold", async () => {
    const model = await scriptedModel();
    const { agent, stages, checkpoints } = runtime(false);
    try {
      await agent.prompt("run the steps", "u1", "t1");
      expect(stages()).toEqual([]);
      expect(model.summaries).toHaveLength(1);
      expect(checkpoints).toHaveLength(1);
      // Inline: the summary covers everything, so no step output follows it.
      const after = JSON.stringify(model.turns.at(-1)!.messages);
      expect(after).toContain(SUMMARY);
      expect(after).not.toMatch(/output-of-step-\d+/);
    } finally { await agent.dispose(); await model.close(); }
  });

  it("waits for a summary still being written instead of starting a second request", async () => {
    const model = await scriptedModel(true);
    const { agent, events, stages } = runtime(true);
    try {
      const done = agent.prompt("run the steps", "u1", "t1");
      await vi.waitFor(() => expect(events.some((event) => event.type === "compaction_start")).toBe(true), { timeout: 10_000 });
      const turnsWhileWaiting = model.turns.length;
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(model.turns).toHaveLength(turnsWhileWaiting);
      expect(model.summaries).toHaveLength(1);
      model.releaseSummary();
      await done;
      expect(model.summaries).toHaveLength(1);
      expect(stages()).toEqual(["started", "installed"]);
    } finally { model.releaseSummary(); await agent.dispose(); await model.close(); }
  });

  it("a stop while waiting ends the turn without another summary request", async () => {
    const model = await scriptedModel(true);
    const { agent, events, checkpoints } = runtime(true);
    try {
      const done = agent.prompt("run the steps", "u1", "t1");
      await vi.waitFor(() => expect(events.some((event) => event.type === "compaction_start")).toBe(true), { timeout: 10_000 });
      const turns = model.turns.length;
      await agent.abort();
      await done;
      expect(model.summaries).toHaveLength(1);
      expect(model.turns).toHaveLength(turns);
      expect(checkpoints).toHaveLength(0);
      expect(events.filter((event) => event.type === "agent_end")).toHaveLength(1);
    } finally { model.releaseSummary(); await agent.dispose(); await model.close(); }
  });

  it("disposing the runtime cancels a summary in preparation", async () => {
    const model = await scriptedModel(true);
    const { agent, stages } = runtime(true);
    try {
      const done = agent.prompt("run the steps", "u1", "t1").catch(() => undefined);
      await vi.waitFor(() => expect(stages()).toEqual(["started"]), { timeout: 10_000 });
      await agent.dispose();
      await done;
      expect(stages()).toEqual(["started", "discarded:disposed"]);
    } finally { model.releaseSummary(); await agent.dispose(); await model.close(); }
  });
});
