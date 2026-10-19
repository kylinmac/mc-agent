import { useEffect, useSyncExternalStore } from "react";
import type { BackgroundShell } from "@pi-desktop/shared";
import { api } from "../../lib/api";

/*
  mc-agent background commands (MC-ADR-0006): one shared poller per window,
  read by the header icon (running count), the background pane and the
  session info panels. With conversations side by side (MC-ADR-0007) several
  sessions are watched at once, so the poller keeps one list per session.
  host-core owns the processes; this only mirrors them. It polls every 2
  seconds while anything subscribes, so a command the agent starts or a
  process that exits shows up without a reload.
*/

const POLL_MS = 2000;
const EMPTY: BackgroundShell[] = [];

let lists: Record<string, BackgroundShell[]> = {};
const listeners = new Set<() => void>();
/** How many mounted readers want each session. */
const wanted = new Map<string, number>();
let timer: ReturnType<typeof setInterval> | null = null;

function publish(sessionId: string, shells: BackgroundShell[]) {
  lists = { ...lists, [sessionId]: shells };
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

async function refreshSession(sessionId: string): Promise<void> {
  try {
    const { shells } = await api.backgroundShellsList(sessionId);
    if (!wanted.has(sessionId)) return;
    if (JSON.stringify(lists[sessionId] ?? null) !== JSON.stringify(shells)) publish(sessionId, shells);
  } catch {
    if (wanted.has(sessionId) && !lists[sessionId]) publish(sessionId, EMPTY);
  }
}

export async function refreshBackgroundShells(): Promise<void> {
  await Promise.all([...wanted.keys()].map(refreshSession));
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** A session's background commands, kept fresh while mounted. */
export function useBackgroundShells(sessionId: string | null | undefined): BackgroundShell[] {
  useEffect(() => {
    if (!sessionId) return;
    wanted.set(sessionId, (wanted.get(sessionId) ?? 0) + 1);
    if (!timer) timer = setInterval(() => void refreshBackgroundShells(), POLL_MS);
    void refreshSession(sessionId);
    return () => {
      const count = (wanted.get(sessionId) ?? 1) - 1;
      if (count > 0) wanted.set(sessionId, count);
      else {
        wanted.delete(sessionId);
        const { [sessionId]: _dropped, ...rest } = lists;
        lists = rest;
      }
      if (wanted.size === 0 && timer) {
        clearInterval(timer);
        timer = null;
      }
    };
  }, [sessionId]);
  const current = useSyncExternalStore(subscribe, () => lists, () => lists);
  return sessionId ? (current[sessionId] ?? EMPTY) : EMPTY;
}
