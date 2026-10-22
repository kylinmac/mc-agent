import { create } from "zustand";
import { registerSessionHoldSource } from "./session-holds.ts";

/*
  mc-agent split view (MC-ADR-0007): conversations side by side, after an
  editor's groups. `columns` holds the session ids on screen from left to
  right; an empty list means one conversation, as upstream. The focused column
  is always the store's active session, so the composer, the work panel and
  every per-session action keep following `activeSessionId`; the other
  columns are retained session panes (ADR 0137) that stream live.

  "" stands for a new task that has no session yet, so starting one in a
  column keeps the split instead of collapsing it.
*/

export const SPLIT_MAX_COLUMNS = 3;
export const SPLIT_MIN_WEIGHT = 0.4;

/** Opens `id` beside the focused column; a full split replaces the last other column. */
export function openColumnRight(
  columns: readonly string[],
  active: string | null | undefined,
  id: string,
  max = SPLIT_MAX_COLUMNS,
): string[] {
  const focused = active ?? "";
  const base = columns.length ? [...columns] : [focused];
  if (base.includes(id)) return base;
  const at = Math.max(0, base.indexOf(focused));
  if (base.length >= max) {
    // Replace the rightmost column that is not the focused one.
    const victim = base.length - 1 === at ? base.length - 2 : base.length - 1;
    base[victim] = id;
    return base;
  }
  base.splice(at + 1, 0, id);
  return base;
}

/**
 * The active session changed (a title-bar tab, the sidebar, a new task): a
 * session already on screen just takes focus, any other replaces the column
 * that had focus, as an editor group opens a file in the active group.
 */
export function followActive(
  columns: readonly string[],
  previous: string | null | undefined,
  next: string | null | undefined,
): readonly string[] {
  if (columns.length < 2) return columns;
  const key = next ?? "";
  if (columns.includes(key)) return columns;
  let at = columns.indexOf(previous ?? "");
  if (at < 0) at = columns.indexOf("");
  if (at < 0) at = 0;
  const result = [...columns];
  result[at] = key;
  return result;
}

/** Removes a column; one left means no split. */
export function closeColumn(columns: readonly string[], id: string): string[] {
  const next = columns.filter((column) => column !== id);
  return next.length < 2 ? [] : next;
}

/** Drops columns whose session is gone. */
export function pruneColumns(columns: readonly string[], known: ReadonlySet<string>): readonly string[] {
  if (!columns.length) return columns;
  const next = columns.filter((column) => column === "" || known.has(column));
  if (next.length === columns.length) return columns;
  return next.length < 2 ? [] : next;
}

/** Equal weights for `count` columns, unless the stored ones still fit. */
export function columnWeights(count: number, stored: readonly number[]): number[] {
  if (stored.length === count && stored.every((weight) => weight >= SPLIT_MIN_WEIGHT)) return [...stored];
  return Array.from({ length: count }, () => 1);
}

/** Moves `delta` pixels from the column right of divider `index` to the one left of it. */
export function resizeColumns(
  weights: readonly number[],
  widths: readonly number[],
  index: number,
  delta: number,
  minWidth = 320,
): number[] {
  const a = widths[index];
  const b = widths[index + 1];
  if (a === undefined || b === undefined) return [...weights];
  const total = a + b;
  const nextA = Math.min(Math.max(a + delta, Math.min(minWidth, total / 2)), total - Math.min(minWidth, total / 2));
  const pair = weights[index] + weights[index + 1];
  const result = [...weights];
  result[index] = (pair * nextA) / total;
  result[index + 1] = pair - result[index];
  return result;
}

type SplitState = {
  columns: readonly string[];
  weights: number[];
  /** A title-bar tab is being dragged over the conversation area. */
  dropHint: boolean;
};

const STORAGE_KEY = "mc.splitView";

/** A stored split, kept only when it still describes one. */
export function normalizeStoredSplit(raw: unknown): { columns: string[]; weights: number[] } {
  const value = (raw ?? {}) as { columns?: unknown; weights?: unknown };
  const columns = Array.isArray(value.columns)
    ? [...new Set(value.columns.filter((id): id is string => typeof id === "string"))].slice(0, SPLIT_MAX_COLUMNS)
    : [];
  if (columns.length < 2) return { columns: [], weights: [] };
  const weights = Array.isArray(value.weights) ? value.weights.filter((weight): weight is number => typeof weight === "number") : [];
  return { columns, weights: columnWeights(columns.length, weights) };
}

function readStored(): { columns: string[]; weights: number[] } {
  try {
    return normalizeStoredSplit(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null"));
  } catch {
    return { columns: [], weights: [] };
  }
}

function save(state: SplitState): void {
  try {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ columns: state.columns, weights: state.weights }),
    );
  } catch {
    // best-effort persistence
  }
}

export const useSplitView = create<SplitState>(() => ({
  ...readStored(),
  dropHint: false,
}));

export function setSplitColumns(columns: readonly string[]): void {
  const state = useSplitView.getState();
  if (columns === state.columns) return;
  useSplitView.setState({
    columns,
    weights: columnWeights(columns.length, columns.length === state.columns.length ? state.weights : []),
  });
  save(useSplitView.getState());
}

export function setSplitWeights(weights: number[]): void {
  useSplitView.setState({ weights });
  save(useSplitView.getState());
}

export function setSplitDropHint(dropHint: boolean): void {
  if (useSplitView.getState().dropHint !== dropHint) useSplitView.setState({ dropHint });
}

export function splitActive(): boolean {
  return useSplitView.getState().columns.length > 1;
}

// The columns on screen are held sessions: their panes are kept beyond the
// retention bound and stream while another column has focus.
registerSessionHoldSource(() => useSplitView.getState().columns);
