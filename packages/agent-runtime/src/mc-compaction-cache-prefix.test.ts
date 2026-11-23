import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zstdDecompressSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEEPSEEK_MODELS } from "@earendil-works/pi-ai/providers/deepseek.models";
import { OPENAI_CODEX_MODELS } from "@earendil-works/pi-ai/providers/openai-codex.models";
import type { AgentEventEnvelope, ContextCompactionRecord } from "@pi-desktop/shared";
import { modelConfigFromPi } from "./model-capabilities.js";
import {
  buildCacheSharedSummaryContext,
  CACHE_SHARED_SUMMARY_MARKER,
  supportsCacheSharedCompaction,
} from "./mc-compaction-cache-prefix.js";
import { buildProviderModel } from "./provider-binding.js";
import {
  DesktopAgentRuntime,
  type AgentRuntimeDiagnostic,
  type RuntimeProviderConfig,
} from "./runtime.js";

// mc-agent (#122 / R21.3): cache-sharing compaction summary requests and Claude Code
// wD7-style automatic fallback to standalone serialized compaction.

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function codexJwt(): string {
  const claims = { "https://api.openai.com/auth": { chatgpt_account_id: "acct_fixture" } };
  return `hdr.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.sig`;
}

function codexProvider(contextWindow = 64_000, maxTokens = 4_096): RuntimeProviderConfig {
  const model = Object.values(OPENAI_CODEX_MODELS).find((item) => item.id === "gpt-6.1-sol")!;
  return {
    id: "r21-codex",
    name: "Codex",
    modelId: model.id,
    baseUrl: "http://codex.invalid",
    apiKey: codexJwt(),
    authKind: "oauth",
    apiStyle: "openai_codex_responses",
    supportsReasoning: false,
    supportedThinkingLevels: ["off"],
    modelConfig: {
      ...modelConfigFromPi(model),
      contextWindow,
      maxTokens,
      catalogContextWindow: contextWindow,
      limit: { context: contextWindow, output: maxTokens },
      reasoning: false,
      supportedThinkingLevels: ["off"],
    },
  };
}

function completionsProvider(
  contextWindow = 64_000,
  maxTokens = 4_096,
  baseUrl = "https://api.deepseek.com/v1",
): RuntimeProviderConfig {
  const model = Object.values(DEEPSEEK_MODELS).find((item) => item.id === "deepseek-flash")!;
  return {
    id: "r21-completions",
    name: "Flash",
    modelId: model.id,
    baseUrl,
    apiKey: "fixture",
    apiStyle: "chat_completions",
    supportsReasoning: false,
    supportedThinkingLevels: ["off"],
    modelConfig: { ...modelConfigFromPi(model), contextWindow, maxTokens },
  };
}

function codexSseText(text: string, usage?: Record<string, unknown>): Response {
  const item = {
    type: "message",
    id: `msg_${randomUUID()}`,
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text }],
  };
  const body =
    `event: response.output_item.done\ndata: ${JSON.stringify({ type: "response.output_item.done", output_index: 0, item })}\n\n` +
    `event: response.completed\ndata: ${JSON.stringify({
      type: "response.completed",
      response: { id: `resp_${randomUUID()}`, status: "completed", output: [item], ...(usage ? { usage } : {}) },
    })}\n\n`;
  return new Response(body, { headers: { "content-type": "text/event-stream" } });
}

