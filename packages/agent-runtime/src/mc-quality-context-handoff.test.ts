import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEEPSEEK_MODELS } from "@earendil-works/pi-ai/providers/deepseek.models";
import type {
  AgentEventEnvelope,
  ContextCompactionRecord,
  UiMessage,
} from "@pi-desktop/shared";
import { modelConfigFromPi } from "./model-capabilities.js";
import type { HistoryReadResponse } from "./mc-context-history-tool.js";
import { CACHE_SHARED_SUMMARY_MARKER } from "./mc-compaction-cache-prefix.js";
import {
  DesktopAgentRuntime,
  type AgentRuntimeDiagnostic,
  type RuntimeProviderConfig,
} from "./runtime.js";

// mc-agent (#148 / Q02, Q03, Q04): end-to-end context handoff across pruning,
// background compaction, in-flight corrections, invalidation, restart, and
// ContextHistory lookup.

function provider(contextWindow = 64_000, maxTokens = 4_096): RuntimeProviderConfig {
  const model = Object.values(DEEPSEEK_MODELS).find((item) => item.id === "deepseek-flash")!;
  return {
    id: "q02-fixture",
    name: "Flash",
    modelId: model.id,
    baseUrl: "http://provider.invalid/v1",
    apiKey: "fixture",
    apiStyle: "chat_completions",
    supportsReasoning: true,
    supportedThinkingLevels: ["off", "medium"],
    modelConfig: { ...modelConfigFromPi(model), contextWindow, maxTokens },
  };
}

type Payload = {
  tools?: Array<{ function?: { name?: string } }>;
  messages: Array<{
    role: string;
    content?: unknown;
    tool_call_id?: string;
    tool_calls?: Array<{ id: string }>;
  }>;
};

function sseResponse(
  delta: unknown,
  finish: string,
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number },
): Response {
  const chunk = (value: unknown, reason: string | null, u?: typeof usage) =>
    `data: ${JSON.stringify({
      id: "c1",
      object: "chat.completion.chunk",
      created: 1,
      model: "deepseek-flash",
      choices: [{ index: 0, delta: value, finish_reason: reason }],
      ...(u ? { usage: u } : {}),
    })}\n\n`;
  return new Response(
    chunk(delta, null) + chunk({}, finish, usage) + "data: [DONE]\n\n",
    { headers: { "content-type": "text/event-stream" } },
  );
}

function assertToolPairsValid(messages: Payload["messages"]): void {
  const pending = new Set<string>();
  for (const message of messages) {
    if (message.role === "assistant" && Array.isArray(message.tool_calls)) {
      for (const call of message.tool_calls) pending.add(call.id);
    } else if (message.role === "tool" && message.tool_call_id) {
      expect(pending.delete(message.tool_call_id), `missing toolCall for ${message.tool_call_id}`).toBe(true);
    }
  }
}

