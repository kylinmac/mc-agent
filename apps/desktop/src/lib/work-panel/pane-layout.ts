import { useSyncExternalStore } from "react";
import {
  readPanePrefs,
  savePanePrefs,
  type PaneId,
  type PanePrefs,
} from "./work-panes-model";

/*
  mc-agent work-panel pane layout (MC-ADR-0005): one global layout shared by
  the panes and the header's tool icons, so a tool icon can expand its
  collapsed pane.
*/

let prefs: PanePrefs = readPanePrefs();
const listeners = new Set<() => void>();

export function getPanePrefs(): PanePrefs {
  return prefs;
}

export function updatePanePrefs(update: (current: PanePrefs) => PanePrefs): void {
  const next = update(prefs);
  if (next === prefs) return;
  prefs = next;
  savePanePrefs(prefs);
  for (const listener of listeners) listener();
}

export function expandPane(id: PaneId): void {
  updatePanePrefs((current) =>
    current.collapsed.includes(id)
      ? { ...current, collapsed: current.collapsed.filter((item) => item !== id) }
      : current,
  );
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function usePanePrefs(): PanePrefs {
  return useSyncExternalStore(subscribe, getPanePrefs, getPanePrefs);
}
