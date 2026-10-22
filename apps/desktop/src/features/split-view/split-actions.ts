import { useEffect } from "react";
import type { WorkPanelTab } from "../../stores/app-store";
import { useHeldTranscript } from "../../lib/use-held-session";
import { useAppStore } from "../../stores/app-store";
import {
  closeColumn,
  followActive,
  openColumnRight,
  pruneColumns,
  setSplitColumns,
  useSplitView,
} from "../../lib/mc-split-view";

/*
  mc-agent split view actions (MC-ADR-0007). Focus is the store's active
  session, so focusing a column is selecting its session.
*/

/**
 * Opens a conversation in a column beside the focused one and focuses it.
 * The conversation already on screen alone moves to the right, with `other`
 * (the one the user was in before) on the left.
 */
export function openSessionRight(id: string, other?: string): void {
  const store = useAppStore.getState();
  const columns = useSplitView.getState().columns;
  if (!columns.length && id === (store.activeSessionId ?? "")) {
    if (!other || other === id) return;
    setSplitColumns([other, id]);
    if (store.page !== "chat") void store.selectSession(id);
    return;
  }
  setSplitColumns(openColumnRight(columns, store.activeSessionId, id));
  if (store.activeSessionId !== id || store.page !== "chat") void store.selectSession(id);
}

export function focusSplitColumn(id: string): void {
  const store = useAppStore.getState();
  if (!id) {
    void store.newSession();
    return;
  }
  if (store.activeSessionId !== id) void store.selectSession(id);
}

/** Closes a column; closing the focused one focuses its left neighbour, else its right one. */
export function closeSplitColumn(id: string): void {
  const columns = useSplitView.getState().columns;
  const index = columns.indexOf(id);
  if (index < 0) return;
  const active = useAppStore.getState().activeSessionId ?? "";
  setSplitColumns(closeColumn(columns, id));
  if (id !== active) return;
  const neighbour = columns[index - 1] ?? columns[index + 1];
  if (neighbour !== undefined) focusSplitColumn(neighbour);
}

/** Opens a column's tool tab: focus the column, then show the tab in its dock. */
export async function openSplitColumnTool(id: string, tab: WorkPanelTab): Promise<void> {
  const store = useAppStore.getState();
  if (store.activeSessionId !== id) await store.selectSession(id);
  const latest = useAppStore.getState();
  if (latest.activeSessionId !== id) return;
  latest.activateWorkPanelTab(tab.id);
  latest.openWorkPanel();
}

/** An unfocused column reads its session's retained pane (session-holds). */
export const useColumnTranscript = useHeldTranscript;

/** Keeps the columns in step with the active session and the session list. */
export function useSplitSync(): void {
  useEffect(() => {
    let previous = useAppStore.getState().activeSessionId;
    let sessions = useAppStore.getState().sessions;
    let booted = false;
    // A split restored at launch focuses its first column, so a column always
    // holds the composer.
    const focusRestoredSplit = (state: ReturnType<typeof useAppStore.getState>) => {
      if (booted || !state.sessions.length) return;
      booted = true;
      const first = useSplitView.getState().columns[0];
      if (!state.activeSessionId && state.page === "chat" && first && state.sessions.some((session) => session.id === first)) {
        void state.selectSession(first);
      }
    };
    focusRestoredSplit(useAppStore.getState());
    return useAppStore.subscribe((state) => {
      if (state.activeSessionId !== previous) {
        const columns = useSplitView.getState().columns;
        setSplitColumns(followActive(columns, previous, state.activeSessionId));
        previous = state.activeSessionId;
      }
      if (state.sessions !== sessions) {
        sessions = state.sessions;
        if (!sessions.length) return;
        focusRestoredSplit(state);
        const known = new Set(sessions.map((session) => session.id));
        if (state.activeSessionId) known.add(state.activeSessionId);
        // Remote sessions are not in the local list.
        for (const column of useSplitView.getState().columns) if (column.startsWith("remote:")) known.add(column);
        setSplitColumns(pruneColumns(useSplitView.getState().columns, known));
      }
    });
  }, []);
}
