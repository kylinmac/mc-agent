import type { SessionSummary } from "@pi-desktop/shared";
import { normalizeProjectPath } from "../../lib/sidebar-session-groups.ts";
import { isRemoteSession } from "../../lib/remote-session-safety.ts";
import type { ProjectFolderIndex } from "../../lib/projects/project-folders.ts";
import { tabPage } from "./tab-list.ts";

export type ProjectTabGroup = { kind: "project"; id: string; title: string; keys: string[] };
export type GroupedTab = ProjectTabGroup | { kind: "tab"; key: string };

/** Preserve first appearance and session order; names never identify projects. */
export function groupProjectTabs(
  tabs: readonly string[],
  sessions: ReadonlyMap<string, SessionSummary>,
  folders: ProjectFolderIndex,
  ungrouped: string,
): GroupedTab[] {
  const result: GroupedTab[] = [];
  const groups = new Map<string, ProjectTabGroup>();
  for (const key of tabs) {
    if (tabPage(key)) {
      result.push({ kind: "tab", key });
      continue;
    }
    const session = sessions.get(key);
    const path = normalizeProjectPath(session?.projectPath);
    const folder = path ? folders.get(path) : undefined;
    let id = "ungrouped";
    let title = ungrouped;
    if (isRemoteSession(session)) {
      id = `remote:${JSON.stringify([session?.remoteHostKey ?? key, session?.remoteProjectId ?? null])}`;
      title = session?.remoteWorkspaceLabel ?? session?.remoteProjectId ?? ungrouped;
    } else if (folder) {
      id = `project:${folder.groupId}`;
      title = folder.groupName;
    } else if (path) {
      id = `path:${path}`;
      title = path.split("/").filter(Boolean).at(-1) ?? path;
    }
    let group = groups.get(id);
    if (!group) {
      group = { kind: "project", id, title, keys: [] };
      groups.set(id, group);
      result.push(group);
    }
    group.keys.push(key);
  }
  return result;
}

export function groupedEntryId(entry: GroupedTab): string {
  return entry.kind === "project" ? `group:${entry.id}` : `tab:${entry.key}`;
}

export function groupedEntryKeys(entry: GroupedTab): readonly string[] {
  return entry.kind === "project" ? entry.keys : [entry.key];
}

/** Move a single tab or an entire project group before/after another strip item, keeping internal tab order. */
export function moveGroupedTab(
  tabs: readonly string[],
  entries: readonly GroupedTab[],
  sourceId: string,
  targetId: string,
  after: boolean,
): string[] {
  if (sourceId === targetId) return [...tabs];
  const sourceIndex = entries.findIndex((entry) => groupedEntryId(entry) === sourceId);
  if (sourceIndex < 0) return [...tabs];
  const remaining = entries.filter((_, index) => index !== sourceIndex);
  const targetIndex = remaining.findIndex((entry) => groupedEntryId(entry) === targetId);
  if (targetIndex < 0) return [...tabs];
  const insertSlot = targetIndex + (after ? 1 : 0);
  if (insertSlot === sourceIndex) return [...tabs];

  const sourceKeys = [...groupedEntryKeys(entries[sourceIndex])];
  const moving = new Set(sourceKeys);
  const rest = tabs.filter((tab) => !moving.has(tab));
  if (insertSlot >= remaining.length) return [...rest, ...sourceKeys];

  const anchorKey = groupedEntryKeys(remaining[insertSlot])[0];
  const anchorPos = anchorKey ? rest.indexOf(anchorKey) : -1;
  const insertAt = anchorPos < 0 ? rest.length : anchorPos;
  rest.splice(insertAt, 0, ...sourceKeys);
  return rest;
}
