/*
  mc-agent attention feed model (MC-ADR-0029 / R37): pure functions for
  cross-project session triage ("needs_action" -> "running" -> "completed")
  and on-screen presence auto-acknowledgement. Kept free of store/DOM imports
  so `node --test` can exercise every transition directly.
*/

export type AttentionKind = "needs_action" | "running" | "completed";

export type AttentionSessionInput = {
  id: string;
  title?: string | null;
  projectPath?: string | null;
  remoteWorkspaceLabel?: string | null;
  scheduledRun?: boolean;
  updatedAt?: string | number | null;
};

export type AttentionVisibleState = {
  page: string;
  /** False when the chat viewport is occluded (maximized work panel, minimized/hidden window). */
  chatSurfaceVisible?: boolean;
  activeSessionId?: string | null;
  /** Head of `retainedSessionIds` when present, reflecting the pane actually painted during a cold switch. */
  visibleSessionId?: string | null;
  splitColumns: readonly string[];
};

export type AttentionTurnResultLike = {
  status: "completed" | "failed";
};

export type AttentionOutcomeLike = "completed" | "failed";

export type AttentionNotificationLike = {
  id: string;
  kind: "task.completed" | "task.failed";
  sessionId: string;
  createdAt: string | number;
  readAt?: string | null;
};

export type AttentionItem = {
  sessionId: string;
  title: string;
  projectLabel: string | null;
  kind: AttentionKind;
  timestamp: number;
};

export const DEFAULT_ATTENTION_LIMIT = 6;

export function normalizeAttentionProjectPath(projectPath?: string | null): string | null {
  const value = projectPath?.trim();
  if (!value) return null;
  let normalized = value.replace(/\\/g, "/");
  // Strip Windows extended-length prefix (`//?/C:/...` -> `C:/...`).
  if (/^\/\/\?\/[A-Za-z]:\//.test(normalized)) {
    normalized = normalized.slice(4);
  }
  // Remove trailing slashes while preserving drive roots (`C:/`).
  normalized = normalized.replace(/(?<![A-Za-z]:)\/+$/, "");
  return normalized || "/";
}

function basenameOf(path?: string | null): string | null {
  const clean = normalizeAttentionProjectPath(path);
  if (!clean) return null;
  const parts = clean.split("/").filter(Boolean);
  return parts.at(-1) ?? clean;
}

function isDefaultTitle(title?: string | null): boolean {
  const trimmed = (title ?? "").trim().toLowerCase();
  return !trimmed || ["new task", "new chat", "新建任务", "新对话"].includes(trimmed);
}

