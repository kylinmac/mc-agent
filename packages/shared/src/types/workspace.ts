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
export type ProjectGroupRootKind = "workspace" | "resources" | "reference";

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
  version: number;
  description: string;
  /** Folder (relative path, any depth) → what belongs in it. */
  categoryDescriptions: Record<string, string>;
  /** mc-agent: every folder as a `/`-separated relative path, parents first. */
  folders?: string[];
  /** What it sets up: a resource folder (default) or creative categories. */
  target?: ResourceTemplateTarget;
};

export type ResourceTemplateTarget = "resources" | "creative";

/** A template as the in-app editor saves it (R1.4). */
export type ResourceTemplateDraft = {
  name: string;
  description: string;
  /** Every folder, `name` being its relative path (`docs/api`). */
  categories: Array<{ name: string; description: string }>;
  /** Create a new template, optionally copying another one's folder. */
  create?: boolean;
  copyFrom?: string;
  target?: ResourceTemplateTarget;
};

/** One workspace's description from `<resource dir>/workspaces.md` (R10). */
export type WorkspaceNote = {
  path: string;
  /** Section heading: the folder name, or the path when folder names repeat. */
  heading: string;
  /** Empty when the file or the section is missing. */
  description: string;
};

/** mc-agent resource catalog (R3/R4). `changed` and `missing` are computed. */
export type ResourceStatus = "draft" | "confirmed" | "changed" | "deprecated" | "missing";

export type ResourceItem = {
  /** `folder:<relative path>` or `entry:<id>`. */
  key: string;
  source: "folder" | "workspace" | "url";
  /** First-level folder of the resource folder; empty when uncategorized. */
  category: string;
  title: string;
  path?: string;
  url?: string;
  status: ResourceStatus;
  confirmedAt?: number;
};

export type ResourceSummary = {
  total: number;
  draft: number;
  confirmed: number;
  changed: number;
  deprecated: number;
  missing: number;
};

export type ResourceListing = {
  items: ResourceItem[];
  summary: ResourceSummary;
  categories: string[];
  truncated: boolean;
};

/** mc-agent project tasks (R6–R9). */
export type ProjectTaskStatus = "todo" | "inProgress" | "awaitingReview" | "done" | "blocked" | "cancelled";

export type ProjectTaskRun = {
  id: string;
  sessionId: string;
  startFolder: string;
  startedAt: number;
  /**
   * What the run was given. `sha256`: the file's content hash when the run
   * started (mc-agent X-CONCEPT-02); absent for links and older runs.
   */
  resources: Array<{ key: string; title: string; status: ResourceStatus; sha256?: string; confirmedAt?: number }>;
  outcome: "running" | "finished" | "stopped" | "failed";
  endedAt?: number;
  note?: string;
};

export type ProjectTask = {
  id: string;
  title: string;
  goal: string;
  acceptance: string;
  resources: string[];
  status: ProjectTaskStatus;
  revision: number;
  runs: ProjectTaskRun[];
  reviews: Array<{ runId: string; verdict: "accepted" | "rejected"; note: string; at: number }>;
  createdAt: number;
  updatedAt: number;
};

export type ProjectTaskInput = {
  title: string;
  goal: string;
  acceptance: string;
  resources: string[];
};

export type ProjectTaskPreflight = {
  resources: Array<{ key: string; title: string; status: ResourceStatus }>;
  blocking: string[];
  drafts: string[];
};

/** A resource folder's template record (`.mc-agent/project.json`). */
export type ProjectTemplateStatus = {
  recorded?: {
    template: string;
    templateVersion: number;
    templateFingerprint: string;
    recordedAt: number;
    /** mc-agent (MC-ADR-0023): drafted for this project alone, not in the library. */
    oneOff?: boolean;
  };
  templateExists: boolean;
  currentVersion?: number;
  /** The template changed since the project recorded it. */
  outdated: boolean;
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

/**
 * mc-agent: estimated context use by kind for one session, computed by the
 * agent runtime (`context-breakdown.ts`) for the session info panel.
 */
/** mc-agent background command (MC-ADR-0006), as host-core lists it. */
export type BackgroundShell = {
  id: string;
  command: string;
  cwd: string;
  status: "running" | "exited" | "killed" | "failed";
  /** Present once the command exited on its own. */
  exitCode?: number;
  error: string | null;
  startedAt: number;
  endedAt: number | null;
  /** The last few KB of output (list only). */
  tail?: string;
};

/** mc-agent: token usage summary (MC-ADR-0011). */
export type UsageCounts = {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  totalTokens: number;
  turns: number;
};
export type UsageSummary = {
  fromMs: number;
  toMs: number;
  totals: UsageCounts;
  byModel: Array<UsageCounts & { providerId: string | null; providerName: string | null; modelId: string | null }>;
  byProject: Array<UsageCounts & { path: string | null }>;
  byDay: Array<UsageCounts & { day: string }>;
  byDayModel: Array<UsageCounts & { day: string; providerId: string | null; modelId: string | null }>;
  topSessions: Array<UsageCounts & { sessionId: string; title: string; projectPath: string | null }>;
};

/** mc-agent: system prompt templates and the rules that apply them (MC-ADR-0010). */
export type SystemPromptTemplate = { id: string; name: string; persona: string; append: string };
/** Added after whatever the chosen template appends; never replaces anything. */
export type SystemPromptAppend = { id: string; name: string; text: string; enabled: boolean };
export type SystemPromptConfig = {
  templates: SystemPromptTemplate[];
  globalTemplateId?: string | null;
  modelRules: Array<{ pattern: string; templateId: string }>;
  projectRules: Array<{ path: string; templateId: string }>;
  /** Enabled ones apply to every conversation, in this order. */
  appendPrompts?: SystemPromptAppend[];
  updatedAt?: number;
};

/** mc-agent: the system prompt a session sends, by section. */
export type SessionSystemPrompt = {
  sections: Array<{ key: string; text: string }>;
  /** SYSTEM.md replaces the persona. */
  customPersona: boolean;
  /** APPEND_SYSTEM.md is appended. */
  customAppend: boolean;
  /** The template the conversation's launch applied, if any (MC-ADR-0010). */
  template?: {
    templateName: string;
    match:
      | { kind: "session" }
      | { kind: "project"; path: string }
      | { kind: "model"; pattern: string }
      | { kind: "global" };
  } | null;
  /** Names of the append prompts the launch added, in order. */
  appendPrompts?: string[];
};

export type SessionContextBreakdown = {
  contextWindow: number;
  autoCompactAt: number;
  categories: Record<
    "systemPrompt" | "projectInstructions" | "memory" | "skills" | "tools" | "mcpTools" | "messages",
    number
  >;
  usedTokens: number;
  toolCount: number;
  mcpToolCount: number;
  skillCount: number;
  messageCount: number;
  toolNames: string[];
  mcpToolNames: string[];
  skillNames: string[];
};
