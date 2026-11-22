import type {
  Mode,
  PermissionMode,
} from "@pi-desktop/shared";
import { PERMISSION_MODES } from "@pi-desktop/shared";
import type { ComposerPluginPart } from "../../../lib/composer-smart-stop";

export const COMPOSER_MIN_HEIGHT_PX = 28;
export const COMPOSER_MAX_VISIBLE_ROWS = 7;

export const PLACEHOLDER_KEYS = {
  home: [
    "chat.placeholderHome",
    "chat.placeholderHomeHint",
    "chat.placeholderShortcut",
  ],
  docked: [
    "chat.placeholder",
    "chat.placeholderHint",
    "chat.placeholderShortcut",
  ],
} as const;

export const MODE_CYCLE: readonly Mode[] = ["agent", "plan", "goal"];

export const MODE_LABEL_KEYS: Record<Mode, string> = {
  agent: "settings.modeAgent",
  plan: "settings.modePlan",
  goal: "settings.modeGoal",
};

export { PERMISSION_MODE_I18N_KEYS } from "../../../lib/permission-mode-labels.ts";

export type ComposerPrefill = {
  text: string;
  token: number;
};

export type ComposerFileReference = {
  id: string;
  sessionId: string;
  path: string;
  name: string;
  kind: "image" | "file" | "session";
  mimeType?: string;
  token?: string;
  plugin?: ComposerPluginPart;
};

export function isPermissionMode(value: unknown): value is PermissionMode {
  return (
    typeof value === "string" &&
    PERMISSION_MODES.includes(value as PermissionMode)
  );
}

export function cssPixels(value: string): number {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : 0;
}