function parseTimestamp(raw?: string | number | null): number {
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  if (typeof raw === "string" && raw.trim()) {
    const parsed = Date.parse(raw);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

/**
 * Whether `sessionId`'s conversation transcript is actually visible on screen:
 * - false on non-chat routes, when the work panel is maximized over the chat,
 *   or when the application window itself is minimized/hidden (`chatSurfaceVisible === false`);
 * - in split view (`splitColumns.length > 1`), true for each visible column;
 * - in single-pane view, true for the currently painted session pane.
 */
export function isSessionVisibleOnScreen(
  sessionId: string,
  visible: AttentionVisibleState,
): boolean {
  if (!sessionId || visible.page !== "chat" || visible.chatSurfaceVisible === false) {
    return false;
  }
  if (visible.splitColumns.length > 1) {
    return visible.splitColumns.includes(sessionId);
  }
  const onScreenId = visible.visibleSessionId || visible.activeSessionId;
  return onScreenId === sessionId;
}

function didTurnCompleteSuccessfully(
  sessionId: string,
  latestTurnResults?: Readonly<Record<string, AttentionTurnResultLike | undefined>>,
  sessionOutcomes?: Readonly<Record<string, AttentionOutcomeLike | undefined>>,
): boolean {
  const turnStatus = latestTurnResults?.[sessionId]?.status;
  const outcomeStatus = sessionOutcomes?.[sessionId];
  if (turnStatus === "failed" || outcomeStatus === "failed") return false;
  return turnStatus === "completed" || outcomeStatus === "completed";
}

/**
 * Reconcile unread-completed badges across running-state transitions and
 * viewport changes:
 * - `running -> idle` while off-screen records `now` ONLY when the turn
 *   genuinely completed (`latestTurnResults[id]?.status === "completed"` or
 *   `sessionOutcomes[id] === "completed"`), never on model failure, `TURN_ABORTED`,
 *   or manual compaction (`compaction_end`);
 * - viewing a session on-screen, starting a new run, failing, or deleting the
 *   session clears its unread mark automatically.
 */
export function reconcileUnreadCompleted(params: {
  prevRunning: Readonly<Record<string, boolean>>;
  nextRunning: Readonly<Record<string, boolean>>;
  currentUnread: Readonly<Record<string, number>>;
  visible: AttentionVisibleState;
  existingSessionIds: ReadonlySet<string>;
  latestTurnResults?: Readonly<Record<string, AttentionTurnResultLike | undefined>>;
  sessionOutcomes?: Readonly<Record<string, AttentionOutcomeLike | undefined>>;
  now: number;
}): Record<string, number> {
  const {
    prevRunning,
    nextRunning,
    currentUnread,
    visible,
    existingSessionIds,
    latestTurnResults,
    sessionOutcomes,
    now,
  } = params;
  const next: Record<string, number> = {};

  for (const [id, ts] of Object.entries(currentUnread)) {
    if (!existingSessionIds.has(id)) continue;
    if (nextRunning[id] === true) continue;
    if (latestTurnResults?.[id]?.status === "failed" || sessionOutcomes?.[id] === "failed") {
      continue;
    }
    if (isSessionVisibleOnScreen(id, visible)) continue;
    next[id] = ts;
  }

  for (const [id, wasRunning] of Object.entries(prevRunning)) {
    if (!wasRunning) continue;
    if (nextRunning[id] === true) continue;
    if (!existingSessionIds.has(id)) continue;
    if (!didTurnCompleteSuccessfully(id, latestTurnResults, sessionOutcomes)) continue;
    if (isSessionVisibleOnScreen(id, visible)) continue;
    next[id] = now;
  }

  return next;
}

const KIND_PRIORITY: Record<AttentionKind, number> = {
  needs_action: 0,
  running: 1,
  completed: 2,
};

/**
 * Build the complete sorted list of attention items across all projects.
 * Never truncates unless an explicit `maxItems` cap is requested by the caller;
 * use `visibleAttentionSlice` in the UI so header counts always reflect the
 * true total while keeping the collapsed list compact.
 */
export type AttentionProjectFolderInfoLike = {
  groupName: string;
  primaryKey?: string;
};

export function buildAttentionItems(params: {
  sessions: readonly AttentionSessionInput[];
  runningSessions: Readonly<Record<string, boolean>>;
  activeSessionId?: string | null;
  isRunning?: boolean;
  pendingPermissions: Readonly<Record<string, readonly unknown[] | undefined>>;
  pendingAsks: Readonly<Record<string, readonly unknown[] | undefined>>;
  pendingPlans?: Readonly<Record<string, { status?: string } | undefined>>;
  planCheckpoints?: Readonly<Record<string, { status?: string } | undefined>>;
  planningStates?: Readonly<Record<string, string | undefined>>;
  unreadCompleted: Readonly<Record<string, number>>;
  projectMeta: Readonly<Record<string, { name?: string | null } | undefined>>;
  projectFolderIndex?: ReadonlyMap<string, AttentionProjectFolderInfoLike>;
  untitledLabel: string;
  maxItems?: number;
}): AttentionItem[] {
  const {
    sessions,
    runningSessions,
    activeSessionId,
    isRunning = false,
    pendingPermissions,
    pendingAsks,
    pendingPlans,
    planCheckpoints,
    planningStates,
    unreadCompleted,
    projectMeta,
    projectFolderIndex,
    untitledLabel,
    maxItems,
  } = params;

  const items: AttentionItem[] = [];
  for (const session of sessions) {
    if (session.scheduledRun === true) continue;
    const id = session.id;
    const hasPerm = (pendingPermissions[id]?.length ?? 0) > 0;
    const hasAsk = (pendingAsks[id]?.length ?? 0) > 0;
    const hasPlan =
      pendingPlans?.[id]?.status === "pending" ||
      planCheckpoints?.[id]?.status === "pending" ||
      planningStates?.[id] === "awaiting_approval";
    const running = runningSessions[id] === true || (id === activeSessionId && isRunning);
    const completedAt = unreadCompleted[id];

    let kind: AttentionKind | null = null;
    if (hasPerm || hasAsk || hasPlan) kind = "needs_action";
    else if (running) kind = "running";
    else if (completedAt !== undefined) kind = "completed";
    if (!kind) continue;

    const pathKey = normalizeAttentionProjectPath(session.projectPath);
    const folderInfo = pathKey ? projectFolderIndex?.get(pathKey) : undefined;
    const metaName =
      (folderInfo?.primaryKey ? projectMeta[folderInfo.primaryKey]?.name?.trim() : undefined) ||
      (pathKey ? projectMeta[pathKey]?.name?.trim() : undefined);
    const projectLabel =
      session.remoteWorkspaceLabel?.trim() ||
      metaName ||
      folderInfo?.groupName?.trim() ||
      (pathKey ? basenameOf(session.projectPath) : null);

    items.push({
      sessionId: id,
      title: isDefaultTitle(session.title) ? untitledLabel : (session.title ?? "").trim(),
      projectLabel,
      kind,
      timestamp: completedAt ?? parseTimestamp(session.updatedAt),
    });
  }

  items.sort((left, right) => {
    const rank = KIND_PRIORITY[left.kind] - KIND_PRIORITY[right.kind];
    if (rank !== 0) return rank;
    return right.timestamp - left.timestamp;
  });

  if (maxItems !== undefined) {
    return items.slice(0, Math.max(1, maxItems));
  }
  return items;
}

export function visibleAttentionSlice<T>(
  items: readonly T[],
  expanded: boolean,
  limit = DEFAULT_ATTENTION_LIMIT,
): { visibleItems: T[]; totalCount: number; hiddenCount: number } {
  const totalCount = items.length;
  const clamped = Math.max(1, limit);
  if (expanded || totalCount <= clamped) {
    return { visibleItems: [...items], totalCount, hiddenCount: 0 };
  }
  return {
    visibleItems: items.slice(0, clamped),
    totalCount,
    hiddenCount: totalCount - clamped,
  };
}

function setsEqual(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  if (left.size !== right.size) return false;
  for (const item of left) {
    if (!right.has(item)) return false;
  }
  return true;
}

export function stepAttentionTrackerState(
  current: {
    unreadCompleted: Record<string, number>;
    prevRunning: Record<string, boolean>;
    seenNotificationIds?: ReadonlySet<string>;
    outcomeBackedSessionIds?: ReadonlySet<string>;
  },
  params: {
    liveRunning: Record<string, boolean>;
    visible: AttentionVisibleState;
    existingSessionIds: ReadonlySet<string>;
    latestTurnResults?: Readonly<Record<string, AttentionTurnResultLike | undefined>>;
    sessionOutcomes?: Readonly<Record<string, AttentionOutcomeLike | undefined>>;
    notifications?: readonly AttentionNotificationLike[];
    now?: number;
  },
): {
  unreadCompleted: Record<string, number>;
  prevRunning: Record<string, boolean>;
  seenNotificationIds: Set<string>;
  outcomeBackedSessionIds: Set<string>;
  acknowledgedSessionIds: string[];
  unreadChanged: boolean;
  seenChanged: boolean;
  outcomeBackedChanged: boolean;
} {
  const now = params.now ?? Date.now();
  const nextUnread = reconcileUnreadCompleted({
    prevRunning: current.prevRunning,
    nextRunning: params.liveRunning,
    currentUnread: current.unreadCompleted,
    visible: params.visible,
    existingSessionIds: params.existingSessionIds,
    latestTurnResults: params.latestTurnResults,
    sessionOutcomes: params.sessionOutcomes,
    now,
  });

  const newlyCompletedIds = new Set<string>();
  for (const [id, wasRunning] of Object.entries(current.prevRunning)) {
    if (
      wasRunning &&
      params.liveRunning[id] !== true &&
      params.existingSessionIds.has(id) &&
      didTurnCompleteSuccessfully(id, params.latestTurnResults, params.sessionOutcomes) &&
      !isSessionVisibleOnScreen(id, params.visible)
    ) {
      newlyCompletedIds.add(id);
    }
  }

  const acknowledged = new Set<string>();
  for (const id of Object.keys(current.unreadCompleted)) {
    if (
      params.existingSessionIds.has(id) &&
      params.liveRunning[id] !== true &&
      isSessionVisibleOnScreen(id, params.visible)
    ) {
      acknowledged.add(id);
    }
  }

  const liveOutcomeBacked = new Set<string>();
  if (params.sessionOutcomes) {
    for (const [id, outcome] of Object.entries(params.sessionOutcomes)) {
      if (!params.existingSessionIds.has(id) || params.liveRunning[id] === true) continue;
      if (outcome === "completed") {
        if (isSessionVisibleOnScreen(id, params.visible)) {
          acknowledged.add(id);
        } else {
          liveOutcomeBacked.add(id);
        }
      }
    }
  }

  // Hydrate unread completions from host notifications (newest-first per session,
  // matching `latestSessionOutcomes`) and reconcile read/cleared notifications
  // from NotificationCenter so "刚完成" stays consistent across both surfaces.
  const prevSeen = current.seenNotificationIds ?? new Set<string>();
  const nextSeen = new Set(prevSeen);
  const seenSessionInBatch = new Set<string>();
  for (const notif of params.notifications ?? []) {
    const isLatestForSession = !seenSessionInBatch.has(notif.sessionId);
    seenSessionInBatch.add(notif.sessionId);
    const alreadySeen = nextSeen.has(notif.id);
    nextSeen.add(notif.id);
    if (!isLatestForSession) continue;
    if (!params.existingSessionIds.has(notif.sessionId)) continue;
    if (params.liveRunning[notif.sessionId] === true) continue;
    if (
      params.latestTurnResults?.[notif.sessionId]?.status === "failed" ||
      params.sessionOutcomes?.[notif.sessionId] === "failed"
    ) {
      continue;
    }
    if (notif.kind === "task.completed" && notif.readAt) {
      if (nextUnread[notif.sessionId] !== undefined && !newlyCompletedIds.has(notif.sessionId)) {
        const readTs = parseTimestamp(notif.readAt);
        if (
          readTs === 0 ||
          readTs >= nextUnread[notif.sessionId] ||
          current.outcomeBackedSessionIds?.has(notif.sessionId)
        ) {
          delete nextUnread[notif.sessionId];
        }
      }
      continue;
    }
    if (notif.kind !== "task.completed") continue;
    if (isSessionVisibleOnScreen(notif.sessionId, params.visible)) {
      acknowledged.add(notif.sessionId);
      continue;
    }
    liveOutcomeBacked.add(notif.sessionId);
    if (!alreadySeen && nextUnread[notif.sessionId] === undefined) {
      nextUnread[notif.sessionId] = parseTimestamp(notif.createdAt) || now;
    }
  }

  // Edge sync: if a session's unread badge was backed by a host notification or
  // `sessionOutcomes[id] === "completed"`, and that notification/outcome was just
  // marked read or cleared in NotificationCenter, drop its unread badge too.
  const prevOutcomeBacked = current.outcomeBackedSessionIds ?? new Set<string>();
  for (const id of prevOutcomeBacked) {
    if (!liveOutcomeBacked.has(id) && !newlyCompletedIds.has(id)) {
      delete nextUnread[id];
    }
  }
  for (const id of [...liveOutcomeBacked]) {
    if (nextUnread[id] === undefined) liveOutcomeBacked.delete(id);
  }

  const keysA = Object.keys(current.unreadCompleted);
  const keysB = Object.keys(nextUnread);
  const sameUnread =
    keysA.length === keysB.length &&
    keysA.every((key) => current.unreadCompleted[key] === nextUnread[key]);
  const seenChanged = nextSeen.size !== prevSeen.size;
  const outcomeBackedChanged = !setsEqual(prevOutcomeBacked, liveOutcomeBacked);

  return {
    unreadCompleted: sameUnread ? current.unreadCompleted : nextUnread,
    prevRunning: params.liveRunning,
    seenNotificationIds: nextSeen,
    outcomeBackedSessionIds: outcomeBackedChanged ? liveOutcomeBacked : new Set(prevOutcomeBacked),
    acknowledgedSessionIds: [...acknowledged],
    unreadChanged: !sameUnread,
    seenChanged,
    outcomeBackedChanged,
  };
}