function chatSse(delta: unknown, finish: string, usage?: Record<string, unknown>): Response {
  const chunk = (value: unknown, reason: string | null, u?: Record<string, unknown>) =>
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

const commandShell = {
  id: "bash" as const,
  label: "Bash",
  dialect: "posix" as const,
  available: true,
  isDefault: true,
};

afterEach(() => {
  vi.unstubAllGlobals();
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe("R21.3 / #122: cache-sharing compaction summary with automatic fallback", () => {
  it("openai-codex-responses reuses exact instructions, tools, and prefix via SSE with sticky sessionId and reports cacheRead", async () => {
    const sessionId = `codex-cache-${randomUUID()}`;
    const dir = makeTempDir("mc-r213-codex-");
    const diagnostics: AgentRuntimeDiagnostic[] = [];
    const checkpoints: ContextCompactionRecord[] = [];
    const capturedTurns: Array<{ headers: Record<string, string>; body: Record<string, unknown> }> = [];
    const capturedSummaries: Array<{ headers: Record<string, string>; body: Record<string, unknown> }> = [];
    let step = 0;

    vi.stubGlobal("WebSocket", undefined);
    vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
      const request = new Request(input, init);
      const raw = Buffer.from(await request.arrayBuffer());
      const decoded = request.headers.get("content-encoding") === "zstd" ? zstdDecompressSync(raw) : raw;
      const body = JSON.parse(decoded.toString("utf8")) as Record<string, unknown>;
      const headers = Object.fromEntries(request.headers.entries());

      const inputSerialized = JSON.stringify(body.input ?? []);
      if (inputSerialized.includes(CACHE_SHARED_SUMMARY_MARKER) || String(body.instructions ?? "").includes("context summarization assistant")) {
        capturedSummaries.push({ headers, body });
        return codexSseText("CODEX-SHARED-HANDOFF", {
          input_tokens: 44_000,
          input_tokens_details: { cached_tokens: 39_600 },
          output_tokens: 180,
          total_tokens: 44_180,
        });
      }

      capturedTurns.push({ headers, body });
      if (inputSerialized.includes("CODEX-SHARED-HANDOFF")) {
        return codexSseText("Continued after cache-shared summary.");
      }
      step += 1;
      if (step > 8) throw new Error("Exceeded expected turns in codex cache test");
      const usage = step >= 3
        ? { input_tokens: 44_000, input_tokens_details: { cached_tokens: 30_000 }, output_tokens: 50, total_tokens: 44_050 }
        : { input_tokens: 10_000, output_tokens: 50, total_tokens: 10_050 };
      return new Response(
        `event: response.output_item.done\ndata: ${JSON.stringify({
          type: "response.output_item.done",
          output_index: 0,
          item: { type: "function_call", id: `fc_${step}`, call_id: `call_codex_${step}`, name: "Bash", arguments: JSON.stringify({ command: `step-${step}` }) },
        })}\n\n` +
        `event: response.completed\ndata: ${JSON.stringify({
          type: "response.completed",
          response: { id: `resp_${step}`, status: "completed", output: [{ type: "function_call", id: `fc_${step}`, call_id: `call_codex_${step}`, name: "Bash", arguments: JSON.stringify({ command: `step-${step}` }) }], usage },
        })}\n\n`,
        { headers: { "content-type": "text/event-stream" } },
      );
    });

    const runtime = new DesktopAgentRuntime({
      sessionId,
      mode: "agent",
      projectPath: dir,
      provider: codexProvider(),
      thinkingLevel: "off",
      commandShell,
      host: {
        call: async <T>(method: string, params?: unknown): Promise<T> => {
          if (method === "session.appendCompaction") {
            checkpoints.push((params as { compaction: ContextCompactionRecord }).compaction);
            return { ok: true } as T;
          }
          if (method === "tools.execute") {
            const cmd = (params as { args: { command: string } }).args.command;
            return { ok: true, content: `out-${cmd}\n`.padEnd(4_400, "x") } as T;
          }
          return undefined as T;
        },
      },
      onEvent: () => {},
      onDiagnostic: (d) => diagnostics.push(d),
    });

    try {
      await runtime.prompt("finish codex task");
    } finally {
      await runtime.dispose();
    }

    expect(checkpoints).toHaveLength(1);
    expect(capturedSummaries).toHaveLength(1);
    const summaryReq = capturedSummaries[0]!;
    const turnBeforeCompaction = capturedTurns.at(-2)!;

    expect(summaryReq.headers["session-id"]).toBe(sessionId);
    expect(summaryReq.headers["session-id"]).toBe(turnBeforeCompaction.headers["session-id"]);
    expect(summaryReq.body.prompt_cache_key).toBe(sessionId);
    expect(summaryReq.body.instructions).toBe(turnBeforeCompaction.body.instructions);
    expect(summaryReq.body.tools).toEqual(turnBeforeCompaction.body.tools);

    const summaryInput = summaryReq.body.input as unknown[];
    const prevInput = turnBeforeCompaction.body.input as unknown[];
    expect(summaryInput.length).toBeGreaterThan(prevInput.length);
    expect(summaryInput.slice(0, prevInput.length)).toEqual(prevInput);
    expect(JSON.stringify(summaryInput.at(-1))).toContain(CACHE_SHARED_SUMMARY_MARKER);

    const summaryDiag = diagnostics.find((d) => d.kind === "compaction_summary");
    expect(summaryDiag?.data).toMatchObject({
      api: "openai-codex-responses",
      cacheShared: true,
      cacheRead: 39_600,
    });
  });

  it("falls back to standalone summary without executing tools when model emits a tool call or empty text", async () => {
    for (const badReply of ["tool_call", "empty_text"] as const) {
      const dir = makeTempDir(`mc-r213-fb-${badReply}-`);
      const diagnostics: AgentRuntimeDiagnostic[] = [];
      const checkpoints: ContextCompactionRecord[] = [];
      const summaryRequests: Array<Record<string, unknown>> = [];
      const executedCommands: string[] = [];
      let step = 0;

      vi.stubGlobal("fetch", async (_url: unknown, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
        const messages = (body.messages ?? []) as Array<{ role: string; content?: unknown }>;
        const systemText = JSON.stringify(messages.find((m) => m.role === "system") ?? "");
        const lastMsgText = JSON.stringify(messages.at(-1) ?? "");

        if (lastMsgText.includes(CACHE_SHARED_SUMMARY_MARKER)) {
          summaryRequests.push(body);
          if (badReply === "tool_call") {
            return chatSse({
              role: "assistant",
              tool_calls: [{ index: 0, id: "rogue_tool", type: "function", function: { name: "Bash", arguments: '{"command":"rm -rf"}' } }],
            }, "tool_calls");
          }
          return chatSse({ role: "assistant", content: "   " }, "stop");
        }
        if (systemText.includes("context summarization assistant") || !Array.isArray(body.tools) || body.tools.length === 0) {
          summaryRequests.push(body);
          return chatSse({ role: "assistant", content: `STANDALONE-FALLBACK-${badReply}` }, "stop");
        }

        if (JSON.stringify(messages).includes(`STANDALONE-FALLBACK-${badReply}`)) {
          return chatSse({ role: "assistant", content: "Recovered cleanly." }, "stop");
        }
        step += 1;
        return chatSse({
          role: "assistant",
          tool_calls: [{ index: 0, id: `call_${step}`, type: "function", function: { name: "Bash", arguments: JSON.stringify({ command: `step-${step}` }) } }],
        }, "tool_calls");
      });

      const runtime = new DesktopAgentRuntime({
        sessionId: `fb-${badReply}-${randomUUID()}`,
        mode: "agent",
        projectPath: dir,
        provider: completionsProvider(),
        thinkingLevel: "off",
        commandShell,
        host: {
          call: async <T>(method: string, params?: unknown): Promise<T> => {
            if (method === "session.appendCompaction") {
              checkpoints.push((params as { compaction: ContextCompactionRecord }).compaction);
              return { ok: true } as T;
            }
            if (method === "tools.execute") {
              const cmd = (params as { args: { command: string } }).args.command;
              executedCommands.push(cmd);
              return { ok: true, content: `ok-${cmd}\n`.padEnd(20_000, "z") } as T;
            }
            return undefined as T;
          },
        },
        onEvent: () => {},
        onDiagnostic: (d) => diagnostics.push(d),
      });

      try {
        await runtime.prompt("test fallback");
      } finally {
        await runtime.dispose();
      }

      expect(executedCommands).not.toContain("rm -rf");
      expect(checkpoints).toHaveLength(1);
      expect(checkpoints[0]!.summary).toContain(`STANDALONE-FALLBACK-${badReply}`);
      expect(summaryRequests).toHaveLength(2);
      expect(Array.isArray(summaryRequests[0]!.tools) && summaryRequests[0]!.tools.length > 0).toBe(true);
      expect(summaryRequests[1]!.tools).toBeUndefined();

      const sumDiags = diagnostics.filter((d) => d.kind === "compaction_summary").map((d) => d.data.cacheShared);
      expect(sumDiags).toEqual([true, false]);
    }
  });

  it("stops immediately with zero standalone fallback requests when aborted during cache-shared summary", async () => {
    const dir = makeTempDir("mc-r213-abort-");
    const events: AgentEventEnvelope[] = [];
    const summaryRequests: Array<Record<string, unknown>> = [];
    let step = 0;
    let markSummaryStarted!: () => void;
    const summaryStarted = new Promise<void>((resolve) => {
      markSummaryStarted = resolve;
    });

    vi.stubGlobal("fetch", async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      const messages = (body.messages ?? []) as Array<{ role: string; content?: unknown }>;
      const systemText = JSON.stringify(messages.find((m) => m.role === "system") ?? "");
      const lastMsgText = JSON.stringify(messages.at(-1) ?? "");

      if (lastMsgText.includes(CACHE_SHARED_SUMMARY_MARKER) || systemText.includes("context summarization assistant")) {
        summaryRequests.push(body);
        if (summaryRequests.length === 1) markSummaryStarted();
        return await new Promise<Response>((_resolve, reject) => {
          const onAbort = () => reject(new DOMException("Aborted", "AbortError"));
          if (init?.signal?.aborted) onAbort();
          else init?.signal?.addEventListener("abort", onAbort, { once: true });
        });
      }

      step += 1;
      return chatSse({
        role: "assistant",
        tool_calls: [{ index: 0, id: `abort_${step}`, type: "function", function: { name: "Bash", arguments: JSON.stringify({ command: `step-${step}` }) } }],
      }, "tool_calls");
    });

    const runtime = new DesktopAgentRuntime({
      sessionId: `abort-${randomUUID()}`,
      mode: "agent",
      projectPath: dir,
      provider: completionsProvider(),
      thinkingLevel: "off",
      commandShell,
      host: {
        call: async <T>(method: string, params?: unknown): Promise<T> => {
          if (method === "tools.execute") {
            const cmd = (params as { args: { command: string } }).args.command;
            return { ok: true, content: `ok-${cmd}\n`.padEnd(20_000, "a") } as T;
          }
          return undefined as T;
        },
      },
      onEvent: (envelope) => events.push(envelope),
    });

    try {
      const done = runtime.prompt("abort during cache summary");
      await summaryStarted;
      await runtime.abort();
      await done;
      expect(summaryRequests).toHaveLength(1);
      expect(events.filter((e) => e.event.type === "agent_end")).toHaveLength(1);
    } finally {
      await runtime.dispose();
    }
  });

  it("preflight skips cache-shared summary when prefix + output exceeds model contextWindow", async () => {
    const prov = completionsProvider(1_000, 400);
    const model = buildProviderModel(prov);
    const fit = buildCacheSharedSummaryContext({
      model,
      prefix: {
        sessionId: "s-fit",
        context: {
          systemPrompt: "short",
          messages: [{ role: "user", content: "hello", timestamp: 1 }],
        },
      },
      maxTokens: 200,
      summaryInstruction: "summarize",
    });
    expect(fit).toBeDefined();

    const oversized = buildCacheSharedSummaryContext({
      model,
      prefix: {
        sessionId: "s-overflow",
        context: {
          systemPrompt: "short",
          messages: [{ role: "user", content: "w".repeat(3_600), timestamp: 1 }],
        },
      },
      maxTokens: 200,
      summaryInstruction: "summarize",
    });
    expect(oversized).toBeUndefined();
  });

  it("skips cache-shared summary on non-whitelisted openai-completions hosts and deduplicates prior summaries (#151)", async () => {
    expect(supportsCacheSharedCompaction({ api: "openai-codex-responses", baseUrl: "http://codex.invalid" })).toBe(true);
    expect(supportsCacheSharedCompaction({ api: "openai-responses", baseUrl: "https://api.openai.com/v1" })).toBe(true);
    expect(supportsCacheSharedCompaction({ api: "openai-completions", baseUrl: "https://api.deepseek.com/v1" })).toBe(true);
    expect(supportsCacheSharedCompaction({ api: "openai-completions", baseUrl: "https://api.x.ai/v1" })).toBe(true);
    expect(supportsCacheSharedCompaction({ api: "openai-completions", baseUrl: "https://openrouter.ai/api/v1" })).toBe(false);
    expect(supportsCacheSharedCompaction({ api: "openai-completions", baseUrl: "http://provider.invalid/v1" })).toBe(false);
    expect(supportsCacheSharedCompaction({ api: "openai-completions", baseUrl: "https://api.openai.com.evil.test/v1" })).toBe(false);
    expect(supportsCacheSharedCompaction({ api: "openai-completions", baseUrl: "https://api.openai.com:8443/v1" })).toBe(false);

    const dir = makeTempDir("mc-r213-openrouter-");
    const diagnostics: AgentRuntimeDiagnostic[] = [];
    const summaryRequests: Array<Record<string, unknown>> = [];
    let step = 0;

    vi.stubGlobal("fetch", async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      const messages = (body.messages ?? []) as Array<{ role: string; content?: unknown }>;
      const systemText = JSON.stringify(messages.find((m) => m.role === "system") ?? "");
      if (systemText.includes("context summarization assistant") || !Array.isArray(body.tools) || body.tools.length === 0) {
        summaryRequests.push(body);
        return chatSse({ role: "assistant", content: "OPENROUTER-STANDALONE-SUMMARY" }, "stop");
      }
      if (JSON.stringify(messages).includes("OPENROUTER-STANDALONE-SUMMARY")) {
        return chatSse({ role: "assistant", content: "Done after standalone." }, "stop");
      }
      step += 1;
      return chatSse({
        role: "assistant",
        tool_calls: [{ index: 0, id: `or_${step}`, type: "function", function: { name: "Bash", arguments: JSON.stringify({ command: `step-${step}` }) } }],
      }, "tool_calls");
    });

    const runtime = new DesktopAgentRuntime({
      sessionId: `or-${randomUUID()}`,
      mode: "agent",
      projectPath: dir,
      provider: completionsProvider(64_000, 4_096, "https://openrouter.ai/api/v1"),
      thinkingLevel: "off",
      commandShell,
      host: {
        call: async <T>(method: string, params?: unknown): Promise<T> => {
          if (method === "session.appendCompaction") return { ok: true } as T;
          if (method === "tools.execute") {
            const cmd = (params as { args: { command: string } }).args.command;
            return { ok: true, content: `ok-${cmd}\n`.padEnd(20_000, "r") } as T;
          }
          return undefined as T;
        },
      },
      onEvent: () => {},
      onDiagnostic: (d) => diagnostics.push(d),
    });

    try {
      await runtime.prompt("summarize on openrouter");
    } finally {
      await runtime.dispose();
    }

    expect(summaryRequests).toHaveLength(1);
    expect(summaryRequests[0]!.tools).toBeUndefined();
    expect(diagnostics.filter((d) => d.kind === "compaction_summary").map((d) => d.data.cacheShared)).toEqual([false]);
  });

  it("omits duplicate <previous-summary> block when cache-shared prefix already includes it (#151)", async () => {
    const capturedSharedBodies: string[] = [];
    const priorSummary = "UNIQUE-PRIOR-CHECKPOINT-MARKER-9482";
    const prov = completionsProvider();
    const model = buildProviderModel(prov);

    vi.stubGlobal("fetch", async (_url: unknown, init?: RequestInit) => {
      const rawBody = String(init?.body ?? "{}");
      capturedSharedBodies.push(rawBody);
      return chatSse({ role: "assistant", content: "CONSOLIDATED-SUMMARY" }, "stop");
    });

    const { compact } = await import("./pi-runtime-compaction-summary.js");
    const { createProviderModels } = await import("./provider-binding.js");
    const result = await compact(
      {
        messagesToSummarize: [{ role: "user", content: [{ type: "text", text: "follow-up" }], timestamp: 2 }],
        retainedTail: [],
        tokensBefore: 12_000,
        previousSummary: priorSummary,
        fileOps: { read: new Set(), written: new Set(), edited: new Set() },
        isSplitTurn: false,
        turnPrefixMessages: [],
        settings: { enabled: true, reserveTokens: 4_000, keepRecentTokens: 1_000 },
      },
      createProviderModels(prov, model),
      model,
      undefined,
      "off",
      undefined,
      undefined,
      undefined,
      {
        sessionId: "dup-check",
        context: {
          systemPrompt: "sys",
          messages: [
            { role: "user", content: [{ type: "text", text: `Compacted context:\n${priorSummary}` }], timestamp: 1 },
          ],
        },
      },
    );

    expect(result.ok).toBe(true);
    expect(capturedSharedBodies).toHaveLength(1);
    const occurrences = capturedSharedBodies[0]!.split(priorSummary).length - 1;
    expect(occurrences).toBe(1);
    expect(capturedSharedBodies[0]).not.toContain("</previous-summary>");
    expect(capturedSharedBodies[0]).toContain("An earlier checkpoint summary is already present");
  });
});
