import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { DEEPSEEK_MODELS } from "@earendil-works/pi-ai/providers/deepseek.models";
import type { AgentEventEnvelope, UiMessage } from "@pi-desktop/shared";
import { modelConfigFromPi } from "./model-capabilities.js";
import {
  applyToolResultPruning,
  isClearedToolResult,
  planToolResultPruning,
  pruningUsageCredit,
  TOOL_RESULT_PRUNE_MARKER,
} from "./mc-tool-result-pruning.js";
import { DesktopAgentRuntime, type AgentRuntimeDiagnostic, type RuntimeProviderConfig } from "./runtime.js";

// mc-agent (#117): clearing old tool results before a full summary.

const estimate = (message: AgentMessage): number =>
  Math.ceil(JSON.stringify((message as { content?: unknown }).content ?? "").length / 4);

function user(text: string, timestamp: number): AgentMessage {
  return { role: "user", content: text, timestamp } as AgentMessage;
}
function assistant(timestamp: number): AgentMessage {
  return { role: "assistant", content: [{ type: "text", text: "ok" }], timestamp } as unknown as AgentMessage;
}
function result(id: string, toolName: string, chars: number, timestamp: number): AgentMessage {
  return { role: "toolResult", toolCallId: id, toolName, isError: false, timestamp,
    content: [{ type: "text", text: `${id}:`.padEnd(chars, "x") }] } as unknown as AgentMessage;
}
const tokensOf = (messages: AgentMessage[]) => messages.reduce((sum, message) => sum + estimate(message), 0);

/** Six 10K-token results, oldest first, in a 100K budget that is 60K+ full. */
function history(): AgentMessage[] {
  const messages: AgentMessage[] = [user("go", 1)];
  for (let index = 0; index < 8; index++) {
    messages.push(assistant(10 + index * 2));
    messages.push(result(`call-${index}`, index === 2 ? "Task" : "Bash", 40_000, 11 + index * 2));
  }
  return messages;
}

describe("planToolResultPruning", () => {
  it("does nothing below the trigger", () => {
    const messages = history();
    expect(planToolResultPruning({ messages, tokens: 69_999, hardLimit: 100_000, keepRecentTokens: 20_000, estimate })).toBeUndefined();
  });

  it("clears oldest eligible results until the target, sparing the tail and non-rerunnable tools", () => {
    const messages = history();
    const tokens = tokensOf(messages);
    const plan = planToolResultPruning({ messages, tokens, hardLimit: 100_000, keepRecentTokens: 20_000, estimate })!;
    // 80K → at or below 50K needs four results; the Task report is skipped, not cleared.
    expect([...plan.cleared.keys()]).toEqual(["call-0", "call-1", "call-3", "call-4"]);
    expect(tokens - plan.savedTokens).toBeLessThanOrEqual(50_000);
    const projected = applyToolResultPruning(messages, plan.cleared);
    expect(tokensOf(projected)).toBe(tokens - plan.savedTokens);
    // Pairing is untouched: same messages, same ids, same order.
    expect(projected.map((message) => (message as { toolCallId?: string }).toolCallId))
      .toEqual(messages.map((message) => (message as { toolCallId?: string }).toolCallId));
    expect(isClearedToolResult(projected[2]!)).toBe(true);
    expect(isClearedToolResult(projected[6]!)).toBe(false);
    expect(isClearedToolResult(projected.at(-1)!)).toBe(false);
  });

  it("never clears the newest result, however large", () => {
    const messages = [user("go", 1), assistant(2), result("only", "Grep", 400_000, 3)];
    expect(planToolResultPruning({ messages, tokens: tokensOf(messages), hardLimit: 100_000, keepRecentTokens: 8_000, estimate })).toBeUndefined();
  });

  it("skips a pass that would free too little, and is idempotent after one that ran", () => {
    const small = [user("go", 1), assistant(2), result("a", "Bash", 12_000, 3), assistant(4), result("b", "Bash", 400_000, 5)];
    expect(planToolResultPruning({ messages: small, tokens: 90_000, hardLimit: 100_000, keepRecentTokens: 8_000, estimate })).toBeUndefined();

    const messages = history();
    const first = planToolResultPruning({ messages, tokens: tokensOf(messages), hardLimit: 100_000, keepRecentTokens: 20_000, estimate })!;
    const projected = applyToolResultPruning(messages, first.cleared);
    expect(planToolResultPruning({ messages: projected, tokens: tokensOf(projected), hardLimit: 100_000, keepRecentTokens: 20_000, estimate })).toBeUndefined();
    expect(applyToolResultPruning(projected, first.cleared)).toBe(projected);
  });

  it("keeps both ends of the original and says how to get it back", () => {
    const messages = history();
    const plan = planToolResultPruning({ messages, tokens: tokensOf(messages), hardLimit: 100_000, keepRecentTokens: 20_000, estimate })!;
    const cleared = applyToolResultPruning(messages, plan.cleared)[2] as unknown as { content: { text: string }[] };
    const text = cleared.content[0]!.text;
    expect(text.startsWith(TOOL_RESULT_PRUNE_MARKER)).toBe(true);
    expect(text).toContain("Bash result (about 10,0");
    expect(text).toContain("call-0:xxx");
    expect(text).toContain("characters omitted");
    expect(text).toContain("Call the tool again");
  });
});

