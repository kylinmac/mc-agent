/**
 * mc-agent: remaining quota of a subscription (coding plan) account, shown
 * beside the composer. Each service reports its own windows: a 5-hour and a
 * weekly window, only a weekly one, a monthly one, or nothing. The windows
 * are kept as reported and labelled by their length, never by position.
 */
export type SubscriptionQuotaWindow = {
  /** Window length in seconds, when the service reports it. */
  seconds?: number;
  /** Remaining share of the window, 0–100. */
  remainingPercent: number;
  /** When the window resets, epoch milliseconds. */
  resetsAt?: number;
};

export type SubscriptionQuota = {
  /** Which reader produced it: codex, claude, copilot, kimi, glm, minimax, xai. */
  source: string;
  windows: SubscriptionQuotaWindow[];
  fetchedAt: number;
};

const HOUR = 3600;
const DAY = 24 * HOUR;

/** The label kind for a window length: hours, a day, a week, a month, or days. */
export function subscriptionQuotaWindowKind(
  seconds: number | undefined,
): { kind: "hours" | "day" | "week" | "month" | "days" | "unknown"; count?: number } {
  if (!seconds || !Number.isFinite(seconds) || seconds <= 0) return { kind: "unknown" };
  if (seconds < DAY) return { kind: "hours", count: Math.max(1, Math.round(seconds / HOUR)) };
  const days = Math.round(seconds / DAY);
  if (days === 1) return { kind: "day" };
  if (days === 7) return { kind: "week" };
  if (days >= 28 && days <= 31) return { kind: "month" };
  return { kind: "days", count: days };
}
