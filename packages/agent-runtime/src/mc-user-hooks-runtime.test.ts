import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEEPSEEK_MODELS } from "@earendil-works/pi-ai/providers/deepseek.models";
import type { McUserHook, UiMessage } from "@pi-desktop/shared";
import { modelConfigFromPi } from "./model-capabilities.js";
import { DesktopAgentRuntime, type RuntimeProviderConfig } from "./runtime.js";

// mc-agent (MC-ADR-0021): user hooks through the real runtime and a scripted model.

function provider(): RuntimeProviderConfig {
  const model = Object.values(DEEPSEEK_MODELS).find((item) => item.id === "deepseek-flash")!;
  return { id: "hooks-fixture", name: "Flash", modelId: model.id, baseUrl: model.baseUrl,
    apiKey: "fixture", authKind: "api_key", supportsReasoning: false, supportedThinkingLevels: ["off"],
    modelConfig: modelConfigFromPi(model) };
}

type Payload = { messages: { role: string; content?: unknown }[] };
async function scriptedModel(calls: Array<{ name: string; args?: Record<string, unknown> } | null>) {
  const requests: Payload[] = [];
  const fetch = globalThis.fetch;
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    requests.push(JSON.parse(Buffer.concat(chunks).toString()));
    const call = calls.shift() ?? null;
    const delta = call
      ? { role: "assistant", tool_calls: [{ index: 0, id: randomUUID(), type: "function", function: { name: call.name, arguments: JSON.stringify(call.args ?? {}) } }] }
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

function runtime(userHooks: McUserHook[], projectPath: string) {
  const executed: string[] = [];
  const rows: UiMessage[] = [];
  const agent = new DesktopAgentRuntime({
    sessionId: "hooks", mode: "agent", provider: provider(), thinkingLevel: "off", history: rows,
    projectPath, userHooks,
    commandShell: { id: "bash", label: "Bash", dialect: "posix", available: true, isDefault: true },
    host: { call: async <T>(method: string, params?: unknown): Promise<T> => {
      if (method === "tools.execute") {
        executed.push((params as { toolName: string }).toolName);
        return { ok: true, content: "Synthetic success" } as T;
      }
      return undefined as T;
    } },
    onEvent: () => {},
  });
  return { agent, executed };
}

afterEach(() => vi.unstubAllGlobals());

describe("user hooks in the runtime", () => {
  it("a PreToolUse hook that exits 2 blocks the call and tells the model why", async () => {
    const model = await scriptedModel([{ name: "Bash", args: { command: "git push -f" } }, null]);
    const dir = mkdtempSync(join(tmpdir(), "mc-hooks-rt-"));
    const { agent, executed } = runtime([{ id: "p", event: "PreToolUse", matcher: "Bash", command: "echo 'no pushes here' >&2; exit 2" }], dir);
    try {
      await agent.prompt("push it", "u1", "t1");
      expect(executed).toEqual([]);
      expect(JSON.stringify(model.requests[1].messages)).toContain("Blocked by a user-configured hook:\\nno pushes here");
    } finally { await agent.dispose(); await model.close(); }
  });

  it("a Stop hook that exits 2 sends its output back and the agent continues once more", async () => {
    const model = await scriptedModel([null, null]);
    const dir = mkdtempSync(join(tmpdir(), "mc-hooks-rt-"));
    const command = "if [ -f stopped ]; then exit 0; fi; touch stopped; echo 'run the tests first' >&2; exit 2";
    const { agent } = runtime([{ id: "s", event: "Stop", command }], dir);
    try {
      await agent.prompt("finish up", "u1", "t1");
      expect(model.requests).toHaveLength(2);
      expect(JSON.stringify(model.requests[1].messages)).toContain("run the tests first");
    } finally { await agent.dispose(); await model.close(); }
  });
});
