import type { WorkPanelTab } from "../../lib/work-panel-tabs";

/*
  mc-agent work-panel tools (MC-ADR-0005). Terminals and browsers open a new
  tab each time, like editor tabs; files and review stay single tabs.
*/

export const BROWSER_VIEW = { pluginId: "pi.browser", viewId: "browser" } as const;
export const FILES_VIEW = { pluginId: "pi.file-manager", viewId: "manager" } as const;

function instanceId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function folderName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;
}

/** A new terminal tab whose shell starts in `cwd`. */
export function terminalTab(cwd: string): WorkPanelTab {
  return { id: `terminal:${instanceId()}`, kind: "terminal", resource: cwd, label: folderName(cwd) };
}

/** A new browser tab: its own page, separate from other browser tabs. */
export function browserTab(): WorkPanelTab {
  const resource = `${BROWSER_VIEW.pluginId}/${BROWSER_VIEW.viewId}`;
  return { id: `plugin:${resource}#${instanceId()}`, kind: "plugin", resource };
}

/** The background tasks tab: one per session (MC-ADR-0006). */
export function backgroundTab(): WorkPanelTab {
  return { id: "background", kind: "background" };
}

/**
 * The prototype canvas tab: one per session, showing one of the project's
 * canvases (docs/mc-agent/prototype-canvas.md).
 */
export function canvasTab(canvasId?: string): WorkPanelTab {
  return { id: "canvas", kind: "canvas", ...(canvasId ? { resource: canvasId } : {}) };
}

/** Terminal tab ids across every session's work panel. */
export function terminalTabIds(tabs: Iterable<WorkPanelTab>): Set<string> {
  const ids = new Set<string>();
  for (const tab of tabs) if (tab.kind === "terminal") ids.add(tab.id);
  return ids;
}
