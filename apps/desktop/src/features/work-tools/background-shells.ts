import { useEffect, useSyncExternalStore } from "react";
import type { BackgroundShell } from "@pi-desktop/shared";
import { api } from "../../lib/api";
import { useAppStore } from "../../stores/app-store";
import {
  shouldPollBackgroundShells,
  type BackgroundRunningStateSlice,
} from "./background-poll-policy";

/*
  mc-agent background commands (MC-ADR-0006): one shared poller per window,
  read by the header icon (running count), the background pane and open
  session info panels. With conversations side by side (MC-ADR-0007) several
  sessions are watched at once, so the poller keeps one list per session.
  host-core owns the processes; this only mirrors them. It polls every 2
  seconds only while a subscribed session is running a turn or has an active
  background shell, staying silent when idle.
*/

const POLL_MS = 2000;
const EMPTY: BackgroundShell[] = [];

let lists: Record<string, BackgroundShell[]> = {};
const listeners = new Set<() => void>();
/** How many mounted readers want each session. */
const wanted = new Map<string, number>();
let timer: ReturnType<typeof setInterval> | null = null;
let unsubscribeStore: (() => void) | null = null;
let listeningFocus = false;
let lastRunningSignature = "";

function runningSignature(wantedIds: Iterable<string>, appState: BackgroundRunningStateSlice): string {
  return [...wantedIds]
    .sort()
    .map((id) => `${id}:${appState.activeSessionId === id ? appState.isRunning : Boolean(appState.runningSessions[id])}`)
    .join("|");
}

function syncPolling(): void {
  const active =
    wanted.size > 0 &&
    shouldPollBackgroundShells(wanted.keys(), lists, useAppStore.getState());
  if (active && !timer) {
    timer = setInterval(() => void refreshBackgroundShells(), POLL_MS);
  } else if (!active && timer) {
    clearInterval(timer);
    timer = null;
  }
}

function onWindowFocus(): void {
  if (wanted.size > 0) void refreshBackgroundShells();
}

function ensureWatchers(): void {
  if (!unsubscribeStore) {
    lastRunningSignature = runningSignature(wanted.keys(), useAppStore.getState());
    unsubscribeStore = useAppStore.subscribe((state) => {
      const nextSig = runningSignature(wanted.keys(), state);
      if (nextSig === lastRunningSignature) return;
      lastRunningSignature = nextSig;
      syncPolling();
      void refreshBackgroundShells();
    });
  }
  if (!listeningFocus && typeof window !== "undefined") {
    window.addEventListener("focus", onWindowFocus);
    listeningFocus = true;
  }
}

function cleanupWatchersIfIdle(): void {
  if (wanted.size > 0) return;
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  if (unsubscribeStore) {
    unsubscribeStore();
    unsubscribeStore = null;
  }
  if (listeningFocus && typeof window !== "undefined") {
    window.removeEventListener("focus", onWindowFocus);
    listeningFocus = false;
  }
  lastRunningSignature = "";
}

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
  } finally {
    syncPolling();
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

/** A session's background commands, kept fresh while active or running. */
export function useBackgroundShells(sessionId: string | null | undefined): BackgroundShell[] {
  useEffect(() => {
    if (!sessionId) return;
    wanted.set(sessionId, (wanted.get(sessionId) ?? 0) + 1);
    ensureWatchers();
    lastRunningSignature = runningSignature(wanted.keys(), useAppStore.getState());
    syncPolling();
    void refreshSession(sessionId);
    return () => {
      const count = (wanted.get(sessionId) ?? 1) - 1;
      if (count > 0) wanted.set(sessionId, count);
      else {
        wanted.delete(sessionId);
        const { [sessionId]: _dropped, ...rest } = lists;
        lists = rest;
      }
      lastRunningSignature = runningSignature(wanted.keys(), useAppStore.getState());
      syncPolling();
      cleanupWatchersIfIdle();
    };
  }, [sessionId]);
  const current = useSyncExternalStore(subscribe, () => lists, () => lists);
  return sessionId ? (current[sessionId] ?? EMPTY) : EMPTY;
}
