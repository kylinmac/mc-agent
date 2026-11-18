import { useEffect, useMemo, useState } from "react";
import { create } from "zustand";
import { useSplitView } from "../../lib/mc-split-view";
import { listableSessions } from "../../lib/session-origin";
import { useAppStore } from "../../stores/app-store";
import { useReviewAnnotations } from "../review-annotations/review-annotations";
import {
  stepAttentionTrackerState,
  type AttentionNotificationLike,
  type AttentionOutcomeLike,
  type AttentionTurnResultLike,
  type AttentionVisibleState,
} from "./attention-model";

const STORAGE_KEY = "mc.attentionUnread";
const SEEN_NOTIF_STORAGE_KEY = "mc.attentionSeenNotifications";
const MAX_SEEN_NOTIFICATIONS = 400;

function readStoredUnread(): Record<string, number> {
  try {
    if (typeof sessionStorage === "undefined") return {};
    const parsed = JSON.parse(sessionStorage.getItem(STORAGE_KEY) ?? "{}") as unknown;
    if (!parsed || typeof parsed !== "object") return {};
    return Object.fromEntries(
      Object.entries(parsed).filter(
        (entry): entry is [string, number] => typeof entry[1] === "number" && Number.isFinite(entry[1]),
      ),
    );
  } catch {
    return {};
  }
}

function writeStoredUnread(unread: Record<string, number>): void {
  try {
    if (typeof sessionStorage === "undefined") return;
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(unread));
  } catch {
    // best-effort session persistence
  }
}

function readStoredSeenNotifications(): Set<string> {
  try {
    if (typeof sessionStorage === "undefined") return new Set();
    const parsed = JSON.parse(sessionStorage.getItem(SEEN_NOTIF_STORAGE_KEY) ?? "[]") as unknown;
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((id): id is string => typeof id === "string" && id.length > 0));
  } catch {
    return new Set();
  }
}

function writeStoredSeenNotifications(ids: ReadonlySet<string>): void {
  try {
    if (typeof sessionStorage === "undefined") return;
    const bounded = [...ids].slice(-MAX_SEEN_NOTIFICATIONS);
    sessionStorage.setItem(SEEN_NOTIF_STORAGE_KEY, JSON.stringify(bounded));
  } catch {
    // best-effort session persistence
  }
}

type AttentionStoreState = {
  unreadCompleted: Record<string, number>;
  prevRunning: Record<string, boolean>;
  seenNotificationIds: Set<string>;
  outcomeBackedSessionIds: Set<string>;
  reconcile: (params: {
    liveRunning: Record<string, boolean>;
    visible: AttentionVisibleState;
    existingSessionIds: ReadonlySet<string>;
    latestTurnResults?: Readonly<Record<string, AttentionTurnResultLike | undefined>>;
    sessionOutcomes?: Readonly<Record<string, AttentionOutcomeLike | undefined>>;
    notifications?: readonly AttentionNotificationLike[];
    now?: number;
  }) => string[];
  clearUnread: () => string[];
};

export const useAttentionStore = create<AttentionStoreState>((set, get) => ({
  unreadCompleted: readStoredUnread(),
  prevRunning: {},
  seenNotificationIds: readStoredSeenNotifications(),
  outcomeBackedSessionIds: new Set(),
  reconcile: (params) => {
    let acknowledgedIds: string[] = [];
    set((state) => {
      const next = stepAttentionTrackerState(state, params);
      acknowledgedIds = next.acknowledgedSessionIds;
      if (next.unreadChanged) writeStoredUnread(next.unreadCompleted);
      if (next.seenChanged) writeStoredSeenNotifications(next.seenNotificationIds);
      return {
        unreadCompleted: next.unreadCompleted,
        prevRunning: next.prevRunning,
        seenNotificationIds: next.seenNotificationIds,
        outcomeBackedSessionIds: next.outcomeBackedSessionIds,
      };
    });
    return acknowledgedIds;
  },
  clearUnread: () => {
    const clearedSessionIds = Object.keys(get().unreadCompleted);
    writeStoredUnread({});
    set({ unreadCompleted: {}, outcomeBackedSessionIds: new Set() });
    return clearedSessionIds;
  },
}));

/**
 * Mark all completed items in the attention feed as read AND synchronize the
 * corresponding sidebar `sessionOutcomes` and unread `NotificationCenter` items.
 */
