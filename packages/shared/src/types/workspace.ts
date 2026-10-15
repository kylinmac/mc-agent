import type { ProjectMemory } from "./filesystem.js";

/** Shared public types grouped by the owning application domain. */
export type AppNotificationKind = "task.completed" | "task.failed";

export type AppNotification = {
  id: string;
  kind: AppNotificationKind;
  sessionId: string;
  sessionTitle: string;
  turnId: string;
  errorCode?: string;
  createdAt: string;
  readAt?: string | null;
};

export type NotificationListResult = {
  notifications: AppNotification[];
  unreadCount: number;
};

export type RemoteWorkspace = { hostKey: string; path: string };

export type ProjectWorkspace = {
  remote?: RemoteWorkspace;
  path: string;
  name: string;
  /** Best-effort git branch from .git/HEAD when available. */
  branch?: string;
};

export type ProjectRecord = {
  id: number;
  path: string;
  name: string;
  pinned: boolean;
  createdAt: number;
  lastOpenedAt: number;
};

/**
 * What a project-group root is for (mc-agent, MC-ADR-0003). Absent on records
 * written before mc-agent, which read as `"workspace"`.
 */
export type ProjectGroupRootKind = "workspace" | "resources";

export type ProjectGroupRoot = {
  path: string;
  name: string;
  position: number;
  /** `"resources"` marks the project's resource directory, always `roots[0]`. */
  kind?: ProjectGroupRootKind;
};

/** A resource-directory template under `<mc-agent home>/templates`. */
export type ResourceTemplateSummary = {
  name: string;
  path: string;
  builtin: boolean;
  /** First-level folders: the categories a new project starts with. */
  categories: string[];
};

/** One workspace's description from `<resource dir>/workspaces.md` (R10). */
export type WorkspaceNote = {
  path: string;
  /** Section heading: the folder name, or the path when folder names repeat. */
  heading: string;
  /** Empty when the file or the section is missing. */
  description: string;
};

export type ProjectGroupRecord = {
  remote?: RemoteWorkspace;
  id: string;
  name: string;
  primaryPath: string;
  roots: ProjectGroupRoot[];
  createdAt: number;
  updatedAt: number;
  pinned: boolean;
  lastOpenedAt: number;
  /** True for a compatibility projection of an old single-folder project. */
  legacy?: boolean;
  /** Previously removed roots remain suppressed from legacy projections. */
  detachedPaths?: string[];
};

export type ProjectGroupContext = {
  remote?: RemoteWorkspace;
  groupId: string;
  roots: ProjectGroupRoot[];
  instructions: string;
  memory: ProjectMemory;
};

/**
 * `authKind` for a provider row whose credential is a vendor-account OAuth
 * login rather than a pasted API key. Shared so main, the sidecar runtime and
 * the renderer all branch on the same spelling.
 */
