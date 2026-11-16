/** Allowlisted shape only; a malformed sidecar event must not turn into a content log. */
export function contextDiagnosticData(data: object): Record<string, unknown> {
  const input = data as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of ["historyCount", "expectedCount", "restoredCount", "matchedCount", "missingCount", "missingToolCallCount", "attempt", "requestCount", "estimatedTokens"]) {
    const value = input[key];
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) out[key] = value;
  }
  for (const key of ["ok", "reordered", "boundaryMissing", "fallback"]) {
    if (typeof input[key] === "boolean") out[key] = input[key];
  }
  const hash = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{24}$/.test(value);
  for (const key of ["checkpointKey", "boundaryKey", "selectedCheckpointKey", "latestCheckpointKey"]) {
    if (hash(input[key])) out[key] = input[key];
  }
  if (typeof input.restoreId === "string" && /^[a-f0-9-]{36}$/.test(input.restoreId)) out.restoreId = input.restoreId;
  if (Array.isArray(input.missingKeys)) out.missingKeys = input.missingKeys.filter(hash).slice(0, 5);
  for (const [field, keys] of Object.entries({
    roleCounts: ["system", "user", "assistant", "toolResult", "other"],
    exclusions: ["delegate", "system", "incomplete_tool", "empty_user", "failed_assistant", "unreplayable_assistant", "empty_assistant", "unsupported_role"],
  })) {
    const values = input[field];
    if (!values || typeof values !== "object") continue;
    const counts: Record<string, number> = {};
    for (const key of keys) {
      const value = Reflect.get(values, key);
      if (typeof value === "number" && Number.isFinite(value) && value >= 0) counts[key] = value;
    }
    out[field] = counts;
  }
  return out;
}

const RESPONSE_END_STRINGS = ["reason", "provider", "modelId", "api"] as const;
const RESPONSE_END_TOKENS: ReadonlyArray<readonly [string, string]> = [
  ["inputTokens", "input"],
  ["outputTokens", "output"],
  ["reasoningTokens", "reasoning"],
  ["cacheReadTokens", "cacheRead"],
  ["cacheWriteTokens", "cacheWrite"],
];

/**
 * Strip `*Tokens` suffixes before Logger passes `data` through `SECRET_KEY_RE`,
 * preserving numeric cache metrics while leaving unreported buckets absent.
 */
export function responseEndDiagnosticData(data: object): Record<string, unknown> {
  const input = data as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of RESPONSE_END_STRINGS) {
    const value = input[key];
    if (typeof value === "string" && value.length > 0 && value.length <= 128) out[key] = value;
  }
  if (typeof input.durationMs === "number" && Number.isFinite(input.durationMs) && input.durationMs >= 0) {
    out.durationMs = input.durationMs;
  }
  for (const [source, target] of RESPONSE_END_TOKENS) {
    const value = input[source];
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) out[target] = value;
  }
  return out;
}
