import { useCallback, useEffect, useSyncExternalStore } from "react";
import type { TFunction } from "i18next";
import { subscriptionQuotaWindowKind, type SubscriptionQuotaWindow } from "@pi-desktop/shared";
import { Tooltip } from "../../../components/ui";
import { readSubscriptionQuota, refreshSubscriptionQuota, subscribeSubscriptionQuota } from "./subscription-quota-store";

/*
  mc-agent: the remaining quota of the conversation's subscription account,
  left of the context ring. It shows exactly the windows the service reports
  (a 5-hour and a weekly one, only a monthly one, ...) and nothing for API
  keys or services that report none. Main caches each answer, so asking
  after every reply costs at most one request per few minutes.
*/

/** Below this share left a window is drawn as a warning. */
const LOW_PERCENT = 20;

export function quotaWindowLabel(t: TFunction, window: SubscriptionQuotaWindow): string {
  const { kind, count } = subscriptionQuotaWindowKind(window.seconds);
  if (kind === "hours") return t("mcProject.quotaWindowHours", { count });
  if (kind === "days") return t("mcProject.quotaWindowDays", { count });
  if (kind === "unknown") return t("mcProject.quotaWindowPlan");
  return t(`mcProject.quotaWindow_${kind}`);
}

function resetLabel(t: TFunction, resetsAt: number | undefined): string {
  if (!resetsAt) return "";
  const date = new Date(resetsAt);
  const sameDay = date.toDateString() === new Date().toDateString();
  const time = sameDay
    ? date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : date.toLocaleString([], { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
  return t("mcProject.quotaResets", { time });
}

export function SubscriptionQuotaChip({ t, providerId, runActive }: {
  t: TFunction; providerId?: string; runActive: boolean;
}) {
  const subscribe = useCallback((listener: () => void) => providerId
    ? subscribeSubscriptionQuota(providerId, listener) : () => {}, [providerId]);
  const quota = useSyncExternalStore(subscribe, () => readSubscriptionQuota(providerId), () => null);

  useEffect(() => {
    if (providerId && !runActive) void refreshSubscriptionQuota(providerId);
  }, [providerId, runActive]);

  if (!quota || quota.windows.length === 0) return null;
  const low = quota.windows.some((window) => window.remainingPercent < LOW_PERCENT);
  const lines = [
    t("mcProject.quotaTitle"),
    ...(quota.stale ? [t("mcProject.quotaStale"), t("mcProject.quotaUpdatedAt", {
      time: new Date(quota.fetchedAt).toLocaleString(),
    })] : []),
    ...quota.windows.map((window) => {
      const reset = resetLabel(t, window.resetsAt);
      return `${quotaWindowLabel(t, window)} · ${t("mcProject.quotaRemaining", { percent: Math.round(window.remainingPercent) })}${reset ? ` · ${reset}` : ""}`;
    }),
  ];
  return (
    <Tooltip label={lines.join("\n")} className="mc-quota-chip" tooltipClassName="mc-quota-tooltip">
      <span className="mc-quota-chip-body" data-level={low ? "low" : undefined} aria-label={lines.join("; ")}>
        {quota.windows.map((window, index) => (
          <span key={index} className="mc-quota-window" data-low={window.remainingPercent < LOW_PERCENT ? "true" : undefined}>
            <span className="mc-quota-window-label">{quotaWindowLabel(t, window)}</span>
            <span className="mc-quota-window-value">{Math.round(window.remainingPercent)}%</span>
          </span>
        ))}
        {quota.stale ? <span aria-hidden="true">*</span> : null}
      </span>
    </Tooltip>
  );
}
