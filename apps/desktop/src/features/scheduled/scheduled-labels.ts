import type { TFunction } from "i18next";
import type { ScheduledTask, ScheduledTaskCadence, ScheduledTaskRun } from "@pi-desktop/shared";
import { intervalAmount } from "./scheduled-format";

/** One vocabulary for run status and cadence labels, shared by the rail, the
 * history rows, the detail facts, and the run-content header. */
export const RUN_STATUS_I18N_KEYS: Record<ScheduledTaskRun["status"], string> = {
  running: "scheduled.statusRunning",
  completed: "scheduled.statusCompleted",
  aborted: "scheduled.statusAborted",
  error: "scheduled.statusError",
};

export const CADENCE_I18N_KEYS = {
  manual: "scheduled.cadenceManual",
  hourly: "scheduled.cadenceHourly",
  interval: "scheduled.interval",
  daily: "scheduled.cadenceDaily",
  weekly: "scheduled.cadenceWeekly",
} as const;

/** Only a calendar cadence has a clock to report beside its name: an interval
 * states elapsed minutes, and hourly counts from the moment it was armed. */
export function cadenceHasClock(cadence: ScheduledTaskCadence): boolean {
  return cadence === "daily" || cadence === "weekly";
}

/**
 * A task's cadence in one phrase. An interval carries its own value — that
 * value *is* the schedule — while a calendar cadence is named by its kind and
 * reports its clock separately.
 */
export function cadenceLabel(t: TFunction, task: ScheduledTask, language?: string): string {
  if (task.cadence === "weekly") return weeklyLabel(t, task, language);
  const amount = intervalAmount(task.schedule?.intervalMinutes);
  if (task.cadence !== "interval" || !amount) return t(CADENCE_I18N_KEYS[task.cadence]);
  const value =
    amount.unit === "hours"
      ? t("scheduled.intervalHours", { count: amount.value })
      : t("scheduled.intervalMinutes", { count: amount.value });
  return t("scheduled.intervalEvery", { value });
}

/** Selected days, Monday = 0 (the legacy single `weekday` when absent). */
export function weeklyDays(task: ScheduledTask): number[] {
  const days = task.schedule?.weekdays?.length ? task.schedule.weekdays : [task.schedule?.weekday ?? 0];
  return [...new Set(days.filter((day) => day >= 0 && day <= 6))].sort((a, b) => a - b);
}

/**
 * mc-agent (bugs.md B-005): a weekly cadence names its days — "工作日",
 * "周末", or the days themselves — so Monday-only and Monday–Friday differ.
 */
function weeklyLabel(t: TFunction, task: ScheduledTask, language?: string): string {
  const days = weeklyDays(task);
  const key = days.join(",");
  if (key === "0,1,2,3,4") return t("mcProject.schedEveryWeekday");
  if (key === "5,6") return t("mcProject.schedEveryWeekend");
  if (days.length === 7) return t("scheduled.cadenceDaily");
  // 2026-09-21 is a Monday, matching the editor's day names.
  const names = days.map((day) =>
    new Date(2026, 8, 21 + day).toLocaleDateString(language, { weekday: "short" }),
  );
  return t("mcProject.schedWeeklyOn", { days: names.join(" · ") });
}
