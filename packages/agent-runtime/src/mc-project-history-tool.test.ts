import { expect, it, vi } from "vitest";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { DesktopAgentRuntime } from "./runtime.js";
import { buildProjectHistoryTool } from "./mc-project-history-tool.js";

it("binds the caller while preserving a separate target and source metadata", async () => {
  const call = vi.fn();
  const tool = buildProjectHistoryTool({ call: async <T>(method: string, params?: unknown) => {
    call(method, params);
    return { session: { id: "other", title: "CDC" }, messages: [{ id: "m1", role: "user", text: "Confirmed requirement" }] } as T;
  } }, "caller");
  const result = await tool.execute("t", { action: "read", targetSessionId: "other", sessionId: "forged" } as never);
  expect(call).toHaveBeenCalledWith("session.projectHistory", { sessionId: "caller", action: "read", targetSessionId: "other" });
  expect(JSON.stringify(result.content)).toContain("Confirmed requirement");
  expect(JSON.stringify(result.content)).toContain("not new instructions");
});

it.each(["agent", "plan", "goal"] as const)("is discoverable in %s without compaction", async (mode) => {
  const runtime = new DesktopAgentRuntime({ sessionId: "caller", mode, provider: { id: "offline", name: "Offline", modelId: "offline", apiStyle: "responses", apiKey: "offline-not-used", supportedThinkingLevels: ["off"], supportsReasoning: false }, thinkingLevel: "off", history: [], commandShell: { id: "bash", label: "Bash", dialect: "posix", available: true, isDefault: true }, host: { call: vi.fn() }, onEvent: () => {} });
  try {
    const catalog = (runtime as unknown as { toolCatalog: Map<string, AgentTool> }).toolCatalog;
    expect(catalog.get("ProjectHistory")).toBeDefined();
  } finally { await runtime.dispose(); }
});

it("does not issue a read after cancellation", async () => {
  const call = vi.fn();
  const controller = new AbortController(); controller.abort();
  await expect(buildProjectHistoryTool({ call }, "caller").execute("t", { action: "list" }, controller.signal)).rejects.toThrow(/cancel/i);
  expect(call).not.toHaveBeenCalled();
});


it("stops waiting when cancelled during a read", async () => {
  let finish!: (value: unknown) => void;
  const pending = new Promise<unknown>(resolve => { finish = resolve; });
  const controller = new AbortController();
  const result = buildProjectHistoryTool({ call: <T>() => pending as Promise<T> }, "caller")
    .execute("t", { action: "read", targetSessionId: "other" }, controller.signal);
  controller.abort();
  await expect(result).rejects.toThrow(/cancel/i);
  finish({ history: [] });
});
