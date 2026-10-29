import type { AgentActivity } from "@pi-desktop/shared";

export function compactionProgressLabel(
  activity: Extract<AgentActivity, { phase: "compacting" }>,
  t: (key: string, options?: Record<string, unknown>) => string,
): string {
  switch (activity.stage) {
    case "waiting": return t("chat.compactionWaiting");
    case "generating": return t("chat.compactionGenerating");
    case "retrying": return t("chat.compactionRetrying", { attempt: activity.attempt ?? 2 });
    default: return t("chat.compactingContext");
  }
}
