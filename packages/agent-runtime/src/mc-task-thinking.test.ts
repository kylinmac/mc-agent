import { expect, it } from "vitest";
import { SUBAGENT_THINKING_LEVELS } from "@pi-desktop/shared";
import { taskThinkingOverride } from "./mc-task-thinking.js";

const provider = { supportsReasoning: true, supportedThinkingLevels: ["off", "low", "high"] as const };
it("preserves omission and every explicitly supported selection", () => {
  expect(taskThinkingOverride(undefined, provider)).toBeUndefined();
  for (const level of SUBAGENT_THINKING_LEVELS) {
    expect(taskThinkingOverride(level, { supportsReasoning: true, supportedThinkingLevels: SUBAGENT_THINKING_LEVELS.filter(value => value !== "omit") })).toBe(level);
  }
  expect(taskThinkingOverride("omit", { supportsReasoning: false, supportedThinkingLevels: ["off"] })).toBe("omit");
});
it.each([null, 1, "auto", "LOW", "medium"])("rejects invalid or unsupported selection %s", value => {
  expect(() => taskThinkingOverride(value, provider)).toThrow(/thinkingLevel/);
});

it("does not treat an empty capability list as explicit off support", () => {
  expect(() => taskThinkingOverride("off", { supportsReasoning: true, supportedThinkingLevels: [] })).toThrow(/does not support/);
});
