
import {
  apiError,
} from "./plugin-host-errors";

const PLUGIN_SESSION_MAX_PAYLOAD_BYTES = 32 * 1024 * 1024;
const PLUGIN_SESSION_MAX_CONTENT_BYTES = 512 * 1024;
const PLUGIN_SESSION_MAX_TOOL_VALUE_BYTES = 256 * 1024;
const PLUGIN_SESSION_MAX_JSON_DEPTH = 8;
const PLUGIN_SESSION_RFC3339 =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

function pluginSessionJsonDepth(value: unknown): number {
  if (Array.isArray(value)) {
    return 1 + Math.max(0, ...value.map(pluginSessionJsonDepth));
  }
  if (value && typeof value === "object") {
    return 1 + Math.max(0, ...Object.values(value).map(pluginSessionJsonDepth));
  }
  return 1;
}

function pluginSessionJsonBytes(value: unknown): number {
  try {
    const serialized = JSON.stringify(value);
    return serialized === undefined ? Number.POSITIVE_INFINITY : new TextEncoder().encode(serialized).byteLength;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

function validatePluginSessionPayload(input: unknown, kind: "import" | "batch" | "other"): void {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw apiError("INVALID_PARAMS", "session input must be an object");
  }
  if (pluginSessionJsonBytes(input) > PLUGIN_SESSION_MAX_PAYLOAD_BYTES) {
    throw apiError("LIMIT_EXCEEDED", "session payload exceeds 32 MiB");
  }
  if (pluginSessionJsonDepth(input) > PLUGIN_SESSION_MAX_JSON_DEPTH) {
    throw apiError("LIMIT_EXCEEDED", "session JSON depth exceeds 8");
  }
  if (kind === "other") return;
  const value = input as Record<string, unknown>;
  const entries = kind === "batch" ? value.sessions : [value];
  if (!Array.isArray(entries)) throw apiError("INVALID_PARAMS", "sessions must be an array");
  if (kind === "batch" && entries.length > 100) {
    throw apiError("LIMIT_EXCEEDED", "session batch exceeds 100 items");
  }
  if (kind === "import" && entries.length > 1) {
    throw apiError("INVALID_PARAMS", "session import accepts one item");
  }
  for (const entry of entries) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw apiError("INVALID_PARAMS", "session item must be an object");
    }
    const item = entry as Record<string, unknown>;
    const title = typeof item.title === "string" ? item.title : "";
    const externalId = typeof item.externalId === "string" ? item.externalId : "";
    if (!title || [...title].length > 200) throw apiError("LIMIT_EXCEEDED", "title is invalid");
    if (!externalId || [...externalId].length > 256) {
      throw apiError("LIMIT_EXCEEDED", "externalId is invalid");
    }
    const createdAt = typeof item.createdAt === "string" ? item.createdAt : "";
    const updatedAt = typeof item.updatedAt === "string" ? item.updatedAt : "";
    const createdMs = Date.parse(createdAt);
    const updatedMs = Date.parse(updatedAt);
    if (!PLUGIN_SESSION_RFC3339.test(createdAt) || Number.isNaN(createdMs)) {
      throw apiError("INVALID_PARAMS", "createdAt must be RFC3339");
    }
    if (!PLUGIN_SESSION_RFC3339.test(updatedAt) || Number.isNaN(updatedMs)) {
      throw apiError("INVALID_PARAMS", "updatedAt must be RFC3339");
    }
    if (createdMs > updatedMs) throw apiError("INVALID_PARAMS", "createdAt is after updatedAt");
    if (!Array.isArray(item.messages) || item.messages.length > 2000) {
      throw apiError("LIMIT_EXCEEDED", "messages must contain at most 2000 items");
    }
    let previous = Number.NEGATIVE_INFINITY;
    for (const message of item.messages) {
      if (!message || typeof message !== "object" || Array.isArray(message)) {
        throw apiError("INVALID_PARAMS", "message must be an object");
      }
      const row = message as Record<string, unknown>;
      if (!["user", "assistant", "tool"].includes(String(row.role))) {
        throw apiError("INVALID_PARAMS", "message role is invalid");
      }
      if (typeof row.content !== "string" || new TextEncoder().encode(row.content).byteLength > PLUGIN_SESSION_MAX_CONTENT_BYTES) {
        throw apiError("LIMIT_EXCEEDED", "message content exceeds 512 KiB");
      }
      const messageAt = typeof row.createdAt === "string" ? row.createdAt : "";
      const messageMs = Date.parse(messageAt);
      if (!PLUGIN_SESSION_RFC3339.test(messageAt) || Number.isNaN(messageMs) || messageMs < previous) {
        throw apiError("INVALID_PARAMS", "message timestamps must be monotonic RFC3339 values");
      }
      previous = messageMs;
      if (row.role === "tool") {
        if (!row.toolName || !row.toolCallId || !["success", "error"].includes(String(row.toolStatus))) {
          throw apiError("INVALID_PARAMS", "tool message fields are invalid");
        }
        for (const field of ["toolArgs", "toolResult"]) {
          if (row[field] !== undefined && pluginSessionJsonBytes(row[field]) > PLUGIN_SESSION_MAX_TOOL_VALUE_BYTES) {
            throw apiError("LIMIT_EXCEEDED", `${field} exceeds 256 KiB`);
          }
        }
      }
    }
  }
}

export function normalizePluginSessionInput(
  input: unknown,
  kind: "import" | "batch" | "other",
): Record<string, unknown> {
  validatePluginSessionPayload(input, kind);
  return { ...(input as Record<string, unknown>) };
}
