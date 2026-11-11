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
  REPEATED_TOOL_CALL_ERROR_CODE,
  RepeatedToolCallTracker,
  toolCallFingerprint,
} from "./mc-repeated-tool-calls.js";
import { DesktopAgentRuntime, type RuntimeProviderConfig } from "./runtime.js";

// mc-agent (#118): a model repeating one call with one result.

describe("RepeatedToolCallTracker", () => {
  it("warns on the third identical call-and-result and stops on the fifth", () => {
    const tracker = new RepeatedToolCallTracker();
    const actions = [1, 2, 3, 4, 5].map(() => tracker.note("Read", { path: "a.txt" }, "same").action);
    expect(actions).toEqual(["none", "none", "warn", "warn", "stop"]);
  });

  it("treats a different call, different arguments or a different result as progress", () => {
    const tracker = new RepeatedToolCallTracker();
    tracker.note("Bash", { command: "gh pr checks" }, "pending");
    tracker.note("Bash", { command: "gh pr checks" }, "pending");
    // The check changed state: polling is working.
    expect(tracker.note("Bash", { command: "gh pr checks" }, "passed")).toEqual({ action: "none", count: 1 });
    tracker.note("Read", { path: "a.txt" }, "x");
    tracker.note("Read", { path: "a.txt" }, "x");
    expect(tracker.note("Read", { path: "b.txt" }, "x").count).toBe(1);
    tracker.note("Read", { path: "b.txt" }, "x");
    expect(tracker.note("Grep", { pattern: "x" }, "x").count).toBe(1);
  });

  it("ignores argument key order and never counts tools meant for waiting", () => {
    expect(toolCallFingerprint("Read", { path: "a", offset: 1 })).toBe(toolCallFingerprint("Read", { offset: 1, path: "a" }));
    const tracker = new RepeatedToolCallTracker();
    for (let index = 0; index < 8; index++) {
      expect(tracker.note("TaskWait", { ids: ["d1"] }, "still running").action).toBe("none");
    }
    // A waiting call in between also breaks a streak of something else.
    tracker.note("Read", { path: "a" }, "x");
    tracker.note("Read", { path: "a" }, "x");
    tracker.note("BashOutput", { backgroundId: "b1" }, "");
    expect(tracker.note("Read", { path: "a" }, "x").count).toBe(1);
  });

  it("starts over after reset", () => {
    const tracker = new RepeatedToolCallTracker();
    for (let index = 0; index < 4; index++) tracker.note("Read", { path: "a" }, "x");
    tracker.reset();
    expect(tracker.note("Read", { path: "a" }, "x")).toEqual({ action: "none", count: 1 });
  });
});

function provider(): RuntimeProviderConfig {
  const model = Object.values(DEEPSEEK_MODELS).find((item) => item.id === "deepseek-flash")!;
  return { id: "repeat-fixture", name: "Flash", modelId: model.id, baseUrl: model.baseUrl,
    apiKey: "fixture", authKind: "api_key", supportsReasoning: false, supportedThinkingLevels: ["off"],
    modelConfig: modelConfigFromPi(model) };
}

type Payload = { messages: { role: string; content?: unknown }[] };
/** A model that asks for the same Read on every request, up to `calls` times. */
async function loopingModel(calls: number) {
  const requests: Payload[] = [];
  const fetch = globalThis.fetch;
  let served = 0;
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    requests.push(JSON.parse(Buffer.concat(chunks).toString()));
    const call = served++ < calls;
    const delta = call
      ? { role: "assistant", tool_calls: [{ index: 0, id: randomUUID(), type: "function", function: { name: "Read", arguments: JSON.stringify({ path: "missing.txt" }) } }] }
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

function runtime(content: () => string) {
  const events: AgentEventEnvelope["event"][] = [];
  const rows: UiMessage[] = [];
  let executed = 0;
  const agent = new DesktopAgentRuntime({
    sessionId: "repeat", mode: "agent", provider: provider(), thinkingLevel: "off", history: rows,
    projectPath: mkdtempSync(join(tmpdir(), "mc-repeat-")),
    commandShell: { id: "bash", label: "Bash", dialect: "posix", available: true, isDefault: true },
    host: { call: async <T>(method: string): Promise<T> => {
      if (method !== "tools.execute") return undefined as T;
      executed += 1;
      return { ok: false, content: content(), errorCode: "ENOENT" } as T;
    } },
    onEvent: (envelope) => { events.push(envelope.event); },
  });
  return { agent, events, executed: () => executed };
}

const toolTexts = (request: Payload) => request.messages
  .filter((message) => message.role === "tool").map((message) => JSON.stringify(message.content));

afterEach(() => vi.unstubAllGlobals());

describe("repeated tool calls in the runtime", () => {
  it("reminds the model on the third repeat and ends the run on the fifth with a retriable error", async () => {
    const model = await loopingModel(20);
    const { agent, events, executed } = runtime(() => "ENOENT: missing.txt does not exist");
    try {
      await agent.prompt("read it", "u1", "t1");
      expect(executed()).toBe(5);
      // Five requests produced the five calls; no sixth request was sent.
      expect(model.requests).toHaveLength(5);
      const afterTwo = toolTexts(model.requests[2]!);
      expect(afterTwo.some((text) => text.includes("<repeated_tool_call>"))).toBe(false);
      const afterThree = toolTexts(model.requests[3]!);
      expect(afterThree[2]).toContain("ENOENT: missing.txt does not exist");
      expect(afterThree[2]).toContain("<repeated_tool_call>");
      expect(afterThree[2]).toContain("3rd consecutive Read call");
      const errors = events.filter((event) => event.type === "error");
      expect(errors).toHaveLength(1);
      expect(errors[0]).toMatchObject({ error: { code: REPEATED_TOOL_CALL_ERROR_CODE, retriable: true, details: { toolName: "Read", count: 5 } } });
      // The run still closes with its normal end events, after the error row.
      expect(events.filter((event) => event.type === "agent_end")).toHaveLength(1);
      expect(events.findIndex((event) => event.type === "error")).toBeLessThan(events.findIndex((event) => event.type === "agent_end"));
    } finally { await agent.dispose(); await model.close(); }
  });

  it("lets the same call run on while its result keeps changing", async () => {
    const model = await loopingModel(7);
    let tick = 0;
    const { agent, events, executed } = runtime(() => `attempt ${tick++}`);
    try {
      await agent.prompt("poll it", "u1", "t1");
      expect(executed()).toBe(7);
      expect(model.requests).toHaveLength(8);
      expect(toolTexts(model.requests.at(-1)!).some((text) => text.includes("<repeated_tool_call>"))).toBe(false);
      expect(events.some((event) => event.type === "error")).toBe(false);
    } finally { await agent.dispose(); await model.close(); }
  });

  it("starts counting again with the next prompt", async () => {
    const model = await loopingModel(4);
    const { agent, events } = runtime(() => "same");
    try {
      await agent.prompt("first", "u1", "t1");
      await agent.prompt("second", "u2", "t2");
      // Four repeats in the first prompt warned but did not stop; the second
      // prompt made no calls, and nothing carried over to end it.
      expect(events.some((event) => event.type === "error")).toBe(false);
      expect(events.filter((event) => event.type === "agent_end")).toHaveLength(2);
    } finally { await agent.dispose(); await model.close(); }
  });
});
