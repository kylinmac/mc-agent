import { SUBAGENT_THINKING_LEVELS, type SubagentThinkingLevel } from "@pi-desktop/shared";
import { Type } from "typebox";
import { clampThinkingLevel, type ThinkingCapabilitySet } from "./thinking-level.js";

export const taskThinkingParameter = Type.Optional(Type.Union(
  SUBAGENT_THINKING_LEVELS.map(level => Type.Literal(level)),
  { description: "Thinking level for this run, including fork/resume. Overrides the definition and parent. Choose a supported level from the model catalog; unsupported levels are rejected, never silently upgraded. omit sends no reasoning parameter. Omit this field to keep the existing default." },
));

export function taskThinkingOverride(value: unknown, provider: ThinkingCapabilitySet): SubagentThinkingLevel | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !SUBAGENT_THINKING_LEVELS.some(level => level === value)) {
    throw new Error(`Invalid thinkingLevel. Choose: ${SUBAGENT_THINKING_LEVELS.join(", ")}.`);
  }
  const level = value as SubagentThinkingLevel;
  if (level !== "omit" && (!provider.supportedThinkingLevels.includes(level) || clampThinkingLevel(provider, level) !== level)) {
    throw new Error(`This model does not support thinkingLevel "${level}". Supported: ${provider.supportedThinkingLevels.join(", ")}; omit.`);
  }
  return level;
}
