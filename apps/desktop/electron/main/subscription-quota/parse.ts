import type { SubscriptionQuotaWindow } from "@pi-desktop/shared";

/*
  mc-agent: readers for the usage endpoints of subscription accounts. None of
  these endpoints is officially documented; the shapes follow what each
  vendor's own tools and community monitors read. Every reader is lenient:
  a field it does not understand yields no window rather than a guess, and a
  window is identified by its reported length, never by its position.
*/

type Json = Record<string, unknown>;

const HOUR = 3600;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;

function record(value: unknown): Json | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Json) : null;
}

function number(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) return Number(value);
  return undefined;
}

function clampPercent(value: number): number {
  return Math.min(100, Math.max(0, Math.round(value * 10) / 10));
}

/** Epoch seconds, epoch milliseconds or an ISO string, as milliseconds. */
function time(value: unknown): number | undefined {
  const numeric = number(value);
  if (numeric !== undefined) return numeric < 1e12 ? numeric * 1000 : numeric;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function window(
  remainingPercent: number | undefined,
  seconds: number | undefined,
  resetsAt: number | undefined,
): SubscriptionQuotaWindow | null {
  if (remainingPercent === undefined) return null;
  return {
    remainingPercent: clampPercent(remainingPercent),
    ...(seconds ? { seconds } : {}),
    ...(resetsAt ? { resetsAt } : {}),
  };
}

function bySeconds(windows: (SubscriptionQuotaWindow | null)[]): SubscriptionQuotaWindow[] {
  return windows
    .filter((item): item is SubscriptionQuotaWindow => item !== null)
    .sort((a, b) => (a.seconds ?? Infinity) - (b.seconds ?? Infinity));
}

/** ChatGPT / Codex `GET chatgpt.com/backend-api/wham/usage`. */
export function parseCodexUsage(body: unknown): SubscriptionQuotaWindow[] {
  const limits = record(record(body)?.rate_limit);
  if (!limits) return [];
  return bySeconds(["primary_window", "secondary_window"].map((key) => {
    const item = record(limits[key]);
    const used = number(item?.used_percent);
    if (!item || used === undefined) return null;
    const resetAfter = number(item.reset_after_seconds);
    return window(
      100 - used,
      number(item.limit_window_seconds),
      time(item.reset_at) ?? (resetAfter !== undefined ? Date.now() + resetAfter * 1000 : undefined),
    );
  }));
}

/** Claude subscription `GET api.anthropic.com/api/oauth/usage`. */
export function parseClaudeUsage(body: unknown): SubscriptionQuotaWindow[] {
  const data = record(body);
  if (!data) return [];
  return bySeconds(([["five_hour", 5 * HOUR], ["seven_day", WEEK]] as const).map(([key, seconds]) => {
    const item = record(data[key]);
    const used = number(item?.utilization);
    return used === undefined ? null : window(100 - used, seconds, time(item?.resets_at));
  }));
}

/** GitHub Copilot `GET api.github.com/copilot_internal/user`: the monthly premium requests. */
export function parseCopilotUsage(body: unknown): SubscriptionQuotaWindow[] {
  const data = record(body);
  const premium = record(record(data?.quota_snapshots)?.premium_interactions);
  if (!premium || premium.unlimited === true || premium.has_quota === false) return [];
  let remaining = number(premium.percent_remaining);
  if (remaining === undefined) {
    const entitlement = number(premium.entitlement);
    const left = number(premium.remaining);
    if (entitlement && left !== undefined) remaining = (left / entitlement) * 100;
  }
  const resetsAt = time(data?.quota_reset_date_utc) ?? time(data?.quota_reset_date);
  const item = window(remaining, 30 * DAY, resetsAt);
  return item ? [item] : [];
}

const KIMI_UNIT_SECONDS: Record<string, number> = {
  TIME_UNIT_SECOND: 1,
  TIME_UNIT_MINUTE: 60,
  TIME_UNIT_HOUR: HOUR,
  TIME_UNIT_DAY: DAY,
};

function kimiShare(detail: Json | null): number | undefined {
  const limit = number(detail?.limit);
  if (!limit) return undefined;
  const remaining = number(detail?.remaining);
  const used = number(detail?.used);
  const left = remaining ?? (used !== undefined ? limit - used : undefined);
  return left === undefined ? undefined : (left / limit) * 100;
}

/** Kimi Code `GET api.kimi.com/coding/v1/usages`. */
export function parseKimiUsage(body: unknown): SubscriptionQuotaWindow[] {
  const data = record(body);
  if (!data) return [];
  const windows: (SubscriptionQuotaWindow | null)[] = [];
  for (const row of Array.isArray(data.limits) ? data.limits : []) {
    const entry = record(row);
    const span = record(entry?.window);
    const unit = typeof span?.timeUnit === "string" ? KIMI_UNIT_SECONDS[span.timeUnit] : undefined;
    const duration = number(span?.duration);
    const detail = record(entry?.detail);
    windows.push(window(kimiShare(detail), unit && duration ? unit * duration : undefined, time(detail?.resetTime)));
  }
  // The top-level bucket is the plan's weekly allowance.
  const overall = record(data.usage);
  if (overall) windows.push(window(kimiShare(overall), WEEK, time(overall.resetTime)));
  return bySeconds(windows);
}

/** GLM Coding Plan `GET {api.z.ai | open.bigmodel.cn}/api/monitor/usage/quota/limit`. */
export function parseGlmUsage(body: unknown): SubscriptionQuotaWindow[] {
  const envelope = record(body);
  if (!envelope || envelope.success === false) return [];
  const limits = record(envelope.data)?.limits;
  if (!Array.isArray(limits)) return [];
  // `unit` 3 counts hours and 6 counts weeks; other units are not known well
  // enough to label, so they are left out. `TIME_LIMIT` is the monthly MCP
  // tool quota, not model usage.
  const unitSeconds: Record<number, number> = { 3: HOUR, 6: WEEK };
  return bySeconds(limits.map((row) => {
    const item = record(row);
    if (item?.type !== "TOKENS_LIMIT") return null;
    const unit = number(item.unit);
    const count = number(item.number);
    const seconds = unit !== undefined && unitSeconds[unit] && count ? unitSeconds[unit] * count : undefined;
    if (!seconds) return null;
    const used = number(item.percentage);
    return used === undefined ? null : window(100 - used, seconds, time(item.nextResetTime));
  }));
}

/** MiniMax Token / Coding Plan `GET {api.minimaxi.com | api.minimax.io}/v1/token_plan/remains`. */
export function parseMinimaxUsage(body: unknown): SubscriptionQuotaWindow[] {
  const data = record(body);
  const status = number(record(data?.base_resp)?.status_code);
  if (!data || (status !== undefined && status !== 0)) return [];
  const models = Array.isArray(data.model_remains) ? data.model_remains.map(record).filter(Boolean) as Json[] : [];
  // The plan's general model carries the allowance; a model with no quota at all is skipped.
  const model = models.find((item) => number(item.current_interval_remaining_percent) !== undefined || number(item.current_interval_total_count))
    ?? models[0];
  if (!model) return [];
  const span = (start: unknown, end: unknown, fallback: number) => {
    const from = time(start);
    const to = time(end);
    return from && to && to > from ? Math.round((to - from) / 1000) : fallback;
  };
  // The `usage_count` fields hold what is left, despite their name.
  const share = (percent: unknown, left: unknown, total: unknown) => {
    const direct = number(percent);
    if (direct !== undefined) return direct;
    const all = number(total);
    const remaining = number(left);
    return all && remaining !== undefined ? (remaining / all) * 100 : undefined;
  };
  return bySeconds([
    window(
      share(model.current_interval_remaining_percent, model.current_interval_usage_count, model.current_interval_total_count),
      span(model.start_time, model.end_time, 5 * HOUR),
      time(model.end_time),
    ),
    window(
      share(model.current_weekly_remaining_percent, model.current_weekly_usage_count, model.current_weekly_total_count),
      span(model.weekly_start_time, model.weekly_end_time, WEEK),
      time(model.weekly_end_time),
    ),
  ]);
}

/** The ChatGPT account id inside a Codex access token, for the account header. */
export function codexAccountId(accessToken: string): string | undefined {
  const payload = accessToken.split(".")[1];
  if (!payload) return undefined;
  try {
    const claims = JSON.parse(Buffer.from(payload.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"));
    const id = record(record(claims)?.["https://api.openai.com/auth"])?.chatgpt_account_id;
    return typeof id === "string" && id ? id : undefined;
  } catch {
    return undefined;
  }
}