function createTranscriptRecorder(initial: UiMessage[]) {
  const rows: UiMessage[] = [...initial];
  const toolStarts = new Map<string, { toolName: string; args: unknown; ts: number }>();
  const upsert = (msg: UiMessage) => {
    const index = rows.findIndex((item) => item.id === msg.id);
    if (index >= 0) rows[index] = msg;
    else rows.push(msg);
  };
  const recordEvent = (envelope: AgentEventEnvelope) => {
    const event = envelope.event;
    if (event.type === "message_end") {
      upsert(event.message);
    } else if (event.type === "tool_start") {
      toolStarts.set(event.toolCallId, { toolName: event.toolName, args: event.args, ts: envelope.ts });
    } else if (event.type === "tool_end") {
      const started = toolStarts.get(event.toolCallId);
      upsert({
        id: event.toolCallId,
        role: "tool",
        content: typeof event.result === "string" ? event.result : JSON.stringify(event.result),
        createdAt: new Date(started?.ts ?? envelope.ts).toISOString(),
        toolCallId: event.toolCallId,
        ...(started ? { toolName: started.toolName, toolArgs: started.args } : {}),
        toolStatus: event.isError ? "error" : "success",
        toolResult: event.result,
        status: "complete",
        isError: event.isError,
      });
    }
  };
  return { rows, upsert, recordEvent };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Q02-Q04: context handoff, invalidation, and usage anchor consistency", () => {
  it("Q02: flows from pruning -> background summary -> steered correction -> install -> restart -> ContextHistory lookup", async () => {
    const turnRequests: Payload[] = [];
    const summaryRequests: Payload[] = [];
    let holdSummary = true;
    let releaseSummary!: () => void;
    const summaryReleased = new Promise<void>((resolve) => { releaseSummary = resolve; });
    let step = 0;

    vi.stubGlobal("fetch", async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as Payload;
      if (!body.tools || body.tools.length === 0 || JSON.stringify(body.messages).includes(CACHE_SHARED_SUMMARY_MARKER)) {
        summaryRequests.push(body);
        if (holdSummary) await summaryReleased;
        return sseResponse({ role: "assistant", content: "HANDOFF-SUMMARY: goal=migrate-port, forbidden=never-delete-db" }, "stop");
      }
      turnRequests.push(body);
      const allText = JSON.stringify(body.messages);
      if (allText.includes("HANDOFF-SUMMARY")) {
        return sseResponse({ role: "assistant", content: "Resumed after checkpoint." }, "stop");
      }
      step += 1;
      return sseResponse(
        {
          role: "assistant",
          tool_calls: [
            {
              index: 0,
              id: randomUUID(),
              type: "function",
              function: { name: "Bash", arguments: JSON.stringify({ command: `step-${step}` }) },
            },
          ],
        },
        "tool_calls",
      );
    });

    const recorder = createTranscriptRecorder([
      {
        id: "u1",
        role: "user",
        content: "Goal: migrate port. Forbidden: never-delete-db.",
        createdAt: new Date(1000).toISOString(),
      },
    ]);
    const checkpoints: ContextCompactionRecord[] = [];
    const diagnostics: AgentRuntimeDiagnostic[] = [];
    const dir = mkdtempSync(join(tmpdir(), "mc-q02-"));

    const runtime = new DesktopAgentRuntime({
      sessionId: "q02-session",
      mode: "agent",
      provider: provider(),
      thinkingLevel: "off",
      history: [...recorder.rows],
      backgroundCompaction: true,
      projectPath: dir,
      commandShell: { id: "bash", label: "Bash", dialect: "posix", available: true, isDefault: true },
      host: {
        call: async <T>(method: string, params?: unknown): Promise<T> => {
          if (method === "session.appendCompaction") {
            checkpoints.push((params as { compaction: ContextCompactionRecord }).compaction);
            return { ok: true } as T;
          }
          if (method === "session.appendMessage") {
            recorder.upsert((params as { message: UiMessage }).message);
            return undefined as T;
          }
          if (method !== "tools.execute") return undefined as T;
          const cmd = (params as { args: { command: string } }).args.command;
          // With hardLimit = 47,616 and keepRecentTokens = 9,523:
          // Steps 1..6 (~6k tokens each) pass 70% (33,331) and prune early outputs;
          // steps 7+ (~1.1k tokens each, < 1,500) climb past 80% (38,092) to 90% (42,854).
          const isLarge = Number(cmd.split("-")[1]) <= 6;
          const payload = isLarge
            ? `SECRET-EVIDENCE-${cmd}\n`.padEnd(24_000, "a")
            : `tail-output-${cmd}\n`.padEnd(4_400, "b");
          return { ok: true, content: payload } as T;
        },
      },
      onEvent: (envelope) => recorder.recordEvent(envelope),
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    });

    try {
      const promptPromise = runtime.prompt("Goal: migrate port. Forbidden: never-delete-db.", "u1", "t1");
      await vi.waitFor(
        () => expect(diagnostics.some((d) => d.kind === "background_compaction" && d.data.stage === "started")).toBe(true),
        { timeout: 10_000 },
      );

      // Inject a new user correction AFTER background summary started (past boundaryId).
      const correctionMsg: UiMessage = {
        id: "u-correction",
        role: "user",
        content: "USER-CORRECTION-PORT-9090",
        createdAt: new Date().toISOString(),
      };
      runtime.steer({ text: "USER-CORRECTION-PORT-9090" }, "t1", correctionMsg);
      recorder.upsert(correctionMsg);

      holdSummary = false;
      releaseSummary();
      await promptPromise;

      expect(diagnostics.some((d) => d.kind === "tool_result_pruning")).toBe(true);
      expect(diagnostics.some((d) => d.kind === "background_compaction" && d.data.stage === "installed")).toBe(true);
      expect(summaryRequests).toHaveLength(1);
      expect(checkpoints).toHaveLength(1);
      const postInstallText = JSON.stringify(turnRequests.at(-1)!.messages);
      expect(postInstallText).toContain("HANDOFF-SUMMARY");
      expect(postInstallText).toContain("USER-CORRECTION-PORT-9090");
      assertToolPairsValid(turnRequests.at(-1)!.messages);
    } finally {
      releaseSummary();
      await runtime.dispose();
    }

    // Restart into a brand-new runtime with persisted history + checkpoint and verify ContextHistory lookup.
    const restartedRequests: Payload[] = [];
    let restartStep = 0;
    vi.stubGlobal("fetch", async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as Payload;
      restartedRequests.push(body);
      restartStep += 1;
      if (restartStep === 1) {
        return sseResponse(
          {
            role: "assistant",
            tool_calls: [
              {
                index: 0,
                id: randomUUID(),
                type: "function",
                function: { name: "ToolSearch", arguments: JSON.stringify({ query: "ContextHistory" }) },
              },
            ],
          },
          "tool_calls",
        );
      }
      if (restartStep === 2) {
        return sseResponse(
          {
            role: "assistant",
            tool_calls: [
              {
                index: 0,
                id: randomUUID(),
                type: "function",
                function: { name: "ContextHistory", arguments: JSON.stringify({ query: "SECRET-EVIDENCE" }) },
              },
            ],
          },
          "tool_calls",
        );
      }
      return sseResponse({ role: "assistant", content: "Verified restored evidence." }, "stop");
    });

    const historyReadCalls: unknown[] = [];
    const restarted = new DesktopAgentRuntime({
      sessionId: "q02-session",
      mode: "agent",
      provider: provider(),
      thinkingLevel: "off",
      history: recorder.rows,
      compactions: checkpoints,
      backgroundCompaction: true,
      projectPath: dir,
      commandShell: { id: "bash", label: "Bash", dialect: "posix", available: true, isDefault: true },
      host: {
        call: async <T>(method: string, params?: unknown): Promise<T> => {
          if (method === "session.historyRead") {
            historyReadCalls.push(params);
            const throughIdx = recorder.rows.findIndex((m) => m.id === checkpoints[0]!.throughMessageId);
            const preBoundary = throughIdx >= 0 ? recorder.rows.slice(0, throughIdx + 1) : recorder.rows;
            const matches = preBoundary.filter((m) =>
              String(m.content).includes("SECRET-EVIDENCE-step-1"),
            );
            const resp: HistoryReadResponse = {
              status: "ok",
              checkpointId: checkpoints[0]!.id,
              messages: matches.map((m) => ({
                id: m.id,
                role: m.role,
                createdAt: m.createdAt,
                toolName: m.toolName,
                text: String(m.content),
              })),
              scanned: preBoundary.length,
              reachedStart: true,
            };
            return resp as T;
          }
          return undefined as T;
        },
      },
      onEvent: () => {},
    });

    try {
      await restarted.prompt("check what was earlier", "u-restart", "t2");
      expect(restartedRequests).toHaveLength(3);
      const firstRequestText = JSON.stringify(restartedRequests[0]!.messages);
      expect(firstRequestText).toContain("HANDOFF-SUMMARY");
      expect(firstRequestText).toContain("USER-CORRECTION-PORT-9090");
      assertToolPairsValid(restartedRequests[0]!.messages);
      expect(historyReadCalls).toHaveLength(1);
      expect(JSON.stringify(restartedRequests[2]!.messages)).toContain("SECRET-EVIDENCE-step-1");
    } finally {
      await restarted.dispose();
    }
  });

  it("Q03: discards held background summary immediately on model/thinking or boundary change without hanging", async () => {
    for (const invalidationKind of ["model_changed", "boundary_missing"] as const) {
      let summaryCount = 0;
      let step = 0;
      let summaryHasStarted = false;
      let resolveSummaryStarted!: () => void;
      const summaryStarted = new Promise<void>((resolve) => { resolveSummaryStarted = resolve; });

      vi.stubGlobal("fetch", async (_url: unknown, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body ?? "{}")) as Payload;
        if (!body.tools || body.tools.length === 0 || JSON.stringify(body.messages).includes(CACHE_SHARED_SUMMARY_MARKER)) {
          summaryCount += 1;
          if (summaryCount === 1) {
            summaryHasStarted = true;
            resolveSummaryStarted();
            // Simulate an in-flight summary that only finishes if aborted by RT-2!
            return await new Promise<Response>((_resolve, reject) => {
              const onAbort = () => reject(new DOMException("Aborted", "AbortError"));
              if (init?.signal?.aborted) onAbort();
              else init?.signal?.addEventListener("abort", onAbort, { once: true });
            });
          }
          return sseResponse({ role: "assistant", content: "INLINE-FRESH-SUMMARY" }, "stop");
        }
        const text = JSON.stringify(body.messages);
        if (text.includes("INLINE-FRESH-SUMMARY")) {
          return sseResponse({ role: "assistant", content: "Recovered cleanly." }, "stop");
        }
        step += 1;
        return sseResponse(
          {
            role: "assistant",
            tool_calls: [
              {
                index: 0,
                id: randomUUID(),
                type: "function",
                function: { name: "Bash", arguments: JSON.stringify({ command: `step-${step}` }) },
              },
            ],
          },
          "tool_calls",
        );
      });

      const diagnostics: AgentRuntimeDiagnostic[] = [];
      let gatedOnce = false;
      let releaseThresholdTool!: () => void;
      const thresholdGate = new Promise<void>((resolve) => { releaseThresholdTool = resolve; });

      const runtime = new DesktopAgentRuntime({
        sessionId: `q03-${invalidationKind}`,
        mode: "agent",
        provider: provider(),
        thinkingLevel: "off",
        history: [],
        backgroundCompaction: true,
        projectPath: mkdtempSync(join(tmpdir(), "mc-q03-")),
        commandShell: { id: "bash", label: "Bash", dialect: "posix", available: true, isDefault: true },
        host: {
          call: async <T>(method: string, params?: unknown): Promise<T> => {
            if (method === "session.appendCompaction") return { ok: true } as T;
            if (method !== "tools.execute") return undefined as T;
            const cmd = (params as { args: { command: string } }).args.command;
            let gatedThisCall = false;
            if (summaryHasStarted && !gatedOnce) {
              gatedOnce = true;
              gatedThisCall = true;
              await thresholdGate;
            }
            const charLen = gatedThisCall ? 24_000 : 4_400;
            return { ok: true, content: `out-${cmd}\n`.padEnd(charLen, "z") } as T;
          },
        },
        onEvent: () => {},
        onDiagnostic: (d) => diagnostics.push(d),
      });

      try {
        const promptDone = runtime.prompt("climb to threshold", "u1", "t1");
        await summaryStarted;

        if (invalidationKind === "model_changed") {
          const bridge = (runtime as unknown as {
            createExtensionBridge: () => { setThinkingLevel: (level: string) => void };
          }).createExtensionBridge();
          bridge.setThinkingLevel("medium");
        } else {
          const internal = runtime as unknown as {
            fullEntries: Array<{ id: string }>;
            preparedSummary?: { boundaryId: string };
          };
          const targetId = internal.preparedSummary?.boundaryId;
          const idx = internal.fullEntries.findIndex((entry) => entry.id === targetId);
          if (idx >= 0) internal.fullEntries.splice(idx, 1);
        }

        releaseThresholdTool();
        await promptDone;

        const stages = diagnostics
          .filter((d) => d.kind === "background_compaction")
          .map((d) => `${d.data.stage}:${d.data.reason ?? ""}`);
        expect(stages).toContain(`discarded:${invalidationKind}`);
        expect(stages).not.toContain("installed:");
        expect(summaryCount).toBe(2);
      } finally {
        releaseThresholdTool();
        await runtime.dispose();
      }
    }
  });

  it("Q04: keeps usage anchors consistent across pruning, background install, and restart", async () => {
    let step = 0;
    let promptIdx = 0;
    let holdSummary = true;
    let releaseSummary!: () => void;
    const summaryReleased = new Promise<void>((resolve) => { releaseSummary = resolve; });

    vi.stubGlobal("fetch", async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as Payload;
      if (!body.tools || body.tools.length === 0 || JSON.stringify(body.messages).includes(CACHE_SHARED_SUMMARY_MARKER)) {
        if (holdSummary) await summaryReleased;
        return sseResponse({ role: "assistant", content: "Q04-SUMMARY" }, "stop");
      }
      const text = JSON.stringify(body.messages);
      if (text.includes("Q04-SUMMARY")) {
        return sseResponse(
          { role: "assistant", content: "Installed fine." },
          "stop",
          { prompt_tokens: 8_000, completion_tokens: 20, total_tokens: 8_020 },
        );
      }
      step += 1;
      // hardLimit = 47,616; 80% = 38,092; 90% = 42,854.
      // Report 38,500 on steps 2..3 so background summary starts inside [80%, 90%),
      // then report 43,500 once background summary is done to install it.
      const reportedPrompt = step === 1 ? 15_000 : step <= 3 ? 38_500 : 43_500;
      return sseResponse(
        {
          role: "assistant",
          tool_calls: [
            {
              index: 0,
              id: randomUUID(),
              type: "function",
              function: { name: "Bash", arguments: JSON.stringify({ command: `u-${step}` }) },
            },
          ],
        },
        "tool_calls",
        { prompt_tokens: reportedPrompt, completion_tokens: 20, total_tokens: reportedPrompt + 20 },
      );
    });

    const recorder = createTranscriptRecorder([
      { id: "u1", role: "user", content: "start", createdAt: new Date(1).toISOString() },
    ]);
    const checkpoints: ContextCompactionRecord[] = [];
    const diagnostics: AgentRuntimeDiagnostic[] = [];
    const dir = mkdtempSync(join(tmpdir(), "mc-q04-"));

    const runtime = new DesktopAgentRuntime({
      sessionId: "q04-session",
      mode: "agent",
      provider: provider(),
      thinkingLevel: "off",
      history: [...recorder.rows],
      backgroundCompaction: true,
      projectPath: dir,
      commandShell: { id: "bash", label: "Bash", dialect: "posix", available: true, isDefault: true },
      host: {
        call: async <T>(method: string, params?: unknown): Promise<T> => {
          if (method === "session.appendCompaction") {
            checkpoints.push((params as { compaction: ContextCompactionRecord }).compaction);
            return { ok: true } as T;
          }
          if (method === "session.appendMessage") {
            recorder.upsert((params as { message: UiMessage }).message);
            return undefined as T;
          }
          if (method !== "tools.execute") return undefined as T;
          const cmd = (params as { args: { command: string } }).args.command;
          return { ok: true, content: `out-${cmd}\n`.padEnd(4_400, "k") } as T;
        },
      },
      onEvent: (envelope) => recorder.recordEvent(envelope),
      onDiagnostic: (d) => diagnostics.push(d),
    });

    try {
      const done = runtime.prompt("start", "u1", "t1");
      await vi.waitFor(
        () => expect(diagnostics.some((d) => d.kind === "background_compaction" && d.data.stage === "started")).toBe(true),
        { timeout: 10_000 },
      );
      holdSummary = false;
      releaseSummary();
      await done;
      expect(checkpoints).toHaveLength(1);
      expect((checkpoints[0]!.details as Record<string, unknown>)?.usageStaleBefore).toEqual(expect.any(Number));
    } finally {
      releaseSummary();
      await runtime.dispose();
    }

    const restartedRequests: Payload[] = [];
    const restartedErrors: string[] = [];
    vi.stubGlobal("fetch", async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as Payload;
      restartedRequests.push(body);
      promptIdx += 1;
      return sseResponse({ role: "assistant", content: `ok-${promptIdx}` }, "stop");
    });

    const restarted = new DesktopAgentRuntime({
      sessionId: "q04-session",
      mode: "agent",
      provider: provider(),
      thinkingLevel: "off",
      history: recorder.rows,
      compactions: checkpoints,
      compactionSettings: { enabled: false, reserveTokens: 4_096, keepRecentTokens: 8_000 },
      projectPath: dir,
      commandShell: { id: "bash", label: "Bash", dialect: "posix", available: true, isDefault: true },
      host: { call: async <T>() => undefined as T },
      onEvent: (e) => {
        if (e.event.type === "error") restartedErrors.push(e.event.error.code);
      },
    });

    try {
      await restarted.prompt("small follow-up", "u2", "t2");
      expect(restartedRequests).toHaveLength(1);
      expect(restartedErrors).toEqual([]);

      await restarted.prompt("overflow ".repeat(24_000), "u3", "t3");
      expect(restartedRequests).toHaveLength(1);
      expect(restartedErrors).toEqual(["CONTEXT_TOO_LARGE"]);
    } finally {
      await restarted.dispose();
    }
  });
});
