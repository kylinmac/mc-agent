import { describe, expect, it } from "vitest";
import type { Api, Model, Tool } from "@earendil-works/pi-ai";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { contextBreakdown } from "./context-breakdown.js";

const model = {
  id: "test-model",
  name: "Test",
  api: "openai-completions",
  provider: "test",
  baseUrl: "http://localhost",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 200_000,
  maxTokens: 8_000,
} as unknown as Model<Api>;

const tool = (name: string, mcpServerId?: string) =>
  ({
    name,
    description: "x".repeat(70),
    parameters: { type: "object", properties: {} },
    ...(mcpServerId ? { mcpServerId } : {}),
  }) as unknown as Tool & { mcpServerId?: string };

describe("contextBreakdown", () => {
  it("splits the composed prompt, tools and conversation by kind", () => {
    const project = "P".repeat(350);
    const memory = "M".repeat(70);
    const result = contextBreakdown({
      sections: {
        runtime: "R".repeat(700),
        "skill:review": "S".repeat(350),
        context: `mode ${project}\n\n${memory}`,
      },
      projectInstructionsPrompt: project,
      memoryPrompt: memory,
      tools: [tool("read"), tool("bash"), tool("docs_search", "docs")],
      messages: [
        { role: "system", content: "", sections: {}, timestamp: 1 } as unknown as AgentMessage,
        { role: "user", content: "hello there", timestamp: 2 } as AgentMessage,
      ],
      model,
    });

    expect(result.categories.systemPrompt).toBeGreaterThanOrEqual(200);
    expect(result.categories.projectInstructions).toBe(100);
    expect(result.categories.memory).toBe(20);
    expect(result.categories.skills).toBe(100);
    expect(result.toolCount).toBe(2);
    expect(result.mcpToolCount).toBe(1);
    expect(result.categories.mcpTools).toBeGreaterThan(0);
    expect(result.categories.tools).toBeGreaterThan(result.categories.mcpTools);
    expect(result.messageCount).toBe(1);
    expect(result.categories.messages).toBeGreaterThan(0);
    expect(result.skillCount).toBe(1);
    expect(result.toolNames).toEqual(["bash", "read"]);
    expect(result.mcpToolNames).toEqual(["docs_search"]);
    expect(result.skillNames).toEqual(["review"]);
    expect(result.usedTokens).toBe(
      Object.values(result.categories).reduce((sum, value) => sum + value, 0),
    );
    expect(result.contextWindow).toBe(200_000);
    expect(result.autoCompactAt).toBeGreaterThan(0);
    expect(result.autoCompactAt).toBeLessThan(200_000);
  });

  it("counts MCP tools named by the host even when declarations lack mcpServerId (#40)", () => {
    const result = contextBreakdown({
      sections: {},
      projectInstructionsPrompt: "",
      memoryPrompt: "",
      // Provider-facing declarations: one MCP tool activated, no server id.
      tools: [tool("read"), tool("mcp_dbx_list_connections")],
      mcpToolNames: ["mcp_dbx_list_connections", "mcp_dbx_query", "mcp_dbx_describe"],
      messages: [],
      model,
    });

    expect(result.toolCount).toBe(1);
    expect(result.toolNames).toEqual(["read"]);
    expect(result.mcpToolCount).toBe(3);
    expect(result.mcpToolNames).toEqual(["mcp_dbx_describe", "mcp_dbx_list_connections", "mcp_dbx_query"]);
    // Only the declared MCP tool costs context tokens.
    const declaredOnly = contextBreakdown({
      sections: {},
      projectInstructionsPrompt: "",
      memoryPrompt: "",
      tools: [tool("mcp_dbx_list_connections", "dbx")],
      messages: [],
      model,
    });
    expect(result.categories.mcpTools).toBe(declaredOnly.categories.mcpTools);
  });

  it("never reports a negative remainder when the context section is all project text", () => {
    const project = "P".repeat(70);
    const result = contextBreakdown({
      sections: { context: project },
      projectInstructionsPrompt: project,
      memoryPrompt: "",
      tools: [],
      messages: [],
      model,
    });
    expect(result.categories.systemPrompt).toBe(0);
    expect(result.categories.projectInstructions).toBe(20);
  });
});
