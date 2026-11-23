import type { ThinkingLevel, UiMessage } from "@pi-desktop/shared";
import { THINKING_LEVELS } from "@pi-desktop/shared";
import { toolResultPayload } from "../../../lib/tool-presentation";

/** Effective model resolved for this delegation, recorded by the Task result. */
export function delegateModelId(message: UiMessage): string {
  const payload = toolResultPayload(message);
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return "";
  }
  const modelId = (payload as { modelId?: unknown }).modelId;
  return typeof modelId === "string" ? modelId.trim() : "";
}

/** Effective thinking level resolved for this delegation, from the Task result.
 * `off` and `omit` deliberately have no visible suffix. */
export function delegateThinkingLevel(message: UiMessage): ThinkingLevel | undefined {
  const payload = toolResultPayload(message);
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return undefined;
  }
  const value = (payload as { thinkingLevel?: unknown }).thinkingLevel;
  if (
    typeof value !== "string" ||
    value === "off" ||
    !THINKING_LEVELS.includes(value as ThinkingLevel)
  ) {
    return undefined;
  }
  return value as ThinkingLevel;
}

/**
 * Copies a run row's command from its head. The expanded body holds only the
 * output, so this is the one place the command can be taken from (D226).
 */
