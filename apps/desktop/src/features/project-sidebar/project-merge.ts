import type { ProjectGroupRecord } from "@pi-desktop/shared";

/*
  mc-agent: one sidebar entry per project (MC-ADR-0003). Upstream groups the
  sidebar by the folder a session started in, so a project with a resource
  folder and workspaces showed up once per folder, often under the same name.
  These helpers fold the path-keyed entries of one project group into a
  single entry and label each session with its start folder.
*/

export type ProjectFolderInfo = {
  groupId: string;
  groupName: string;
  /** Normalized key of the group's first root (its resource folder when it has one). */
  primaryKey: string;
  /** Every root of the group, normalized. */
  memberKeys: string[];
  /** Short start-folder label shown on sessions of multi-folder projects. */
  label: string;
  path: string;
};

export type ProjectFolderIndex = Map<string, ProjectFolderInfo>;

export function buildProjectFolderIndex(
  groups: readonly ProjectGroupRecord[],
  normalize: (path: string) => string | null,
  resourcesLabel: string,
): ProjectFolderIndex {
  const index: ProjectFolderIndex = new Map();
  for (const group of groups) {
    if (group.remote) continue;
    const keyed = group.roots
      .map((root) => ({ root, key: normalize(root.path) }))
      .filter((item): item is { root: (typeof group.roots)[number]; key: string } => Boolean(item.key));
    if (keyed.length === 0) continue;
    const memberKeys = keyed.map((item) => item.key);
    for (const { root, key } of keyed) {
      if (index.has(key)) continue;
      index.set(key, {
        groupId: group.id,
        groupName: group.name,
        primaryKey: memberKeys[0],
        memberKeys,
        label:
          root.kind === "resources"
            ? resourcesLabel
            : root.name || root.path.split(/[\\/]/).filter(Boolean).at(-1) || root.path,
        path: root.path,
      });
    }
  }
  return index;
}

type MergeableEntry<S> = {
  path: string;
  key: string;
  name: string;
  sessions: S[];
  open: boolean;
  active: boolean;
  branch?: string;
};

/**
 * Fold entries of the same project group into the first one in display
 * order. The merged entry takes the group's name and the group's first root
 * as its path when that folder is among the entries, and lists every session
 * that started in any of the group's folders. Entries outside any group are
 * returned unchanged.
 */
export function mergeProjectEntries<S extends { id: string; projectPath?: string | null }, E extends MergeableEntry<S>>(
  entries: readonly E[],
  sessions: readonly S[],
  index: ProjectFolderIndex,
  normalize: (path: string | null | undefined) => string | null,
  compareSessions: (left: S, right: S) => number,
): Array<E & { memberKeys: string[] }> {
  const byGroup = new Map<string, E[]>();
  for (const entry of entries) {
    const info = index.get(entry.key);
    if (!info) continue;
    byGroup.set(info.groupId, [...(byGroup.get(info.groupId) ?? []), entry]);
  }
  const result: Array<E & { memberKeys: string[] }> = [];
  const emitted = new Set<string>();
  for (const entry of entries) {
    const info = index.get(entry.key);
    if (!info) {
      result.push({ ...entry, memberKeys: [entry.key] });
      continue;
    }
    if (emitted.has(info.groupId)) continue;
    emitted.add(info.groupId);
    const members = byGroup.get(info.groupId) ?? [entry];
    const base = members.find((member) => member.key === info.primaryKey) ?? entry;
    const memberKeys = new Set(info.memberKeys);
    const merged = members.length > 1 || info.memberKeys.length > 1;
    result.push({
      ...base,
      name: merged ? info.groupName : base.name,
      open: members.some((member) => member.open),
      active: members.some((member) => member.active),
      branch: members.length > 1 ? undefined : base.branch,
      sessions: merged
        ? sessions
            .filter((session) => {
              const key = normalize(session.projectPath);
              return key ? memberKeys.has(key) : false;
            })
            .sort(compareSessions)
        : base.sessions,
      memberKeys: info.memberKeys,
    });
  }
  return result;
}

/** Start-folder label for a session of a project with more than one folder. */
export function sessionFolderLabel(
  projectPath: string | null | undefined,
  index: ProjectFolderIndex,
  normalize: (path: string | null | undefined) => string | null,
): ProjectFolderInfo | null {
  const key = normalize(projectPath);
  const info = key ? index.get(key) : undefined;
  return info && info.memberKeys.length > 1 ? info : null;
}
