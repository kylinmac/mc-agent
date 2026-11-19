import type { SessionContextBreakdown } from "@pi-desktop/shared";

/** Docked width bounds; the conversation keeps at least this much beside it. */
export const PANEL_MIN_WIDTH = 240;
export const PANEL_MAX_WIDTH = 480;
export const PANEL_DEFAULT_WIDTH = 300;
const MIN_CONVERSATION_WIDTH = 560;

export function clampPanelWidth(width: number): number {
  return Math.round(Math.min(PANEL_MAX_WIDTH, Math.max(PANEL_MIN_WIDTH, width)));
}

/** Space kept between the docked panel and the conversation band. */
export const DOCK_GAP = 16;

/**
 * How far the conversation moves aside for the docked panel. The panel sits
 * in the empty margin left of the centered conversation band; the band moves
 * right only by what the panel would overlap, keeping its width while the
 * pane allows, and never moves further than the panel's own width.
 */
export function conversationOffset(paneWidth: number, panelWidth: number, contentWidth: number): number {
  const reserve = panelWidth + DOCK_GAP;
  const band = Math.min(contentWidth, paneWidth);
  return Math.round(Math.max(0, Math.min(reserve, 2 * reserve - (paneWidth - band))));
}

/** Dock when the conversation keeps a usable width beside the panel. */
export function panelMode(paneWidth: number, panelWidth = PANEL_DEFAULT_WIDTH): "docked" | "overlay" {
  return paneWidth >= panelWidth + MIN_CONVERSATION_WIDTH ? "docked" : "overlay";
}

export const SECTION_IDS = ["environment", "context", "changes", "workers", "background", "connectors"] as const;
export type SectionId = (typeof SECTION_IDS)[number];

export type SessionStartSignals = {
  sessionId?: string | null;
  isRunning: boolean;
  hasTranscriptMessages: boolean;
  transcriptLoaded: boolean;
  summaryMessageCount?: number;
  hasPendingInteraction?: boolean;
  compactionCount?: number;
  messageParentCount?: number;
};

/**
 * Whether a conversation has started so its session info button/panel should
 * mount. Newly created empty conversations stay completely free of session
 * statistics and left-margin reservations until the first turn begins.
 */
export function hasSessionConversationStarted(signals: SessionStartSignals): boolean {
  if (!signals.sessionId) return false;
  if (
    signals.isRunning ||
    signals.hasTranscriptMessages ||
    signals.hasPendingInteraction ||
    (signals.compactionCount ?? 0) > 0 ||
    (signals.messageParentCount ?? 0) > 0
  ) {
    return true;
  }
  if (!signals.transcriptLoaded && (signals.summaryMessageCount ?? 0) > 0) {
    return true;
  }
  return false;
}

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
  // A section added in a later version lands at its default place (after
  // the section it follows by default), not at the end of a saved order.
  SECTION_IDS.forEach((id, index) => {
    if (order.includes(id)) return;
    const before = SECTION_IDS.slice(0, index).reverse().find((candidate) => order.includes(candidate));
    order.splice(before ? order.indexOf(before) + 1 : 0, 0, id);
  });
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
 * mc-agent (bugs.md B-002): the rows before the numbers arrive (the runtime
 * has not estimated yet, or the request is in flight). The list is always
 * drawn; unknown values read as "?".
 */
export const PENDING_BREAKDOWN_ROWS: readonly BreakdownRow[] = (
  ["messages", "systemPrompt", "tools", "mcpTools", "skills", "projectInstructions", "memory", "buffer", "free"] as const
).map((key) => ({ key, tokens: Number.NaN, percent: Number.NaN }));

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
const OPEN_KEY = "mc.sessionInfoOpen";
const OPEN_KEEP = 200;

export function readPrefs(): PanelPrefs {
  try {
    const raw = globalThis.localStorage?.getItem(STORAGE_KEY);
    return normalizePrefs(raw ? JSON.parse(raw) : null);
  } catch {
    return normalizePrefs(null);
  }
}

export function savePrefs(prefs: PanelPrefs): void {
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(prefs));
  } catch {
    // Without storage the panel keeps its layout for this window only.
  }
}

/** Whether the panel is open, per conversation; the last choice is the default for others. */
export function readOpenMap(): Record<string, boolean> {
  try {
    const raw = JSON.parse(globalThis.localStorage?.getItem(OPEN_KEY) ?? "{}") as unknown;
    if (!raw || typeof raw !== "object") return {};
    return Object.fromEntries(
      Object.entries(raw).filter((entry): entry is [string, boolean] => typeof entry[1] === "boolean"),
    );
  } catch {
    return {};
  }
}

export function saveOpenMap(map: Record<string, boolean>): void {
  try {
    globalThis.localStorage?.setItem(
      OPEN_KEY,
      JSON.stringify(Object.fromEntries(Object.entries(map).slice(-OPEN_KEEP))),
    );
  } catch {
    // best-effort persistence
  }
}

const sessionInfoListeners = new Set<(changedSessionId?: string) => void>();

export function subscribeSessionInfoOpen(listener: (changedSessionId?: string) => void): () => void {
  sessionInfoListeners.add(listener);
  return () => {
    sessionInfoListeners.delete(listener);
  };
}

export function notifySessionInfoChange(changedSessionId?: string): void {
  for (const listener of sessionInfoListeners) listener(changedSessionId);
}

export function isSessionInfoOpenFor(
  sessionId: string | undefined,
  openMap: Record<string, boolean>,
  prefs: PanelPrefs,
): boolean {
  return sessionId !== undefined && openMap[sessionId] !== undefined ? openMap[sessionId] : prefs.open;
}

export function setSessionInfoOpenForSession(sessionId: string | undefined, value: boolean): boolean {
  if (sessionId) {
    const current = readOpenMap();
    const { [sessionId]: _previous, ...rest } = current;
    saveOpenMap({ ...rest, [sessionId]: value });
  }
  const currentPrefs = readPrefs();
  savePrefs({ ...currentPrefs, open: value });
  notifySessionInfoChange(sessionId);
  return value;
}

export function toggleSessionInfoOpenForSession(sessionId: string): boolean {
  const openMap = readOpenMap();
  const prefs = readPrefs();
  const next = !isSessionInfoOpenFor(sessionId, openMap, prefs);
  return setSessionInfoOpenForSession(sessionId, next);
}
