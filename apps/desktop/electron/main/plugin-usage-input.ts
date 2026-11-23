
import {
  apiError,
} from "./plugin-host-errors";

/**
 * Bounds for the read-only usage fact listing. The host RPC re-checks the
 * same windows, so a caller that skips this main-process side still cannot
 * widen the scan (spec 07-plugins/03 §usage).
 */
const PLUGIN_USAGE_MAX_WINDOW_MS = 365 * 24 * 60 * 60 * 1000;
const PLUGIN_USAGE_DEFAULT_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

/** Absent/null keeps the host default; anything else must be an integer. */
function pluginUsageProjectId(value: Record<string, unknown>): number | undefined {
  const raw = value.projectId;
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "number" || !Number.isInteger(raw)) {
    throw apiError("INVALID_PARAMS", "projectId must be an integer");
  }
  return raw;
}

/**
 * Mirrors the host-side validation for `usage.listTurns`: absent/null fields
 * stay absent (the host applies the 30-day default window and 200-row page),
 * and anything out of range is rejected here so a plugin sees a plain
 * INVALID_PARAMS instead of a host round-trip. Implied bounds (now / now-30d)
 * are used only to check order and the 365-day cap.
 */
export function normalizePluginUsageListTurnsInput(input: unknown): Record<string, unknown> {
  if (input === undefined || input === null) return {};
  if (typeof input !== "object" || Array.isArray(input)) {
    throw apiError("INVALID_PARAMS", "usage input must be an object");
  }
  const value = input as Record<string, unknown>;
  const normalized: Record<string, unknown> = {};
  const intField = (key: string): number | undefined => {
    const raw = value[key];
    if (raw === undefined || raw === null) return undefined;
    if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 0) {
      throw apiError("INVALID_PARAMS", `${key} must be a non-negative integer`);
    }
    normalized[key] = raw;
    return raw;
  };
  const fromMs = intField("fromMs");
  const toMs = intField("toMs");
  const resolvedTo = toMs ?? Date.now();
  const resolvedFrom = fromMs ?? resolvedTo - PLUGIN_USAGE_DEFAULT_WINDOW_MS;
  if (resolvedTo < resolvedFrom) {
    throw apiError("INVALID_PARAMS", "toMs must be >= fromMs");
  }
  if (resolvedTo - resolvedFrom > PLUGIN_USAGE_MAX_WINDOW_MS) {
    throw apiError("INVALID_PARAMS", "usage window must span at most 365 days");
  }
  if (value.sessionId !== undefined && value.sessionId !== null) {
    if (typeof value.sessionId !== "string" || !value.sessionId.trim()) {
      throw apiError("INVALID_PARAMS", "sessionId must be a non-empty string");
    }
    normalized.sessionId = value.sessionId;
  }
  const projectId = pluginUsageProjectId(value);
  if (projectId !== undefined) normalized.projectId = projectId;
  if (value.cursor !== undefined && value.cursor !== null) {
    if (typeof value.cursor !== "string") {
      throw apiError("INVALID_PARAMS", "cursor must be a string");
    }
    if (value.cursor) normalized.cursor = value.cursor;
  }
  if (value.limit !== undefined && value.limit !== null) {
    const limit = value.limit;
    if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > 500) {
      throw apiError("INVALID_PARAMS", "limit must be an integer between 1 and 500");
    }
    normalized.limit = limit;
  }
  return normalized;
}
