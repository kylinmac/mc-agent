import type { UsageSummary } from "@pi-desktop/shared";

/* mc-agent: helpers for the usage page (MC-ADR-0011). */

export type Range = "today" | "7d" | "30d" | "90d" | "all";
const DAY_MS = 86_400_000;

export function rangeStart(range: Range, now: number): number {
  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);
  const today = startOfToday.getTime();
  switch (range) {
    case "today":
      return today;
    case "7d":
      return today - 6 * DAY_MS;
    case "30d":
      return today - 29 * DAY_MS;
    case "90d":
      return today - 89 * DAY_MS;
    default:
      return 0;
  }
}

export function compactTokens(value: number): string {
  if (value >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(2)}B`;
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(value);
}

function localDay(ms: number): string {
  const date = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** Every day of the range, empty ones included, so the chart keeps its scale. */
export function fillDays(byDay: UsageSummary["byDay"], fromMs: number, toMs: number): UsageSummary["byDay"] {
  if (!byDay.length) return [];
  const known = new Map(byDay.map((day) => [day.day, day]));
  const first = fromMs > 0 ? fromMs : new Date(`${byDay[0].day}T00:00:00`).getTime();
  const out: UsageSummary["byDay"] = [];
  for (let at = first; at <= toMs && out.length < 400; at += DAY_MS) {
    const day = localDay(at);
    out.push(
      known.get(day) ?? {
        day,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        reasoningTokens: 0,
        totalTokens: 0,
        turns: 0,
      },
    );
  }
  return out;
}

export function folderName(path: string | null): string {
  if (!path) return "";
  return path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;
}


/** A model's identity across the summary's tables. */
export function modelKey(row: { providerId: string | null; modelId: string | null }): string {
  return `${row.providerId ?? ""}\u0000${row.modelId ?? ""}`;
}

export const MODEL_SERIES_COLORS = 7;

export type ModelSeries = { key: string; label: string; detail: string | null; color: number; total: number; share: number };

/**
 * The models in share order, each with a color slot; past the palette the
 * smallest fold into one "other" entry (color = -1, key = "").
 */
export function modelSeries(byModel: UsageSummary["byModel"], otherLabel: string, unknownLabel: string): ModelSeries[] {
  const total = byModel.reduce((sum, row) => sum + row.totalTokens, 0) || 1;
  const head = byModel.slice(0, MODEL_SERIES_COLORS).map((row, index) => ({
    key: modelKey(row),
    label: row.modelId || unknownLabel,
    detail: row.providerName || row.providerId,
    color: index,
    total: row.totalTokens,
    share: row.totalTokens / total,
  }));
  const rest = byModel.slice(MODEL_SERIES_COLORS);
  if (!rest.length) return head;
  const restTotal = rest.reduce((sum, row) => sum + row.totalTokens, 0);
  return [...head, { key: "", label: otherLabel, detail: null, color: -1, total: restTotal, share: restTotal / total }];
}

/** Per-day totals of one model (`key`), in `byDay`'s shape. */
export function daysForModel(byDayModel: UsageSummary["byDayModel"], key: string): UsageSummary["byDay"] {
  return byDayModel
    .filter((row) => modelKey(row) === key)
    .map(({ providerId: _provider, modelId: _model, ...day }) => day);
}

/** Each day's tokens per series key; models outside the series count as "" (other). */
export function dayStacks(byDayModel: UsageSummary["byDayModel"], series: readonly ModelSeries[]): Map<string, Map<string, number>> {
  const known = new Set(series.map((entry) => entry.key).filter(Boolean));
  const out = new Map<string, Map<string, number>>();
  for (const row of byDayModel) {
    const key = known.has(modelKey(row)) ? modelKey(row) : "";
    const day = out.get(row.day) ?? new Map<string, number>();
    day.set(key, (day.get(key) ?? 0) + row.totalTokens);
    out.set(row.day, day);
  }
  return out;
}

/** The axis top: the peak rounded up to 1, 2, 2.5 or 5 times a power of ten. */
export function niceCeil(value: number): number {
  if (value <= 0) return 1;
  const power = 10 ** Math.floor(Math.log10(value));
  const step = [1, 2, 2.5, 5, 10].find((candidate) => candidate * power >= value) ?? 10;
  return step * power;
}

/** Every `step`-th day gets an axis label, so at most about eight show. */
export function labelStep(dayCount: number, maxLabels = 8): number {
  return Math.max(1, Math.ceil(dayCount / maxLabels));
}
