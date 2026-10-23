import { OAUTH_AUTH_KIND } from "./types/providers.js";
import type { ProviderPublic } from "./types/providers.js";

export type DictationAdapter = "codex" | "openai" | "gemini" | "xai";
export type DictationSettings = {
  enabled: boolean;
  adapter: DictationAdapter;
  providerId: string;
  modelId: string;
};
export const DICTATION_MAX_SECONDS = 180;
export const DICTATION_MAX_BYTES = 44 + 16000 * 2 * DICTATION_MAX_SECONDS;
export const DICTATION_DEFAULT_MODELS: Record<DictationAdapter, string> = {
  codex: "", openai: "gpt-transcribe", gemini: "gemini-3.8-flash", xai: "grok-voice-transcribe-2.0",
};
export function dictationProviderMatches(adapter: DictationAdapter, provider: ProviderPublic): boolean {
  if (!provider.enabled) return false;
  if (adapter === "codex") return provider.vendorKey === "openai-codex" && provider.authKind === OAUTH_AUTH_KIND;
  if (provider.authKind === OAUTH_AUTH_KIND) return false;
  if (adapter === "gemini") return provider.vendorKey === "google" && provider.apiStyle === "google_generative_ai";
  if (adapter === "xai") return provider.vendorKey === "xai";
  return Boolean(provider.baseUrl) && provider.apiStyle !== "google_generative_ai";
}
export function parseDictationSettings(raw: unknown): DictationSettings {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("DICTATION_NOT_CONFIGURED");
  const value = raw as Record<string, unknown>;
  if (typeof value.enabled !== "boolean" || !["codex", "openai", "gemini", "xai"].includes(String(value.adapter)) ||
      typeof value.providerId !== "string" || (value.enabled && !value.providerId.trim()) || value.providerId.length > 256 ||
      typeof value.modelId !== "string" || value.modelId.length > 160 ||
      (value.enabled && ["openai", "gemini", "xai"].includes(String(value.adapter)) && !value.modelId.trim())) throw new Error("DICTATION_NOT_CONFIGURED");
  return { enabled: value.enabled, adapter: value.adapter as DictationAdapter, providerId: value.providerId, modelId: value.modelId.trim() };
}