describe("pruningUsageCredit", () => {
  it("credits results cleared since the usage anchor, and stops once a newer anchor exists", () => {
    const messages = history();
    const anchorIndex = messages.length - 2; // last assistant
    const anchorTimestamp = messages[anchorIndex]!.timestamp;
    const cleared = new Map([
      ["call-0", { savedTokens: 9_000, anchorTimestamp }],
      ["call-1", { savedTokens: 9_000, anchorTimestamp: 999 }],
      ["call-7", { savedTokens: 9_000, anchorTimestamp }],
    ]);
    // call-1 was cleared under an older anchor (already reflected in usage);
    // call-7 sits after the anchor and is estimated directly.
    expect(pruningUsageCredit(messages, anchorIndex, cleared)).toBe(9_000);
    expect(pruningUsageCredit(messages, null, cleared)).toBe(0);
    const next = [...messages, assistant(500)];
    expect(pruningUsageCredit(next, next.length - 1, cleared)).toBe(0);
  });
});

function provider(): RuntimeProviderConfig {
  const model = Object.values(DEEPSEEK_MODELS).find((item) => item.id === "deepseek-flash")!;
  return { id: "prune-fixture", name: "Flash", modelId: model.id, baseUrl: model.baseUrl,
    apiKey: "fixture", authKind: "api_key", supportsReasoning: false, supportedThinkingLevels: ["off"],
    modelConfig: { ...modelConfigFromPi(model), contextWindow: 64_000, maxTokens: 4_096 } };
}

type Payload = { messages: { role: string; content?: unknown; tool_call_id?: string }[] };
async function scriptedModel(toolTurns: number) {
  const requests: Payload[] = [];
  const fetch = globalThis.fetch;
  let served = 0;
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    requests.push(JSON.parse(Buffer.concat(chunks).toString()));
    const call = served++ < toolTurns;
    const delta = call
      ? { role: "assistant", tool_calls: [{ index: 0, id: randomUUID(), type: "function", function: { name: "Bash", arguments: JSON.stringify({ command: `step ${served}` }) } }] }
      : { role: "assistant", content: "Done." };
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: call ? "tool_calls" : "stop" }] })}\n\ndata: [DONE]\n\n`);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing HTTP address");
  vi.stubGlobal("fetch", ((_url, init) => fetch(`http://127.0.0.1:${address.port}`, init)) satisfies typeof fetch);
  return { requests, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

afterEach(() => vi.unstubAllGlobals());

describe("clearing old tool results in the runtime", () => {
  it("clears early command output instead of summarizing, and leaves the newest output whole", async () => {
    const model = await scriptedModel(7);
    const events: AgentEventEnvelope["event"][] = [];
    const diagnostics: AgentRuntimeDiagnostic[] = [];
    const rows: UiMessage[] = [];
    const agent = new DesktopAgentRuntime({
      sessionId: "prune", mode: "agent", provider: provider(), thinkingLevel: "off", history: rows,
      projectPath: mkdtempSync(join(tmpdir(), "mc-prune-")),
      commandShell: { id: "bash", label: "Bash", dialect: "posix", available: true, isDefault: true },
      host: { call: async <T>(method: string, params?: unknown): Promise<T> => {
        if (method !== "tools.execute") return undefined as T;
        const command = (params as { args: { command: string } }).args.command;
        return { ok: true, content: `${command} output\n`.padEnd(24_000, "y") } as T;
      } },
      onEvent: (envelope) => { events.push(envelope.event); },
      onDiagnostic: (diagnostic) => { diagnostics.push(diagnostic); },
    });
    try {
      await agent.prompt("run the steps", "u1", "t1");
      expect(model.requests).toHaveLength(8);
      const toolTexts = (request: Payload) => request.messages
        .filter((message) => message.role === "tool").map((message) => JSON.stringify(message.content));
      const last = toolTexts(model.requests.at(-1)!);
      expect(last).toHaveLength(7);
      expect(last[0]).toContain(TOOL_RESULT_PRUNE_MARKER);
      expect(last[0]).toContain("step 1 output");
      expect(last.at(-1)).not.toContain(TOOL_RESULT_PRUNE_MARKER);
      expect(last.at(-1)!.length).toBeGreaterThan(24_000);
      // The first request that carried step 1's output carried it whole.
      expect(toolTexts(model.requests[1]!)[0]).not.toContain(TOOL_RESULT_PRUNE_MARKER);
      // No summary was needed, and the log says what was cleared without content.
      expect(events.some((event) => event.type === "compaction_start" || event.type === "compaction_end")).toBe(false);
      const cleared = diagnostics.filter((diagnostic) => diagnostic.kind === "tool_result_pruning");
      expect(cleared.length).toBeGreaterThan(0);
      expect(Object.keys(cleared[0]!.data).sort()).toEqual(["clearedResults", "hardLimit", "savedTokens", "tokensBefore"]);
    } finally { await agent.dispose(); await model.close(); }
  });
});
