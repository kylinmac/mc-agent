import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEEPSEEK_MODELS } from "@earendil-works/pi-ai/providers/deepseek.models";
import type { AgentEventEnvelope, SubagentDefinition } from "@pi-desktop/shared";
import { modelConfigFromPi } from "./model-capabilities.js";
import { REPEATED_TOOL_CALL_ERROR_CODE } from "./mc-repeated-tool-calls.js";
import {
  DesktopAgentRuntime,
  type RuntimeProviderConfig,
} from "./runtime.js";

// mc-agent (#148 / Q05-Q08): real subagent convergence + repeat-call isolation,
// repeat-tracker survival across stream failures, single-execution writes across
// mid-stream retries, and late tool settlement after abort().

function provider(): RuntimeProviderConfig {
  const model = Object.values(DEEPSEEK_MODELS).find((item) => item.id === "deepseek-flash")!;
  return {
    id: "q05-fixture",
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

type PayloadMessage = {
  role: string;
  content?: unknown;
  tool_call_id?: string;
  tool_calls?: Array<{ id: string; function?: { name?: string } }>;
};

type Payload = {
  messages: PayloadMessage[];
};

function parsePayload(init?: RequestInit): Payload {
  return JSON.parse(String(init?.body ?? "{}")) as Payload;
}

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

function midStreamFailureResponse(partialText = "partial"): Response {
  const chunk = `data: ${JSON.stringify({
    id: "c1",
    object: "chat.completion.chunk",
    created: 1,
    model: "deepseek-flash",
    choices: [{ index: 0, delta: { role: "assistant", content: partialText }, finish_reason: null }],
  })}\n\n`;
  let sent = false;
  return new Response(
    new ReadableStream<Uint8Array>({
      pull(controller) {
        if (!sent) {
          sent = true;
          controller.enqueue(new TextEncoder().encode(chunk));
        } else {
          controller.error(new Error("terminated"));
        }
      },
    }),
    { headers: { "content-type": "text/event-stream" } },
  );
}

function toolCallsDelta(calls: Array<{ id: string; name: string; args: Record<string, unknown> }>) {
  return {
    role: "assistant",
    tool_calls: calls.map((call, index) => ({
      index,
      id: call.id,
      type: "function",
      function: { name: call.name, arguments: JSON.stringify(call.args) },
    })),
  };
}

function messageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => (part && typeof part === "object" && "text" in part ? String((part as { text: unknown }).text) : ""))
    .join("");
}

async function settle<T>(promise: Promise<T>): Promise<T> {
  let settled = false;
  const observed = promise.then(
    (value) => ({ value }),
    (error) => ({ error }),
  );
  void observed.then(() => {
    settled = true;
  });
  for (let tick = 0; tick < 180 && !settled; tick++) {
    await vi.advanceTimersByTimeAsync(1_000);
  }
  expect(settled, "run settles inside the bounded recovery window").toBe(true);
  const result = await observed;
  if ("error" in result) throw result.error;
  return result.value;
}

const commandShell = {
  id: "bash" as const,
  label: "Bash",
  dialect: "posix" as const,
  available: true,
  isDefault: true,
};

