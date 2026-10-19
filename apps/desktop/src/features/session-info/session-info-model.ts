import type { SessionContextBreakdown } from "@pi-desktop/shared";

/** Docked width bounds; the conversation keeps at least this much beside it. */
export const PANEL_MIN_WIDTH = 240;
export const PANEL_MAX_WIDTH = 480;
export const PANEL_DEFAULT_WIDTH = 300;
const MIN_CONVERSATION_WIDTH = 560;

export function clampPanelWidth(width: number): number {
  return Math.round(Math.min(PANEL_MAX_WIDTH, Math.max(PANEL_MIN_WIDTH, width)));
}

/** Dock when the conversation keeps a usable width beside the panel. */
export function panelMode(paneWidth: number, panelWidth = PANEL_DEFAULT_WIDTH): "docked" | "overlay" {
  return paneWidth >= panelWidth + MIN_CONVERSATION_WIDTH ? "docked" : "overlay";
}

export const SECTION_IDS = ["environment", "context", "changes", "workers", "connectors"] as const;
export type SectionId = (typeof SECTION_IDS)[number];

export type PanelPrefs = {
  open: boolean;
  width: number;
  order: SectionId[];
  hidden: SectionId[];
  collapsed: SectionId[];
};

export const DEFAULT_PREFS: PanelPrefs = {
  open: false,
  width: PANEL_DEFAULT_WIDTH,
  order: [...SECTION_IDS],
  hidden: [],
  collapsed: [],
};

function sectionList(value: unknown): SectionId[] {
  return Array.isArray(value)
    ? value.filter((id): id is SectionId => (SECTION_IDS as readonly string[]).includes(id as string))
    : [];
}

/** Stored preferences, repaired: unknown ids dropped, missing ones appended. */
export function normalizePrefs(value: unknown): PanelPrefs {
  if (!value || typeof value !== "object") return { ...DEFAULT_PREFS, order: [...SECTION_IDS] };
  const raw = value as Record<string, unknown>;
  const order = [...new Set(sectionList(raw.order))];
  for (const id of SECTION_IDS) if (!order.includes(id)) order.push(id);
  return {
    open: raw.open === true,
    width: clampPanelWidth(typeof raw.width === "number" ? raw.width : PANEL_DEFAULT_WIDTH),
    order,
    hidden: sectionList(raw.hidden),
    collapsed: sectionList(raw.collapsed),
  };
}

/** Move `moved` to `target`'s place (before it when coming from below). */
export function reorderSections(order: readonly SectionId[], moved: SectionId, target: SectionId): SectionId[] {
  if (moved === target) return [...order];
  const without = order.filter((id) => id !== moved);
  const at = without.indexOf(target);
  const from = order.indexOf(moved);
  const to = order.indexOf(target);
  without.splice(from < to ? at + 1 : at, 0, moved);
  return without;
}

export function toggleIn(list: readonly SectionId[], id: SectionId): SectionId[] {
  return list.includes(id) ? list.filter((item) => item !== id) : [...list, id];
}

export type BreakdownRowKey =
  | "messages"
  | "systemPrompt"
  | "tools"
  | "mcpTools"
  | "skills"
  | "projectInstructions"
  | "memory"
  | "buffer"
  | "free";

export type BreakdownRow = { key: BreakdownRowKey; tokens: number; percent: number; count?: number };

/**
 * Rows in the order the panel lists them, as shares of the model window:
 * each kind, then the auto-compact buffer (window above the compaction
 * threshold) and what is left free below it.
 */
export function breakdownRows(breakdown: SessionContextBreakdown): BreakdownRow[] {
  const window = Math.max(1, breakdown.contextWindow);
  const c = breakdown.categories;
  const share = (tokens: number) => (tokens / window) * 100;
  const kinds: BreakdownRow[] = [
    { key: "messages", tokens: c.messages, percent: share(c.messages), count: breakdown.messageCount },
    { key: "systemPrompt", tokens: c.systemPrompt, percent: share(c.systemPrompt) },
    { key: "tools", tokens: c.tools, percent: share(c.tools), count: breakdown.toolCount },
    { key: "mcpTools", tokens: c.mcpTools, percent: share(c.mcpTools), count: breakdown.mcpToolCount },
    { key: "skills", tokens: c.skills, percent: share(c.skills), count: breakdown.skillCount },
    { key: "projectInstructions", tokens: c.projectInstructions, percent: share(c.projectInstructions) },
    { key: "memory", tokens: c.memory, percent: share(c.memory) },
  ];
  const buffer = Math.max(0, window - breakdown.autoCompactAt);
  const free = Math.max(0, window - buffer - breakdown.usedTokens);
  return [
    ...kinds,
    { key: "buffer", tokens: buffer, percent: share(buffer) },
    { key: "free", tokens: free, percent: share(free) },
  ];
}

const STORAGE_KEY = "mc.sessionInfo";

export function readPrefs(): PanelPrefs {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return normalizePrefs(raw ? JSON.parse(raw) : null);
  } catch {
    return normalizePrefs(null);
  }
}

export function savePrefs(prefs: PanelPrefs): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
  } catch {
    // Without storage the panel keeps its layout for this window only.
  }
}
