/** Allowlisted shape only; a malformed sidecar event must not turn into a content log. */
export function contextDiagnosticData(data: object): Record<string, unknown> {
  const input = data as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of ["historyCount", "expectedCount", "restoredCount", "matchedCount", "missingCount", "attempt", "requestCount", "estimatedTokens"]) {
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
