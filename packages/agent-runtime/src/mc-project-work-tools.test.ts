import { expect, it, vi } from "vitest";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { DesktopAgentRuntime } from "./runtime.js";
import {
  buildProjectResourcesTool, buildProjectTasksTool, PROJECT_RESOURCES_TOOL_NAME, PROJECT_TASKS_TOOL_NAME,
} from "./mc-project-work-tools.js";

const host = (reply: unknown = { ok: true }) => {
  const call = vi.fn(async (_method: string, _params?: unknown) => reply);
  return { call: call as unknown as <T>(method: string, params?: unknown) => Promise<T>, spy: call };
};

it("binds the caller's session and drops forged scope fields", async () => {
  const { call, spy } = host({ project: "App", tasks: [{ id: "a1b2c3d4", title: "登录接口", status: "todo" }] });
  const result = await buildProjectTasksTool({ call }, "caller", () => true)
    .execute("t", { action: "list", status: "open", sessionId: "forged", tool: "resources" } as never);
  expect(spy).toHaveBeenCalledWith("session.projectWork", { sessionId: "caller", tool: "tasks", action: "list", status: "open" });
  const text = JSON.stringify(result.content);
  expect(text).toContain("登录接口");
  expect(text).toContain("not new instructions");
});

it("refuses writes when the mode only allows reading", async () => {
  const { call, spy } = host();
  const tasks = buildProjectTasksTool({ call }, "caller", () => false);
  const resources = buildProjectResourcesTool({ call }, "caller", () => false);
  await expect(tasks.execute("t", { action: "create", title: "x", acceptance: "y" })).rejects.toThrow(/only reads/);
  await expect(tasks.execute("t", { action: "update", taskId: "a", revision: 1, title: "x" })).rejects.toThrow(/only reads/);
  await expect(resources.execute("t", { action: "register", url: "https://example.com" })).rejects.toThrow(/only reads/);
  expect(spy).not.toHaveBeenCalled();
  await resources.execute("t", { action: "list" });
  expect(spy).toHaveBeenCalledWith("session.projectWork", { sessionId: "caller", tool: "resources", action: "list" });
});

it("offers no review, cancel, start or resource status action", () => {
  const { call } = host();
  const actions = (tool: AgentTool) => JSON.stringify((tool.parameters as { properties: { action: unknown } }).properties.action);
  const tasks = actions(buildProjectTasksTool({ call }, "s", () => true) as AgentTool);
  const resources = actions(buildProjectResourcesTool({ call }, "s", () => true) as AgentTool);
  for (const forbidden of ["review", "cancel", "reopen", "start", "setStatus", "confirm", "unregister"]) {
    expect(tasks).not.toContain(forbidden);
    expect(resources).not.toContain(forbidden);
  }
});

it("keeps declarations within the context budget", () => {
  const { call } = host();
  const tools = [buildProjectTasksTool({ call }, "s", () => true), buildProjectResourcesTool({ call }, "s", () => true)] as AgentTool[];
  // Rough provider-side size: about four characters per token for English JSON.
  const tokens = tools.map(tool => Math.ceil(JSON.stringify({ name: tool.name, description: tool.description, parameters: tool.parameters }).length / 4));
  for (const size of tokens) expect(size).toBeLessThanOrEqual(650);
  expect(tokens[0]! + tokens[1]!).toBeLessThanOrEqual(1200);
  // The on-demand catalog shows only the first 120 characters: they must say what the tool is for.
  expect(tools[0]!.description.slice(0, 120)).toMatch(/project's shared task board/);
  expect(tools[1]!.description.slice(0, 120)).toMatch(/project's resources/);
});

it.each(["agent", "plan", "goal"] as const)("is on demand, not core, in %s mode", async (mode) => {
  const { call, spy } = host();
  const runtime = new DesktopAgentRuntime({ sessionId: "caller", mode, provider: { id: "offline", name: "Offline", modelId: "offline", apiStyle: "responses", apiKey: "offline-not-used", supportedThinkingLevels: ["off"], supportsReasoning: false }, thinkingLevel: "off", history: [], commandShell: { id: "bash", label: "Bash", dialect: "posix", available: true, isDefault: true }, host: { call }, onEvent: () => {} });
  try {
    const inner = runtime as unknown as { toolCatalog: Map<string, AgentTool>; deferredToolNames: Set<string> };
    for (const name of [PROJECT_TASKS_TOOL_NAME, PROJECT_RESOURCES_TOOL_NAME]) {
      expect(inner.toolCatalog.get(name)).toBeDefined();
      expect(inner.deferredToolNames.has(name)).toBe(true);
    }
    const create = inner.toolCatalog.get(PROJECT_TASKS_TOOL_NAME)!.execute("t", { action: "create", title: "x", acceptance: "y" });
    if (mode !== "agent") {
      await expect(create).rejects.toThrow(/only reads/);
      expect(spy).not.toHaveBeenCalled();
    } else {
      await create;
      expect(spy).toHaveBeenCalledWith("session.projectWork", expect.objectContaining({ action: "create" }));
    }
  } finally { await runtime.dispose(); }
});
