import { resolveApiStyle } from "./model-config-import.js";

export type FastModeBinding = { id: string; modelId: string; apiStyle?: string; vendorKey?: string; extensionAgentKey?: string };
export function fastModeKey(providerId: string, modelId: string): string {
  return JSON.stringify([providerId, modelId]);
}
/** Eligibility to request Fast, not proof of account entitlement or gateway support. */
export function canRequestFastMode(binding: FastModeBinding): boolean {
  if (binding.extensionAgentKey || ["github-copilot", "google", "anthropic"].includes(binding.vendorKey ?? "")) return false;
  const style = resolveApiStyle(binding.apiStyle) ?? (binding.apiStyle ? "unsupported" : "chat_completions");
  if (!["responses", "openai_codex_responses", "chat_completions"].includes(style)) return false;
  return /^gpt-(?:5\.(?:4|5|6)(?:-(?:sol|terra|luna|codex))?|6(?:\.1)?-(?:astra|sol|terra|luna))(?:-\d{4}-\d{2}-\d{2})?$/.test(binding.modelId);
}
export function fastModeEnabled(preferences: unknown, binding: FastModeBinding): boolean {
  if (!canRequestFastMode(binding) || !preferences || typeof preferences !== "object" || Array.isArray(preferences)) return false;
  return Object.prototype.hasOwnProperty.call(preferences, fastModeKey(binding.id, binding.modelId))
    && (preferences as Record<string, unknown>)[fastModeKey(binding.id, binding.modelId)] === true;
}
