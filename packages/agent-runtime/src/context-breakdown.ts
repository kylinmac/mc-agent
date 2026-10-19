/**
 * mc-agent: an estimate of what fills a session's model context, by kind,
 * for the session information panel. Provider usage only reports a total;
 * this splits the same context into the parts the runtime itself composes —
 * the base system prompt, project instructions (AGENTS.md), project memory,
 * skills, built-in and MCP tool declarations, and the conversation — using
 * the runtime's own token estimator. Numbers are estimates, not billing.
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { toToolDeclaration, type Api, type Model, type Tool } from "@earendil-works/pi-ai";
import { automaticCompactionThresholdFor, contextBudgetLimitsFor } from "./context-budget.js";
import { ESTIMATED_TEXT_CHARS_PER_TOKEN, estimateTokens } from "./pi-runtime-estimates.js";
import { SKILL_SECTION_PREFIX } from "./plugin-skills-prompt.js";
import { TOOL_ACTIVATION_SECTION } from "./fixed-tool-declarations.js";

export type ContextBreakdownCategory =
  | "systemPrompt"
  | "projectInstructions"
  | "memory"
  | "skills"
  | "tools"
  | "mcpTools"
  | "messages";

export type ContextBreakdown = {
  contextWindow: number;
  /** Estimated tokens at which automatic compaction starts. */
  autoCompactAt: number;
  /** Estimated tokens per kind; their sum is `usedTokens`. */
  categories: Record<ContextBreakdownCategory, number>;
  usedTokens: number;
  toolCount: number;
  mcpToolCount: number;
  skillCount: number;
  messageCount: number;
  /** Names for the panel's expandable rows. */
  toolNames: string[];
  mcpToolNames: string[];
  skillNames: string[];
};

export type ContextBreakdownInput = {
  /** The runtime's composed system-prompt sections. */
  sections: Readonly<Record<string, string>>;
  /** Exact texts included in the `context` section. */
  projectInstructionsPrompt: string;
  memoryPrompt: string;
  tools: ReadonlyArray<Tool & { mcpServerId?: string }>;
  messages: readonly AgentMessage[];
  model: Model<Api>;
};

function textTokens(text: string | undefined): number {
  return text ? Math.ceil(text.length / ESTIMATED_TEXT_CHARS_PER_TOKEN) : 0;
}

function toolTokens(tool: Tool): number {
  try {
    return textTokens(JSON.stringify(toToolDeclaration(tool)));
  } catch {
    return textTokens(`${tool.name} ${tool.description ?? ""}`);
  }
}

function messageTokens(message: AgentMessage, model: Model<Api>): number {
  try {
    return Math.max(0, Math.ceil(estimateTokens(message, model)));
  } catch {
    return 0;
  }
}

export function contextBreakdown(input: ContextBreakdownInput): ContextBreakdown {
  const { sections } = input;
  const skillNames = Object.keys(sections).filter(
    (name) => name === "skills" || name.startsWith(SKILL_SECTION_PREFIX),
  );
  const skills = skillNames.reduce((sum, name) => sum + textTokens(sections[name]), 0);
  const projectInstructions = textTokens(input.projectInstructionsPrompt);
  const memory = textTokens(input.memoryPrompt);
  // The `context` section also carries the mode prompt and appended custom
  // instructions; those count as system prompt with the base section.
  const contextRest = Math.max(0, textTokens(sections.context) - projectInstructions - memory);
  const systemPrompt =
    textTokens(sections.runtime) + textTokens(sections[TOOL_ACTIVATION_SECTION]) + contextRest;

  let tools = 0;
  let mcpTools = 0;
  const toolNames: string[] = [];
  const mcpToolNames: string[] = [];
  for (const tool of input.tools) {
    const cost = toolTokens(tool);
    if (tool.mcpServerId) {
      mcpTools += cost;
      mcpToolNames.push(tool.name);
    } else {
      tools += cost;
      toolNames.push(tool.name);
    }
  }

  let messages = 0;
  let messageCount = 0;
  for (const message of input.messages) {
    // System rows are the prompt sections counted above.
    if (message.role === "system") continue;
    messages += messageTokens(message, input.model);
    messageCount += 1;
  }

  const categories = { systemPrompt, projectInstructions, memory, skills, tools, mcpTools, messages };
  const limits = contextBudgetLimitsFor(input.model);
  return {
    contextWindow: Math.max(1, Math.round(input.model.contextWindow || 0)) || limits.hardLimit,
    autoCompactAt: automaticCompactionThresholdFor(limits),
    categories,
    usedTokens: Object.values(categories).reduce((sum, value) => sum + value, 0),
    toolCount: toolNames.length,
    mcpToolCount: mcpToolNames.length,
    skillCount: skillNames.filter((name) => name !== "skills").length,
    messageCount,
    toolNames: toolNames.sort(),
    mcpToolNames: mcpToolNames.sort(),
    skillNames: skillNames
      .filter((name) => name !== "skills")
      .map((name) => name.slice(SKILL_SECTION_PREFIX.length))
      .sort(),
  };
}
