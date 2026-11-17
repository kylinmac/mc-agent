import type { BackgroundShell } from "@pi-desktop/shared";

export type BackgroundRunningStateSlice = {
  activeSessionId?: string | null;
  isRunning: boolean;
  runningSessions: Record<string, boolean>;
};

/** Whether the shared background-shell poller needs an active 2-second timer right now. */
export function shouldPollBackgroundShells(
  wantedIds: Iterable<string>,
  currentLists: Readonly<Record<string, readonly BackgroundShell[]>>,
  appState: BackgroundRunningStateSlice,
): boolean {
  for (const sessionId of wantedIds) {
    if (currentLists[sessionId]?.some((shell) => shell.status === "running")) return true;
    const sessionRunning =
      appState.activeSessionId === sessionId
        ? appState.isRunning
        : Boolean(appState.runningSessions[sessionId]);
    if (sessionRunning) return true;
  }
  return false;
}