const subagent = (name: string, prompt: string, description: string): SubagentDefinition => ({
  name,
  description,
  prompt,
  source: "builtin",
  tools: ["Read"],
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("Q05-Q08: recovery, repeat guards, subagent convergence, and abort late settlement", () => {
  it("Q05: terminates a looping delegate with REPEATED_TOOL_CALL_LIMIT while converging with healthy sibling", async () => {
    const events: AgentEventEnvelope[] = [];
    const looperToolResults: string[] = [];
    let parentTurn = 0;
    let looperRequests = 0;
    let finisherRequests = 0;
    let taskWaitResultText = "";

    const fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const payload = parsePayload(init);
      const systemText = messageText(payload.messages.find((m) => m.role === "system")?.content);

      if (systemText.includes("SUBAGENT_LOOPER")) {
        looperRequests += 1;
        const lastTool = [...payload.messages].reverse().find((m) => m.role === "tool");
        if (lastTool) looperToolResults.push(messageText(lastTool.content));
        return sseResponse(
          toolCallsDelta([{ id: `looper_read_${looperRequests}`, name: "Read", args: { path: "stuck.txt" } }]),
          "tool_calls",
        );
      }

      if (systemText.includes("SUBAGENT_FINISHER")) {
        finisherRequests += 1;
        if (finisherRequests === 1) {
          return sseResponse(
            toolCallsDelta([{ id: "fin_read_1", name: "Read", args: { path: "ok-1.txt" } }]),
            "tool_calls",
          );
        }
        if (finisherRequests === 2) {
          return sseResponse(
            toolCallsDelta([{ id: "fin_read_2", name: "Read", args: { path: "ok-2.txt" } }]),
            "tool_calls",
          );
        }
        return sseResponse({ role: "assistant", content: "finisher-done-marker" }, "stop");
      }

      parentTurn += 1;
      if (parentTurn === 1) {
        return sseResponse(
          toolCallsDelta([
            { id: "task_looper", name: "Task", args: { agent: "looper", task: "check stuck", description: "loop check" } },
            { id: "task_finisher", name: "Task", args: { agent: "finisher", task: "check ok", description: "ok check" } },
          ]),
          "tool_calls",
        );
      }
      if (parentTurn === 2) {
        const delegationIds = payload.messages
          .filter((m) => m.role === "tool")
          .map((m) => /Delegation ([^\s]+) started:/.exec(messageText(m.content))?.[1])
          .filter((id): id is string => Boolean(id));
        expect(delegationIds).toHaveLength(2);
        return sseResponse(
          toolCallsDelta([{ id: "wait_all", name: "TaskWait", args: { delegationIds, mode: "all" } }]),
          "tool_calls",
        );
      }
      const waitTool = [...payload.messages].reverse().find((m) => m.role === "tool");
      taskWaitResultText = messageText(waitTool?.content);
      return sseResponse({ role: "assistant", content: "parent-converged" }, "stop");
    });
    vi.stubGlobal("fetch", fetch);

    const runtime = new DesktopAgentRuntime({
      sessionId: `q05-${randomUUID()}`,
      mode: "agent",
      provider: provider(),
      thinkingLevel: "off",
      commandShell,
      subagents: [
        subagent("looper", "SUBAGENT_LOOPER", "Loops on identical read"),
        subagent("finisher", "SUBAGENT_FINISHER", "Reads cleanly and finishes"),
      ],
      host: {
        async call<T>(method: string, params?: unknown): Promise<T> {
          if (method === "session.appendMessage" || method === "tools.abort") return undefined as T;
          if (method !== "tools.execute") throw new Error(`Unexpected host method: ${method}`);
          const args = (params as { args: { path?: string } }).args;
          if (args.path === "stuck.txt") return { ok: true, content: "same-bytes" } as T;
          return { ok: true, content: `contents-${args.path}` } as T;
        },
      },
      onEvent: (envelope) => events.push(envelope),
    });

    try {
      await runtime.prompt("run both delegates");
      expect(looperRequests).toBe(5);
      expect(finisherRequests).toBe(3);
      expect(looperToolResults[2]).toContain("3rd consecutive Read call");

      expect(taskWaitResultText).toContain("finisher-done-marker");
      expect(taskWaitResultText).toMatch(/## looper \([^)]+\) — failed/);

      const waitEnd = events.find(
        (e) => e.event.type === "tool_end" && e.event.toolCallId === "wait_all",
      );
      expect(waitEnd).toBeDefined();
      const delegations =
        waitEnd && waitEnd.event.type === "tool_end"
          ? ((waitEnd.event.result as { details?: { delegations?: Array<{ agent: string; status: string; error?: { code?: string }; report?: string }> } }).details?.delegations ?? [])
          : [];
      const looperSummary = delegations.find((d) => d.agent === "looper");
      const finisherSummary = delegations.find((d) => d.agent === "finisher");
      expect(looperSummary?.status).toBe("failed");
      expect(looperSummary?.error?.code).toBe(REPEATED_TOOL_CALL_ERROR_CODE);
      expect(finisherSummary?.status).toBe("completed");
      expect(finisherSummary?.report).toContain("finisher-done-marker");

      const parentErrors = events.filter((e) => e.event.type === "error");
      expect(parentErrors).toHaveLength(0);
      const finalAssistant = [...events]
        .reverse()
        .find((e) => e.event.type === "message_end" && e.event.message.role === "assistant");
      expect(finalAssistant && finalAssistant.event.type === "message_end" ? finalAssistant.event.message.content : "").toBe("parent-converged");
    } finally {
      await runtime.dispose();
    }
  });

  it("Q06: keeps RepeatedToolCallTracker state across transient mid-stream failure retries", async () => {
    vi.useFakeTimers();
    const events: AgentEventEnvelope[] = [];
    let requests = 0;
    let reads = 0;

    const fetch = vi.fn(async (): Promise<Response> => {
      requests += 1;
      if (requests <= 3) {
        return sseResponse(
          toolCallsDelta([{ id: `call_${requests}`, name: "Read", args: { path: "same.txt" } }]),
          "tool_calls",
        );
      }
      if (requests === 4) {
        return midStreamFailureResponse("partial before disconnect");
      }
      if (requests <= 6) {
        return sseResponse(
          toolCallsDelta([{ id: `call_${requests}`, name: "Read", args: { path: "same.txt" } }]),
          "tool_calls",
        );
      }
      return sseResponse({ role: "assistant", content: "should not reach 7th request" }, "stop");
    });
    vi.stubGlobal("fetch", fetch);

    const runtime = new DesktopAgentRuntime({
      sessionId: `q06-${randomUUID()}`,
      mode: "agent",
      provider: provider(),
      thinkingLevel: "off",
      commandShell,
      host: {
        async call<T>(method: string): Promise<T> {
          if (method === "session.appendMessage" || method === "tools.abort") return undefined as T;
          if (method !== "tools.execute") throw new Error(`Unexpected host method: ${method}`);
          reads += 1;
          return { ok: true, content: "identical-read" } as T;
        },
      },
      onEvent: (envelope) => events.push(envelope),
    });

    try {
      await settle(runtime.prompt("read repeatedly across transient stream drop"));
      expect(reads).toBe(5);
      expect(requests).toBe(6);
      const errors = events
        .filter((e) => e.event.type === "error")
        .map((e) => (e.event.type === "error" ? e.event.error : undefined));
      expect(errors).toHaveLength(1);
      expect(errors[0]).toMatchObject({
        code: REPEATED_TOOL_CALL_ERROR_CODE,
        details: { toolName: "Read", count: 5 },
      });
    } finally {
      await runtime.dispose();
    }
  });

  it("Q07: never re-executes non-idempotent Write across mid-stream failure recovery", async () => {
    vi.useFakeTimers();
    const events: AgentEventEnvelope[] = [];
    let requests = 0;
    let writeCount = 0;
    let retrySawExistingWriteResult = false;

    const fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      requests += 1;
      const payload = parsePayload(init);
      if (requests === 1) {
        return sseResponse(
          toolCallsDelta([{ id: "write_once_1", name: "Write", args: { path: "out.txt", content: "once" } }]),
          "tool_calls",
        );
      }
      if (requests === 2) {
        return midStreamFailureResponse("partial after write");
      }
      const writeToolMsg = payload.messages.find(
        (m) => m.role === "tool" && m.tool_call_id === "write_once_1",
      );
      retrySawExistingWriteResult = Boolean(writeToolMsg && messageText(writeToolMsg.content).includes("wrote out.txt"));
      return sseResponse({ role: "assistant", content: "write-confirmed" }, "stop");
    });
    vi.stubGlobal("fetch", fetch);

    const runtime = new DesktopAgentRuntime({
      sessionId: `q07-${randomUUID()}`,
      mode: "agent",
      provider: provider(),
      thinkingLevel: "off",
      commandShell,
      host: {
        async call<T>(method: string, params?: unknown): Promise<T> {
          if (method === "session.appendMessage" || method === "tools.abort") return undefined as T;
          if (method !== "tools.execute") throw new Error(`Unexpected host method: ${method}`);
          const { toolName } = params as { toolName: string };
          if (toolName === "Write") {
            writeCount += 1;
            return { ok: true, content: "wrote out.txt" } as T;
          }
          throw new Error(`Unexpected tool: ${toolName}`);
        },
      },
      onEvent: (envelope) => events.push(envelope),
    });

    try {
      await settle(runtime.prompt("write once"));
      expect(writeCount).toBe(1);
      expect(requests).toBe(3);
      expect(retrySawExistingWriteResult).toBe(true);
      const finalAssistant = [...events]
        .reverse()
        .find((e) => e.event.type === "message_end" && e.event.message.role === "assistant" && !e.event.message.isError);
      expect(finalAssistant && finalAssistant.event.type === "message_end" ? finalAssistant.event.message.content : "").toBe("write-confirmed");
    } finally {
      await runtime.dispose();
    }
  });

  it("Q08: runtime.abort() settles cleanly with zero post-abort requests or extra agent_end on late tool completion", async () => {
    const events: AgentEventEnvelope[] = [];
    let fetchCalls = 0;
    let parentTurn = 0;
    let resolveParentGate!: () => void;
    let resolveChildGate!: () => void;
    let markParentEntered!: () => void;
    let markChildEntered!: () => void;
    const parentGate = new Promise<void>((resolve) => {
      resolveParentGate = resolve;
    });
    const childGate = new Promise<void>((resolve) => {
      resolveChildGate = resolve;
    });
    const parentEntered = new Promise<void>((resolve) => {
      markParentEntered = resolve;
    });
    const childEntered = new Promise<void>((resolve) => {
      markChildEntered = resolve;
    });

    const fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      fetchCalls += 1;
      const payload = parsePayload(init);
      const systemText = messageText(payload.messages.find((m) => m.role === "system")?.content);
      if (systemText.includes("SUBAGENT_SLOW")) {
        return sseResponse(
          toolCallsDelta([{ id: "child_read_1", name: "Read", args: { path: "child.txt" } }]),
          "tool_calls",
        );
      }
      parentTurn += 1;
      if (parentTurn === 1) {
        return sseResponse(
          toolCallsDelta([{ id: "task_slow", name: "Task", args: { agent: "slow-worker", task: "long check" } }]),
          "tool_calls",
        );
      }
      if (parentTurn === 2) {
        return sseResponse(
          toolCallsDelta([{ id: "parent_read_1", name: "Read", args: { path: "parent.txt" } }]),
          "tool_calls",
        );
      }
      throw new Error("Should not call fetch after abort");
    });
    vi.stubGlobal("fetch", fetch);

    const runtime = new DesktopAgentRuntime({
      sessionId: `q08-${randomUUID()}`,
      mode: "agent",
      provider: provider(),
      thinkingLevel: "off",
      commandShell,
      subagents: [subagent("slow-worker", "SUBAGENT_SLOW", "Holds a pending tool")],
      host: {
        async call<T>(method: string, params?: unknown): Promise<T> {
          if (method === "session.appendMessage" || method === "tools.abort") return undefined as T;
          if (method !== "tools.execute") throw new Error(`Unexpected host method: ${method}`);
          const path = (params as { args: { path?: string } }).args.path;
          if (path === "child.txt") {
            markChildEntered();
            await childGate;
            return { ok: true, content: "late child" } as T;
          }
          if (path === "parent.txt") {
            markParentEntered();
            await parentGate;
            return { ok: true, content: "late parent" } as T;
          }
          throw new Error(`Unexpected read path: ${path}`);
        },
      },
      onEvent: (envelope) => events.push(envelope),
    });

    try {
      const promptPromise = runtime.prompt("start slow child and slow parent read");
      await Promise.all([childEntered, parentEntered]);
      const fetchCountBeforeAbort = fetchCalls;

      await runtime.abort();
      resolveParentGate();
      resolveChildGate();
      await promptPromise;
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(fetchCalls).toBe(fetchCountBeforeAbort);
      expect(events.filter((e) => e.event.type === "agent_end")).toHaveLength(1);
    } finally {
      await runtime.dispose();
    }
  });
});
