import { useEffect, useSyncExternalStore } from "react";
import type { BackgroundShell } from "@pi-desktop/shared";
import { api } from "../../lib/api";

/*
  mc-agent background commands (MC-ADR-0006): one shared poller per window
  for the active session's list, read by the header icon (running count) and
  the background pane. host-core owns the processes; this only mirrors them.
  It polls every 2 seconds while anything subscribes, so a command the agent
  starts or a process that exits shows up without a reload.
*/

const POLL_MS = 2000;

type Snapshot = { sessionId: string | null; shells: BackgroundShell[] };

let snapshot: Snapshot = { sessionId: null, shells: [] };
const listeners = new Set<() => void>();
let subscribers = 0;
let timer: ReturnType<typeof setInterval> | null = null;
let wanted: string | null = null;

function publish(next: Snapshot) {
  snapshot = next;
  for (const listener of listeners) listener();
}

/*
  A request to show one command's output, from the session info panel: the
  background pane expands it and scrolls it into view.
*/
let focusRequest: { id: string; seq: number } | null = null;
const focusListeners = new Set<() => void>();

export function focusBackgroundShell(id: string): void {
  focusRequest = { id, seq: (focusRequest?.seq ?? 0) + 1 };
  for (const listener of focusListeners) listener();
}

export function useBackgroundFocus(): { id: string; seq: number } | null {
  return useSyncExternalStore(
    (listener) => {
      focusListeners.add(listener);
      return () => {
        focusListeners.delete(listener);
      };
    },
    () => focusRequest,
    () => focusRequest,
  );
}

export async function refreshBackgroundShells(): Promise<void> {
  const sessionId = wanted;
  if (!sessionId) {
    if (snapshot.sessionId !== null || snapshot.shells.length) publish({ sessionId: null, shells: [] });
    return;
  }
  try {
    const { shells } = await api.backgroundShellsList(sessionId);
    if (wanted !== sessionId) return;
    const same =
      snapshot.sessionId === sessionId &&
      JSON.stringify(snapshot.shells) === JSON.stringify(shells);
    if (!same) publish({ sessionId, shells });
  } catch {
    if (wanted === sessionId && snapshot.sessionId !== sessionId) publish({ sessionId, shells: [] });
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The active session's background commands, kept fresh while mounted. */
export function useBackgroundShells(sessionId: string | null | undefined): BackgroundShell[] {
  useEffect(() => {
    subscribers += 1;
    if (!timer) timer = setInterval(() => void refreshBackgroundShells(), POLL_MS);
    return () => {
      subscribers -= 1;
      if (subscribers === 0 && timer) {
        clearInterval(timer);
        timer = null;
      }
    };
  }, []);
  useEffect(() => {
    wanted = sessionId ?? null;
    void refreshBackgroundShells();
  }, [sessionId]);
  const current = useSyncExternalStore(subscribe, () => snapshot, () => snapshot);
  return current.sessionId === (sessionId ?? null) ? current.shells : [];
}
