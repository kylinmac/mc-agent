/*
  mc-agent work-panel panes (MC-ADR-0005): the panel's tabs are grouped by
  tool into stacked panes, each with its own tabs, collapse state and height.
  The tab list itself stays upstream's per-session state; panes are derived
  from it, and only the layout (order, heights, collapsed) is stored here,
  globally, in localStorage.

  Pure functions, no imports, so Node tests can load this file directly.
*/

export type PaneId = "terminal" | "browser" | "files" | "review" | "other";

export const PANE_IDS: readonly PaneId[] = ["terminal", "browser", "files", "review", "other"];

/** The fields of a work-panel tab the grouping reads. */
export type PaneTab = { id: string; kind: string; resource?: string };

export const BROWSER_VIEW_REF = "pi.browser/browser";
export const FILES_VIEW_REF = "pi.file-manager/manager";

export function paneOf(tab: PaneTab): PaneId {
  if (tab.kind === "terminal") return "terminal";
  if (tab.kind === "review") return "review";
  if (tab.kind === "file") return "files";
  if (tab.kind === "plugin" && tab.resource === BROWSER_VIEW_REF) return "browser";
  if (tab.kind === "plugin" && tab.resource === FILES_VIEW_REF) return "files";
  return "other";
}

export type PanePrefs = {
  order: PaneId[];
  collapsed: PaneId[];
  /** Relative heights (flex weights) of expanded panes. */
  sizes: Partial<Record<PaneId, number>>;
};

export const DEFAULT_PANE_PREFS: PanePrefs = { order: [...PANE_IDS], collapsed: [], sizes: {} };

export const MIN_PANE_HEIGHT = 96;
const MIN_WEIGHT = 0.05;
const MAX_WEIGHT = 20;

function isPaneId(value: unknown): value is PaneId {
  return typeof value === "string" && (PANE_IDS as readonly string[]).includes(value);
}

/** Accept anything; keep only known panes, every pane exactly once in order. */
export function normalizePanePrefs(value: unknown): PanePrefs {
  const raw = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
  const order = Array.isArray(raw.order) ? raw.order.filter(isPaneId) : [];
  const uniqueOrder = [...new Set(order)];
  for (const id of PANE_IDS) if (!uniqueOrder.includes(id)) uniqueOrder.push(id);
  const collapsed = Array.isArray(raw.collapsed) ? [...new Set(raw.collapsed.filter(isPaneId))] : [];
  const sizes: PanePrefs["sizes"] = {};
  const rawSizes = (raw.sizes && typeof raw.sizes === "object" ? raw.sizes : {}) as Record<string, unknown>;
  for (const id of PANE_IDS) {
    const size = rawSizes[id];
    if (typeof size === "number" && Number.isFinite(size)) {
      sizes[id] = Math.min(MAX_WEIGHT, Math.max(MIN_WEIGHT, size));
    }
  }
  return { order: uniqueOrder, collapsed, sizes };
}

export type PaneGroup<T extends PaneTab> = { id: PaneId; tabs: T[] };

/** The panes that have tabs, in the user's order; tabs keep their list order. */
export function groupPanes<T extends PaneTab>(tabs: readonly T[], order: readonly PaneId[]): PaneGroup<T>[] {
  const byPane = new Map<PaneId, T[]>();
  for (const tab of tabs) {
    const id = paneOf(tab);
    const list = byPane.get(id) ?? [];
    list.push(tab);
    byPane.set(id, list);
  }
  return order.filter((id) => byPane.has(id)).map((id) => ({ id, tabs: byPane.get(id) ?? [] }));
}

/**
 * The tab a pane shows: the one the user last selected in it, else the
 * newest tab in the pane.
 */
export function paneActiveTab<T extends PaneTab>(tabs: readonly T[], remembered: string | undefined): T | undefined {
  return tabs.find((tab) => tab.id === remembered) ?? tabs.at(-1);
}

/** Move `source` before or after `target` in the pane order. */
export function movePane(order: readonly PaneId[], source: PaneId, target: PaneId, after: boolean): PaneId[] {
  if (source === target) return [...order];
  const next = order.filter((id) => id !== source);
  const index = next.indexOf(target);
  if (index < 0) return [...order];
  next.splice(index + (after ? 1 : 0), 0, source);
  return next;
}

export function togglePaneCollapsed(collapsed: readonly PaneId[], id: PaneId): PaneId[] {
  return collapsed.includes(id) ? collapsed.filter((item) => item !== id) : [...collapsed, id];
}

/**
 * Drag the divider between two expanded panes by `delta` pixels. Their
 * combined weight and height stay the same; each keeps at least
 * MIN_PANE_HEIGHT (or half the pair, when the pair is smaller than that).
 */
export function resizePanePair(
  pair: { weightA: number; weightB: number; heightA: number; heightB: number },
  delta: number,
): { weightA: number; weightB: number } {
  const totalHeight = pair.heightA + pair.heightB;
  const totalWeight = pair.weightA + pair.weightB;
  if (totalHeight <= 0 || totalWeight <= 0) return { weightA: pair.weightA, weightB: pair.weightB };
  const floor = Math.min(MIN_PANE_HEIGHT, totalHeight / 2);
  const heightA = Math.min(totalHeight - floor, Math.max(floor, pair.heightA + delta));
  const weightA = (totalWeight * heightA) / totalHeight;
  return { weightA, weightB: totalWeight - weightA };
}

/**
 * Flex-grow for the expanded panes. Stored weights are relative; CSS fills
 * only a fraction of the space when the grows sum below 1 (one pane left with
 * a small weight after its neighbour closed), so they are scaled to sum to
 * the number of panes.
 */
export function paneFlexGrow(
  expanded: readonly PaneId[],
  sizes: PanePrefs["sizes"],
): Partial<Record<PaneId, number>> {
  const weights = expanded.map((id) => sizes[id] ?? 1);
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  const grows: Partial<Record<PaneId, number>> = {};
  expanded.forEach((id, index) => {
    grows[id] = total > 0 ? ((weights[index] ?? 1) * expanded.length) / total : 1;
  });
  return grows;
}

/** Which pane a pointer at `y` drops onto, given each pane's vertical span. */
export function paneDropTarget(
  y: number,
  rects: readonly { id: PaneId; top: number; bottom: number }[],
): { id: PaneId; after: boolean } | null {
  for (const rect of rects) {
    if (y < rect.top || y > rect.bottom) continue;
    return { id: rect.id, after: y > (rect.top + rect.bottom) / 2 };
  }
  const last = rects.at(-1);
  if (last && y > last.bottom) return { id: last.id, after: true };
  const first = rects[0];
  if (first && y < first.top) return { id: first.id, after: false };
  return null;
}

const STORAGE_KEY = "mc.workPanes";

export function readPanePrefs(): PanePrefs {
  try {
    const raw = globalThis.localStorage?.getItem(STORAGE_KEY);
    return normalizePanePrefs(raw ? JSON.parse(raw) : null);
  } catch {
    return normalizePanePrefs(null);
  }
}

export function savePanePrefs(prefs: PanePrefs): void {
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(prefs));
  } catch {
    // Storage can be unavailable; the layout still works for this run.
  }
}
