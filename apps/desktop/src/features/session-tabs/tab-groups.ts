import type { SessionSummary } from "@pi-desktop/shared";
import { normalizeProjectPath } from "../../lib/sidebar-session-groups.ts";
import { isRemoteSession } from "../../lib/remote-session-safety.ts";
import type { ProjectFolderIndex } from "../project-sidebar/project-merge.ts";
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
