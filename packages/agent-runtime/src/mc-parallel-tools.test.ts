import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEEPSEEK_MODELS } from "@earendil-works/pi-ai/providers/deepseek.models";
import type { AgentEventEnvelope, UiMessage } from "@pi-desktop/shared";
import { modelConfigFromPi } from "./model-capabilities.js";
import { PARALLEL_READ_ONLY_TOOLS, toolExecutionModeFor } from "./mc-parallel-tools.js";
import { DesktopAgentRuntime, type RuntimeProviderConfig } from "./runtime.js";

// mc-agent (#116): read-only batches through the real runtime and a scripted model.

function provider(): RuntimeProviderConfig {
  const model = Object.values(DEEPSEEK_MODELS).find((item) => item.id === "deepseek-flash")!;
  return { id: "parallel-fixture", name: "Flash", modelId: model.id, baseUrl: model.baseUrl,
    apiKey: "fixture", authKind: "api_key", supportsReasoning: false, supportedThinkingLevels: ["off"],
    modelConfig: modelConfigFromPi(model) };
}

type Call = { name: string; args: Record<string, unknown> };
type Payload = { messages: { role: string; content?: unknown; tool_call_id?: string }[] };

/** Each scripted entry is one assistant message: a batch of calls, or null for the final text. */
async function scriptedModel(batches: Array<Call[] | null>) {
  const requests: Payload[] = [];
  const ids: string[][] = [];
  const fetch = globalThis.fetch;
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    requests.push(JSON.parse(Buffer.concat(chunks).toString()));
    const batch = batches.shift() ?? null;
    const batchIds = (batch ?? []).map(() => randomUUID());
    if (batch) ids.push(batchIds);
    const delta = batch
      ? { role: "assistant", tool_calls: batch.map((call, index) => ({ index, id: batchIds[index], type: "function",
          function: { name: call.name, arguments: JSON.stringify(call.args) } })) }
      : { role: "assistant", content: "Done." };
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: batch ? "tool_calls" : "stop" }] })}\n\ndata: [DONE]\n\n`);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing HTTP address");
  vi.stubGlobal("fetch", ((_url, init) => fetch(`http://127.0.0.1:${address.port}`, init)) satisfies typeof fetch);
  return { requests, ids, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

type Gate = { toolName: string; path: string; release: (content?: string, ok?: boolean) => void };

/** A host whose tool calls stay pending until the test releases them. */
function runtime(instructions?: (path: string) => Promise<unknown>) {
  const pending: Gate[] = [];
  const started: string[] = [];
  let running = 0;
  let peak = 0;
  const waiters: Array<{ count: number; resolve: () => void }> = [];
  const events: AgentEventEnvelope["event"][] = [];
  const rows: UiMessage[] = [];
  const agent = new DesktopAgentRuntime({
    sessionId: "parallel", mode: "agent", provider: provider(), thinkingLevel: "off", history: rows,
    projectPath: mkdtempSync(join(tmpdir(), "mc-parallel-")),
    commandShell: { id: "bash", label: "Bash", dialect: "posix", available: true, isDefault: true },
    host: { call: async <T>(method: string, params?: unknown): Promise<T> => {
      if (method === "project.instructions.resolve" && instructions) {
        return instructions((params as { path: string }).path) as Promise<T>;
      }
      if (method !== "tools.execute") return undefined as T;
      const { toolName, args } = params as { toolName: string; args: { path?: string; command?: string } };
      const path = String(args.path ?? args.command ?? "");
      started.push(path);
      running += 1;
      peak = Math.max(peak, running);
      return new Promise<T>((resolve) => {
        pending.push({ toolName, path, release: (content = `content of ${path}`, ok = true) => {
          running -= 1;
          resolve({ ok, content } as T);
        } });
        for (const waiter of [...waiters]) {
          if (started.length < waiter.count) continue;
          waiters.splice(waiters.indexOf(waiter), 1);
          waiter.resolve();
        }
      });
    } },
    onEvent: (envelope) => { events.push(envelope.event); },
  });
  const startedCount = (count: number) => started.length >= count
    ? Promise.resolve()
    : new Promise<void>((resolve) => { waiters.push({ count, resolve }); });
  const release = (path: string, content?: string, ok?: boolean) => {
    const gate = pending.find((item) => item.path === path);
    if (!gate) throw new Error(`no pending call for ${path}`);
    pending.splice(pending.indexOf(gate), 1);
    gate.release(content, ok);
  };
  return { agent, started, events, startedCount, release, peak: () => peak };
}

function toolResults(request: Payload): Array<{ id?: string; text: string }> {
  return request.messages
    .filter((message) => message.role === "tool")
    .map((message) => ({ id: message.tool_call_id, text: JSON.stringify(message.content) }));
}

afterEach(() => vi.unstubAllGlobals());

describe("execution mode table", () => {
  it("marks only the subagent tool and the read-only core tools parallel", () => {
    expect([...PARALLEL_READ_ONLY_TOOLS].sort()).toEqual(["Glob", "Grep", "Read"]);
    expect(toolExecutionModeFor("Task", "Task")).toBe("parallel");
    expect(toolExecutionModeFor("Read", "Task")).toBe("parallel");
    for (const name of ["Bash", "Write", "Edit", "plugin_reader", "mcp__fs__read_file", "asktool"]) {
      expect(toolExecutionModeFor(name, "Task")).toBe("sequential");
    }
  });
});

describe("read-only tool batches in the runtime", () => {
  it("runs an all-read-only batch concurrently and returns results in call order", async () => {
    const model = await scriptedModel([
      [{ name: "Read", args: { path: "a.txt" } }, { name: "Read", args: { path: "b.txt" } }, { name: "Grep", args: { pattern: "x", path: "c" } }],
      null,
    ]);
    const { agent, started, startedCount, release, peak } = runtime();
    try {
      const done = agent.prompt("read them", "u1", "t1");
      // All three are in flight before any of them has returned.
      await startedCount(3);
      // Host start order is not call order: Read first resolves path-scoped
      // rules, Grep does not. Only the result order below is a contract.
      expect([...started].sort()).toEqual(["a.txt", "b.txt", "c"]);
      expect(peak()).toBe(3);
      // Finish out of order; the model must still see call order.
      release("c");
      release("b.txt");
      release("a.txt");
      await done;
      const results = toolResults(model.requests[1]);
      expect(results.map((result) => result.id)).toEqual(model.ids[0]);
      expect(results[0].text).toContain("content of a.txt");
      expect(results[2].text).toContain("content of c");
    } finally { await agent.dispose(); await model.close(); }
  });

  it("keeps a batch sequential as soon as it holds a command", async () => {
    const model = await scriptedModel([
      [{ name: "Read", args: { path: "a.txt" } }, { name: "Bash", args: { command: "ls" } }, { name: "Read", args: { path: "b.txt" } }],
      null,
    ]);
    const { agent, started, startedCount, release, peak } = runtime();
    try {
      const done = agent.prompt("mixed", "u1", "t1");
      await startedCount(1);
      expect(started).toEqual(["a.txt"]);
      release("a.txt");
      await startedCount(2);
      expect(started).toEqual(["a.txt", "ls"]);
      release("ls");
      await startedCount(3);
      release("b.txt");
      await done;
      expect(peak()).toBe(1);
      expect(toolResults(model.requests[1]).map((result) => result.id)).toEqual(model.ids[0]);
    } finally { await agent.dispose(); await model.close(); }
  });

  it("a failed read does not disturb the rest of its batch", async () => {
    const model = await scriptedModel([
      [{ name: "Read", args: { path: "missing.txt" } }, { name: "Read", args: { path: "b.txt" } }],
      null,
    ]);
    const { agent, startedCount, release, events } = runtime();
    try {
      const done = agent.prompt("read both", "u1", "t1");
      await startedCount(2);
      release("missing.txt", "ENOENT: no such file", false);
      release("b.txt");
      await done;
      const results = toolResults(model.requests[1]);
      expect(results[0].text).toContain("ENOENT");
      expect(results[1].text).toContain("content of b.txt");
      const ends = events.filter((event) => event.type === "tool_end");
      expect(ends.map((event) => event.type === "tool_end" && event.isError)).toEqual([true, false]);
      expect(events.filter((event) => event.type === "agent_end")).toHaveLength(1);
    } finally { await agent.dispose(); await model.close(); }
  });

  it("stopping the turn releases every read in the batch", async () => {
    const model = await scriptedModel([
      [{ name: "Read", args: { path: "a.txt" } }, { name: "Read", args: { path: "b.txt" } }],
      null,
    ]);
    const { agent, startedCount, events } = runtime();
    try {
      const done = agent.prompt("read both", "u1", "t1");
      await startedCount(2);
      await agent.abort();
      await done;
      // Neither host call was ever released: the turn must not wait on them.
      expect(events.filter((event) => event.type === "tool_end")).toHaveLength(2);
      expect(model.requests).toHaveLength(1);
    } finally { await agent.dispose(); await model.close(); }
  });

  it("leaves the last call's path-scoped rules in the prompt, whichever lookup resolves last", async () => {
    const model = await scriptedModel([
      [{ name: "Read", args: { path: "first/a.txt" } }, { name: "Read", args: { path: "second/b.txt" } }],
      null,
    ]);
    let releaseFirst: (() => void) | undefined;
    const rules = (name: string) => ({ entries: [{ source: `${name}/AGENTS.md`, content: `rules for ${name}` }] });
    const { agent, startedCount, release } = runtime((path) => path.startsWith("first/")
      // The first call's lookup resolves after the second call's.
      ? new Promise((resolve) => { releaseFirst = () => resolve(rules("first")); })
      : Promise.resolve(rules("second")));
    try {
      const done = agent.prompt("read both", "u1", "t1");
      await vi.waitFor(() => expect(releaseFirst).toBeDefined());
      releaseFirst!();
      await startedCount(2);
      release("first/a.txt");
      release("second/b.txt");
      await done;
      const prompt = agent.systemPromptView().sections.map((section) => section.text).join("\n");
      expect(prompt).toContain("rules for second");
      expect(prompt).not.toContain("rules for first");
    } finally { await agent.dispose(); await model.close(); }
  });
});
