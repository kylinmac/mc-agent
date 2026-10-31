import { describe, expect, it } from "vitest";
import { canRequestFastMode, fastModeEnabled, fastModeKey } from "./fast-mode.js";

const binding = { id: "account", modelId: "gpt-6.1-sol", apiStyle: "responses" };
describe("Fast preference eligibility and isolation", () => {
  it.each(["responses", "openai-responses", "chat_completions", "openai-completions", "openai_codex_responses", "openai-codex-responses"])("accepts %s", (apiStyle) => {
    expect(canRequestFastMode({ ...binding, apiStyle })).toBe(true);
  });
  it.each([
    { modelId: "deepseek-flash" }, { modelId: "gpt-4o" }, { apiStyle: "anthropic_messages" },
    { apiStyle: "unknown" }, { vendorKey: "github-copilot" }, { extensionAgentKey: "plugin" },
  ])("rejects unsupported binding %j", (override) => {
    expect(canRequestFastMode({ ...binding, ...override })).toBe(false);
  });
  it("defaults off, requires boolean true and isolates each exact provider/model", () => {
    const preferences = { [fastModeKey(binding.id, binding.modelId)]: true };
    expect(fastModeEnabled(preferences, binding)).toBe(true);
    expect(fastModeEnabled(preferences, { ...binding, id: "other" })).toBe(false);
    expect(fastModeEnabled(preferences, { ...binding, modelId: "gpt-6-astra" })).toBe(false);
    for (const value of [undefined, null, [], {}, { [fastModeKey(binding.id, binding.modelId)]: "true" }]) {
      expect(fastModeEnabled(value, binding)).toBe(false);
    }
    expect(fastModeKey("a:b", "c")).not.toBe(fastModeKey("a", "b:c"));
  });
});