export function acknowledgeAllAttentionUnread(): void {
  const clearedIds = useAttentionStore.getState().clearUnread();
  const acknowledge = useAppStore.getState().acknowledgeSessionOutcome;
  for (const sessionId of clearedIds) {
    void acknowledge(sessionId).catch(() => undefined);
  }
}

function readWindowActivelyViewing(): boolean {
  if (typeof document === "undefined") return true;
  if (document.visibilityState === "hidden") return false;
  return typeof document.hasFocus === "function" ? document.hasFocus() : true;
}

function useWindowActivelyViewing(): boolean {
  const [activelyViewing, setActivelyViewing] = useState(readWindowActivelyViewing);
  useEffect(() => {
    if (typeof document === "undefined" || typeof window === "undefined") return;
    const sync = () => setActivelyViewing(readWindowActivelyViewing());
    sync();
    document.addEventListener("visibilitychange", sync);
    window.addEventListener("focus", sync);
    window.addEventListener("blur", sync);
    return () => {
      document.removeEventListener("visibilitychange", sync);
      window.removeEventListener("focus", sync);
      window.removeEventListener("blur", sync);
    };
  }, []);
  return activelyViewing;
}

/**
 * Always-mounted shell watcher (rendered in `AppShell`, outside `<Sidebar />`)
 * so background turn completions are recorded across sidebar collapses,
 * maximized work panels, window minimization/blur, and reload hydration.
 */
export function AttentionFeedWatcher({
  chatSurfaceVisible,
}: {
  chatSurfaceVisible: boolean;
}) {
  const activelyViewing = useWindowActivelyViewing();
  const ready = useAppStore((s) => s.ready);
  const page = useAppStore((s) => s.page);
  const activeSessionId = useAppStore((s) => s.activeSessionId);
  const visiblePaneId = useAppStore((s) => s.retainedSessionIds[0] ?? null);
  const isRunning = useAppStore((s) => s.isRunning);
  const runningSessions = useAppStore((s) => s.runningSessions);
  const latestTurnResults = useAppStore((s) => s.latestTurnResults);
  const sessionOutcomes = useAppStore((s) => s.sessionOutcomes);
  const notifications = useAppStore((s) => s.notifications);
  const sessions = useAppStore((s) => s.sessions);
  const acknowledgeSessionOutcome = useAppStore((s) => s.acknowledgeSessionOutcome);
  const splitColumns = useSplitView((s) => s.columns);
  const reconcile = useAttentionStore((s) => s.reconcile);
  const pruneAnnotationSessions = useReviewAnnotations((s) => s.pruneSessions);

  const liveRunning = useMemo(() => {
    const map: Record<string, boolean> = {};
    for (const [id, running] of Object.entries(runningSessions)) {
      if (running) map[id] = true;
    }
    if (activeSessionId && isRunning) map[activeSessionId] = true;
    return map;
  }, [runningSessions, activeSessionId, isRunning]);

  const effectiveChatVisible = chatSurfaceVisible && activelyViewing;

  useEffect(() => {
    if (!ready) return;
    const retainedIds = new Set<string>(sessions.map((item) => item.id));
    if (activeSessionId) retainedIds.add(activeSessionId);
    for (const colId of splitColumns) {
      if (colId) retainedIds.add(colId);
    }
    pruneAnnotationSessions(retainedIds);
  }, [ready, sessions, activeSessionId, splitColumns, pruneAnnotationSessions]);

  useEffect(() => {
    const existingSessionIds = new Set(listableSessions(sessions).map((item) => item.id));
    const acknowledgedIds = reconcile({
      liveRunning,
      visible: {
        page,
        chatSurfaceVisible: effectiveChatVisible,
        activeSessionId,
        visibleSessionId: visiblePaneId,
        splitColumns,
      },
      existingSessionIds,
      latestTurnResults,
      sessionOutcomes,
      notifications,
    });
    for (const id of acknowledgedIds) {
      void acknowledgeSessionOutcome(id).catch(() => undefined);
    }
  }, [
    liveRunning,
    page,
    effectiveChatVisible,
    activeSessionId,
    visiblePaneId,
    splitColumns,
    sessions,
    latestTurnResults,
    sessionOutcomes,
    notifications,
    reconcile,
    acknowledgeSessionOutcome,
  ]);

  return null;
}
