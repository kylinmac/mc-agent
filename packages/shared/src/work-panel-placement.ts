/**
 * mc-agent (R11.14): where the work panel sits in a single-column window.
 *
 * `auto` docks it under the conversation in a portrait window, or when the
 * conversation would be narrower than the configured width with the panel
 * beside it; `side` and `bottom` pin it regardless of the window.
 */
export type WorkPanelPlacement = "auto" | "side" | "bottom";

export const DEFAULT_WORK_PANEL_STACK_CHAT_WIDTH = 450;
export const MIN_WORK_PANEL_STACK_CHAT_WIDTH = 450;
export const MAX_WORK_PANEL_STACK_CHAT_WIDTH = 1200;

/** Absent / unknown → `auto`. */
export function resolveWorkPanelPlacement(value: unknown): WorkPanelPlacement {
  return value === "side" || value === "bottom" ? value : "auto";
}

/** Absent / invalid → 450; out-of-range numbers clamp into 450–1200. */
export function resolveWorkPanelStackChatWidth(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return DEFAULT_WORK_PANEL_STACK_CHAT_WIDTH;
  }
  return Math.min(
    MAX_WORK_PANEL_STACK_CHAT_WIDTH,
    Math.max(MIN_WORK_PANEL_STACK_CHAT_WIDTH, Math.round(value)),
  );
}
