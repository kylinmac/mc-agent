import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEEPSEEK_MODELS } from "@earendil-works/pi-ai/providers/deepseek.models";
import type { AgentEventEnvelope, McUserHook, PlanExecution } from "@pi-desktop/shared";
import { modelConfigFromPi } from "./model-capabilities.js";
import { MAX_STOP_CONTINUATIONS } from "./mc-user-hooks.js";
import { REPEATED_TOOL_CALL_ERROR_CODE } from "./mc-repeated-tool-calls.js";
import {
  DesktopAgentRuntime,
  type RuntimeProviderConfig,
} from "./runtime.js";

// mc-agent (#148 / Q09-Q12): Stop hook feedback loops, MAX_STOP_CONTINUATIONS
// cap, RT-1 immediate abort during slow Stop hooks, timeout/error fail-open,
// and RT-3 executeApprovedPlan repeat-counter reset + Stop hook coverage.

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function provider(): RuntimeProviderConfig {
  const model = Object.values(DEEPSEEK_MODELS).find((item) => item.id === "deepseek-flash")!;
  return {
    id: "q09-fixture",
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
};

type Payload = {
  messages: PayloadMessage[];
};

function parsePayload(init?: RequestInit): Payload {
  return JSON.parse(String(init?.body ?? "{}")) as Payload;
}

function messageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => (part && typeof part === "object" && "text" in part ? String((part as { text: unknown }).text) : ""))
    .join("");
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

