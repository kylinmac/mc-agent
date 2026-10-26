import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { DEEPSEEK_MODELS } from "@earendil-works/pi-ai/providers/deepseek.models";
import type { SubagentDefinition } from "@pi-desktop/shared";
import { forkableParentMessages } from "./mc-subagent-fork.js";
import { modelConfigFromPi } from "./model-capabilities.js";
import { DesktopAgentRuntime, type RuntimeProviderConfig } from "./runtime.js";

// mc-agent (MC-ADR-0022): forked subagents start from the parent's context.

const user = (text: string) => ({ role: "user", content: [{ type: "text", text }], timestamp: 1 }) as AgentMessage;
const assistant = (content: unknown[]) => ({ role: "assistant", content, timestamp: 2 }) as unknown as AgentMessage;
const result = (id: string) => ({ role: "toolResult", toolCallId: id, toolName: "Read", content: [], isError: false, timestamp: 3 }) as unknown as AgentMessage;

describe("forkable parent messages", () => {
  it("cuts the in-flight tool calls at the end and keeps settled ones", () => {
    const settled = [user("hi"), assistant([{ type: "toolCall", id: "a", name: "Read", arguments: {} }]), result("a"), assistant([{ type: "text", text: "read it" }])];
    const inFlight = assistant([{ type: "text", text: "delegating" }, { type: "toolCall", id: "t", name: "Task", arguments: {} }, { type: "toolCall", id: "r", name: "Read", arguments: {} }]);
    expect(forkableParentMessages([...settled, user("next"), inFlight, result("r")])).toEqual([...settled, user("next")]);
    expect(forkableParentMessages(settled)).toEqual(settled);
  });

  it("drops runtime-internal entries", () => {
    const internal = { role: "compactionSummary", summary: "x", timestamp: 0 } as unknown as AgentMessage;
    expect(forkableParentMessages([internal, user("hi")])).toEqual([user("hi")]);
  });
});

function provider(): RuntimeProviderConfig {
  const model = Object.values(DEEPSEEK_MODELS).find((item) => item.id === "deepseek-flash")!;
  return { id: "fork-fixture", name: "Flash", modelId: model.id, baseUrl: model.baseUrl,
    apiKey: "fixture", authKind: "api_key", supportsReasoning: false, supportedThinkingLevels: ["off"],
    modelConfig: modelConfigFromPi(model) };
}

const explorer: SubagentDefinition = {
  name: "explorer", description: "Look things up.", tools: ["Read"], prompt: "Report findings.", source: "builtin",
};

afterEach(() => vi.unstubAllGlobals());

describe("Task with fork", () => {
  it.each([true, false])("the delegate sees the parent conversation only when forked (fork=%s)", async (fork) => {
    const delegateRequests: string[] = [];
    const fetch = globalThis.fetch;
    const server = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const body = Buffer.concat(chunks).toString();
      const payload = JSON.parse(body) as { messages: Array<{ role: string }> };
      const isDelegate = body.includes("Report findings.");
      const firstParentRequest = !isDelegate && !payload.messages.some((message) => message.role === "tool");
      let delta: Record<string, unknown>;
      if (isDelegate) {
        delegateRequests.push(body);
        delta = { role: "assistant", content: "found it" };
      } else if (firstParentRequest) {
        delta = { role: "assistant", tool_calls: [{ index: 0, id: randomUUID(), type: "function", function: { name: "Task", arguments: JSON.stringify({ agent: "explorer", task: "Look up the codeword's origin.", ...(fork ? { fork: true } : {}) }) } }] };
      } else {
        delta = { role: "assistant", content: "Done." };
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: delta.tool_calls ? "tool_calls" : "stop" }] })}\n\ndata: [DONE]\n\n`);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing HTTP address");
    vi.stubGlobal("fetch", ((_url, init) => fetch(`http://127.0.0.1:${address.port}`, init)) satisfies typeof fetch);
    const agent = new DesktopAgentRuntime({
      sessionId: "fork", mode: "agent", provider: provider(), thinkingLevel: "off", history: [], subagents: [explorer],
      commandShell: { id: "bash", label: "Bash", dialect: "posix", available: true, isDefault: true },
      host: { call: async <T>(): Promise<T> => undefined as T },
      onEvent: () => {},
    });
    try {
      await agent.prompt("The codeword is PELICAN. Find out where it comes from.", "u1", "t1");
      expect(delegateRequests.length).toBeGreaterThan(0);
      const first = delegateRequests[0];
      expect(first.includes("PELICAN")).toBe(fork);
      expect(first.includes("You are a fork of the conversation above")).toBe(fork);
      expect(first).toContain("Look up the codeword's origin.");
    } finally {
      await agent.dispose();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
