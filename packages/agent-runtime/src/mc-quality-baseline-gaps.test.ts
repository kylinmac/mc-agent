import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEEPSEEK_MODELS } from "@earendil-works/pi-ai/providers/deepseek.models";
import type { AgentEventEnvelope, UiMessage } from "@pi-desktop/shared";
import { modelConfigFromPi } from "./model-capabilities.js";
import { TOOL_RESULT_PRUNE_MARKER } from "./mc-tool-result-pruning.js";
import {
  DesktopAgentRuntime,
  type AgentRuntimeDiagnostic,
  type RuntimeProviderConfig,
} from "./runtime.js";

// mc-agent (#148 / Q01): when compaction is off, old tool results are not
// pruned, background compaction does not run, and oversized prompts fail fast.

function provider(): RuntimeProviderConfig {
  const model = Object.values(DEEPSEEK_MODELS).find((item) => item.id === "deepseek-flash")!;
  return {
    id: "q01-fixture",
    name: "Flash",
    modelId: model.id,
    baseUrl: "http://provider.invalid/v1",
    apiKey: "fixture",
    apiStyle: "chat_completions",
    supportsReasoning: false,
    supportedThinkingLevels: ["off"],
    modelConfig: { ...modelConfigFromPi(model), contextWindow: 64_000, maxTokens: 4_096 },
  };
}

type Payload = { tools?: unknown[]; messages: Array<{ role: string; content?: unknown }> };

function sseResponse(delta: unknown, finish: string): Response {
  const chunk = (value: unknown, reason: string | null) =>
    `data: ${JSON.stringify({
      id: "c1",
      object: "chat.completion.chunk",
      created: 1,
      model: "deepseek-flash",
      choices: [{ index: 0, delta: value, finish_reason: reason }],
    })}\n\n`;
  return new Response(
    chunk(delta, null) + chunk({}, finish) + "data: [DONE]\n\n",
    { headers: { "content-type": "text/event-stream" } },
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Q01: compaction disabled semantics", () => {
  it("never prunes tool results or prepares background summaries, and rejects oversized prompts with 0 requests", async () => {
    const turnRequests: Payload[] = [];
    const summaryRequests: Payload[] = [];
    let step = 0;

    vi.stubGlobal("fetch", async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as Payload;
      if (!body.tools || body.tools.length === 0) {
        summaryRequests.push(body);
        return sseResponse({ role: "assistant", content: "unexpected summary" }, "stop");
      }
      turnRequests.push(body);
      step += 1;
      if (step <= 4) {
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
      }
      return sseResponse({ role: "assistant", content: "Done." }, "stop");
    });

    const events: AgentEventEnvelope["event"][] = [];
    const diagnostics: AgentRuntimeDiagnostic[] = [];
    const history: UiMessage[] = [];
    const dir = mkdtempSync(join(tmpdir(), "mc-q01-"));
    const runtime = new DesktopAgentRuntime({
      sessionId: "q01-session",
      mode: "agent",
      provider: provider(),
      thinkingLevel: "off",
      history,
      compactionSettings: { enabled: false, reserveTokens: 4_096, keepRecentTokens: 8_000 },
      backgroundCompaction: true,
      projectPath: dir,
      commandShell: { id: "bash", label: "Bash", dialect: "posix", available: true, isDefault: true },
      host: {
        call: async <T>(method: string, params?: unknown): Promise<T> => {
          if (method === "tools.execute") {
            const cmd = (params as { args: { command: string } }).args.command;
            // ~10k tokens per output: 4 steps (~43k+ tokens) crosses both 70% and 80% safely under 60k hard limit.
            return { ok: true, content: `${cmd}-marker\n`.padEnd(40_000, "x") } as T;
          }
          return undefined as T;
        },
      },
      onEvent: (envelope) => events.push(envelope.event),
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    });

    try {
      await runtime.prompt("run steps without compaction", "u1", "t1");
      expect(turnRequests).toHaveLength(5);
      expect(summaryRequests).toHaveLength(0);
      expect(diagnostics.filter((d) => d.kind === "tool_result_pruning")).toEqual([]);
      expect(diagnostics.filter((d) => d.kind === "background_compaction")).toEqual([]);
      expect(events.some((e) => e.type === "error")).toBe(false);

      const lastToolTexts = turnRequests
        .at(-1)!
        .messages.filter((m) => m.role === "tool")
        .map((m) => JSON.stringify(m.content));
      expect(lastToolTexts).toHaveLength(4);
      for (const text of lastToolTexts) {
        expect(text).not.toContain(TOOL_RESULT_PRUNE_MARKER);
      }

      // Now exceed hardLimit with compaction disabled -> 0 new main requests and explicit CONTEXT_TOO_LARGE.
      const beforeOverflowCount = turnRequests.length;
      await runtime.prompt("oversized ".repeat(15_000), "u2", "t2");
      expect(turnRequests).toHaveLength(beforeOverflowCount);
      expect(summaryRequests).toHaveLength(0);
      const errors = events.filter((e) => e.type === "error");
      expect(errors).toHaveLength(1);
      expect(errors[0]).toMatchObject({ type: "error", error: { code: "CONTEXT_TOO_LARGE" } });
    } finally {
      await runtime.dispose();
    }
  });
});