describe("Q09-Q12: Stop hooks, abort responsiveness, and executeApprovedPlan reset", () => {
  it("Q09: blocks premature stop until Write creates fixed.marker, then completes", async () => {
    const dir = makeTempDir("mc-q09-");
    const events: AgentEventEnvelope[] = [];
    let requests = 0;
    let sawStopFeedback = false;

    const fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      requests += 1;
      const payload = parsePayload(init);
      if (requests === 1) {
        return sseResponse({ role: "assistant", content: "done too early" }, "stop");
      }
      if (requests === 2) {
        sawStopFeedback = payload.messages.some((m) => {
          const text = messageText(m.content);
          return (
            m.role === "user" &&
            text.includes("[Automatic notice from a user-configured hook") &&
            text.includes("missing fixed.marker")
          );
        });
        return sseResponse(
          toolCallsDelta([{ id: "write_marker_1", name: "Write", args: { path: "fixed.marker", content: "ok" } }]),
          "tool_calls",
        );
      }
      return sseResponse({ role: "assistant", content: "all green" }, "stop");
    });
    vi.stubGlobal("fetch", fetch);

    const runtime = new DesktopAgentRuntime({
      sessionId: `q09-${randomUUID()}`,
      mode: "agent",
      projectPath: dir,
      workspaceRoot: dir,
      provider: provider(),
      thinkingLevel: "off",
      commandShell,
      userHooks: [
        {
          id: "gate",
          event: "Stop",
          command: "test -f fixed.marker || { echo 'missing fixed.marker' >&2; exit 2; }",
        },
      ],
      host: {
        async call<T>(method: string, params?: unknown): Promise<T> {
          if (method === "tools.execute") {
            const { toolName, args } = params as { toolName: string; args: { path: string; content: string } };
            if (toolName === "Write") {
              writeFileSync(join(dir, args.path), args.content, "utf8");
              return { ok: true, content: "written" } as T;
            }
          }
          return undefined as T;
        },
      },
      onEvent: (envelope) => events.push(envelope),
    });

    try {
      await runtime.prompt("complete task with marker gate");
      expect(requests).toBe(3);
      expect(sawStopFeedback).toBe(true);
      expect(existsSync(join(dir, "fixed.marker"))).toBe(true);
      const finalAssistant = [...events]
        .reverse()
        .find((e) => e.event.type === "message_end" && e.event.message.role === "assistant");
      expect(finalAssistant && finalAssistant.event.type === "message_end" ? finalAssistant.event.message.content : "").toBe("all green");
    } finally {
      await runtime.dispose();
    }
  });

  it("Q10: bounds repeating exit-2 Stop hook continuations to 1 + MAX_STOP_CONTINUATIONS", async () => {
    const dir = makeTempDir("mc-q10-");
    let requests = 0;
    const fetch = vi.fn(async (): Promise<Response> => {
      requests += 1;
      return sseResponse({ role: "assistant", content: `attempt-${requests}` }, "stop");
    });
    vi.stubGlobal("fetch", fetch);

    const runtime = new DesktopAgentRuntime({
      sessionId: `q10-${randomUUID()}`,
      mode: "agent",
      projectPath: dir,
      workspaceRoot: dir,
      provider: provider(),
      thinkingLevel: "off",
      commandShell,
      userHooks: [
        {
          id: "always-block",
          event: "Stop",
          command: "echo 'still broken' >&2; exit 2",
        },
      ],
      host: {
        async call<T>(): Promise<T> {
          return undefined as T;
        },
      },
      onEvent: () => {},
    });

    try {
      await runtime.prompt("finish even if hook complains forever");
      expect(requests).toBe(1 + MAX_STOP_CONTINUATIONS);
    } finally {
      await runtime.dispose();
    }
  });

  it("Q11: abort() terminates a slow Stop hook immediately, while timeout and exit 1 fail open", async () => {
    // Sub-case A: abort while slow Stop hook is running
    {
      const dir = makeTempDir("mc-q11-abort-");
      let requests = 0;
      vi.stubGlobal(
        "fetch",
        vi.fn(async (): Promise<Response> => {
          requests += 1;
          return sseResponse({ role: "assistant", content: "initial response" }, "stop");
        }),
      );

      const runtime = new DesktopAgentRuntime({
        sessionId: `q11a-${randomUUID()}`,
        mode: "agent",
        projectPath: dir,
        workspaceRoot: dir,
        provider: provider(),
        thinkingLevel: "off",
        commandShell,
        userHooks: [
          {
            id: "slow-stop",
            event: "Stop",
            command: "touch hook.started; sleep 30; echo 'late block' >&2; exit 2",
          },
        ],
        host: {
          async call<T>(): Promise<T> {
            return undefined as T;
          },
        },
        onEvent: () => {},
      });

      try {
        const run = runtime.prompt("finish with slow hook");
        const startedAt = Date.now();
        while (!existsSync(join(dir, "hook.started"))) {
          if (Date.now() - startedAt > 2_000) throw new Error("slow Stop hook never started");
          await new Promise((resolve) => setTimeout(resolve, 15));
        }

        const abortAt = Date.now();
        await runtime.abort();
        await run;
        expect(Date.now() - abortAt).toBeLessThan(3_000);
        expect(requests).toBe(1);
      } finally {
        await runtime.dispose();
      }
    }

    // Sub-case B: hook timeout and non-2 exit codes fail open with 0 continuations
    for (const hook of [
      { id: "timeout-stop", event: "Stop", command: "sleep 3; echo 'timed out' >&2; exit 2", timeoutSeconds: 1 } satisfies McUserHook,
      { id: "err1-stop", event: "Stop", command: "echo 'hook internal error' >&2; exit 1" } satisfies McUserHook,
    ]) {
      const dir = makeTempDir("mc-q11-open-");
      let requests = 0;
      vi.stubGlobal(
        "fetch",
        vi.fn(async (): Promise<Response> => {
          requests += 1;
          return sseResponse({ role: "assistant", content: "done" }, "stop");
        }),
      );

      const runtime = new DesktopAgentRuntime({
        sessionId: `q11b-${randomUUID()}`,
        mode: "agent",
        projectPath: dir,
        workspaceRoot: dir,
        provider: provider(),
        thinkingLevel: "off",
        commandShell,
        userHooks: [hook],
        host: {
          async call<T>(): Promise<T> {
            return undefined as T;
          },
        },
        onEvent: () => {},
      });

      try {
        await runtime.prompt(`check fail-open ${hook.id}`);
        expect(requests).toBe(1);
      } finally {
        await runtime.dispose();
      }
    }
  });

  it("Q12: executeApprovedPlan resets RepeatedToolCallTracker and runs Stop hooks for both plan and goal", async () => {
    for (const kind of ["plan", "goal"] as const) {
      const dir = makeTempDir(`mc-q12-${kind}-`);
      const sessionId = `q12-${kind}-${randomUUID()}`;
      const events: AgentEventEnvelope[] = [];
      let readCount = 0;
      let phase: "planning" | "executing" = "planning";
      let planStep = 0;
      let execStep = 0;
      let execSawStopContinuation = false;

      vi.stubGlobal(
        "fetch",
        vi.fn(async (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
          const payload = parsePayload(init);
          if (phase === "planning") {
            planStep += 1;
            if (planStep <= 4) {
              return sseResponse(
                toolCallsDelta([{ id: `plan_read_${planStep}`, name: "Read", args: { path: "spec.md" } }]),
                "tool_calls",
              );
            }
            return sseResponse({ role: "assistant", content: "ready" }, "stop");
          }

          execStep += 1;
          if (execStep <= 2) {
            return sseResponse(
              toolCallsDelta([{ id: `exec_read_${execStep}`, name: "Read", args: { path: "spec.md" } }]),
              "tool_calls",
            );
          }
          if (execStep === 3) {
            return sseResponse({ role: "assistant", content: "executed" }, "stop");
          }
          execSawStopContinuation = payload.messages.some((m) => {
            const text = messageText(m.content);
            return (
              m.role === "user" &&
              text.includes("[Automatic notice from a user-configured hook") &&
              text.includes("verify once more")
            );
          });
          return sseResponse({ role: "assistant", content: "verified" }, "stop");
        }),
      );

      const runtime = new DesktopAgentRuntime({
        sessionId,
        mode: kind,
        projectPath: dir,
        workspaceRoot: dir,
        provider: provider(),
        thinkingLevel: "off",
        commandShell,
        userHooks: [
          {
            id: "exec-stop-once",
            event: "Stop",
            command: "if [ -f exec.started ] && [ ! -f stop.checked ]; then touch stop.checked; echo 'verify once more' >&2; exit 2; fi",
          },
        ],
        host: {
          async call<T>(method: string): Promise<T> {
            if (method === "tools.execute") {
              readCount += 1;
              return { ok: true, content: "spec-v1" } as T;
            }
            return undefined as T;
          },
        },
        onEvent: (envelope) => events.push(envelope),
      });

      try {
        await runtime.prompt(`draft ${kind} proposal`);
        expect(readCount).toBe(4);

        phase = "executing";
        writeFileSync(join(dir, "exec.started"), "1", "utf8");
        const execution: PlanExecution = {
          id: `exec-${kind}`,
          proposalId: `prop-${kind}`,
          sessionId,
          kind,
          plan: "# Steps\n1. Check spec\n",
          title: `Test ${kind}`,
          question: "Proceed?",
          artifact: {
            relativePath: `.pi/${kind}s/test.md`,
            sha256: "0".repeat(64),
            sizeBytes: 22,
          },
          targetPermissionMode: "auto",
          state: "running",
        };
        await runtime.executeApprovedPlan(execution, "exec-turn-1");

        expect(readCount).toBe(6);
        expect(execSawStopContinuation).toBe(true);
        const errors = events.filter((e) => e.event.type === "error");
        expect(errors, `unexpected error for ${kind}: ${JSON.stringify(errors)}`).toHaveLength(0);
        const repeatLimitEvents = events.filter(
          (e) => e.event.type === "error" && e.event.error.code === REPEATED_TOOL_CALL_ERROR_CODE,
        );
        expect(repeatLimitEvents).toHaveLength(0);
      } finally {
        await runtime.dispose();
      }
    }
  });
});
