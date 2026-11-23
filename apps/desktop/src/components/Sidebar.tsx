import { RemoteProjectGroups } from "./remote/RemoteProjectGroups";
import { groupRemoteProjectSessions } from "../lib/remote-project-catalog";
import { isRemoteSession, sessionAllows } from "../lib/remote-session-safety";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type AnimationEventHandler as ReactAnimationEventHandler,
  type DragEvent as ReactDragEvent,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { TooltipButton, cx } from "./ui";
import { portalToBody } from "../lib/portal-visibility";
import { useTranslation } from "react-i18next";
import { api } from "../lib/api";
import { formatSessionLastReplyDate } from "../lib/sidebar-session-date";
import { SessionHoverCard } from "../features/sessions/SessionHoverCard";
import { useSessionHoverCard } from "../features/sessions/useSessionHoverCard";
import { useAppStore } from "../stores/app-store";
import { normalizeProjectPath, sessionArchived, sessionPinned } from "../lib/sidebar-session-groups";
import { getVisibleProjectSessions, updateProjectSessionExpansion } from "../lib/sidebar-project-sessions";
import { sessionFolderLabel } from "../lib/projects/project-folders";
import { SidebarAttentionFeed } from "../features/attention-feed/SidebarAttentionFeed";
import { SidebarFooter } from "../features/app-rail/SidebarFooter";
import { composerDropItems, hasComposerFileDrag } from "../lib/composer-drop";
import { sidebarSessionStatus, type SidebarSessionStatus } from "../lib/sidebar-session-status";
import { projectRunSummaryIsLive, resolveSidebarRunningAffordances, summarizeProjectRuns } from "../lib/sidebar-project-runs";
import { ProjectRunBadge, ProjectRunCount, ProjectRunRail } from "./ProjectRunIndicator";
import { formatSessionLink } from "@pi-desktop/shared";
import type { SessionSummary } from "@pi-desktop/shared";
import type { SessionSort } from "../lib/sidebar-preferences";
import { clampSidebarWidth, SIDEBAR_WIDTH_MAX, SIDEBAR_WIDTH_MIN } from "../lib/sidebar-preferences";
import { BrandLogo } from "./BrandLogo";
import { SidebarSlotHost, pagePinsSidebar } from "../features/sidebar-slot/SidebarSlot";
import { ProjectEditDialog } from "./ProjectEditDialog";
import {
  WorktreeBadge,
  WorktreeDialogs,
  useWorktreeDeleteLossText,
  useWorktreeProjectMenuItems,
  useWorktreeSessionMenuItems,
} from "../features/worktree/WorktreeSidebarParts";
import { WorktreeBehindWatcher } from "../features/worktree/WorktreeBehind";
import { startConversationalProject } from "../features/project-create/start-conversational-project";
import { projectStartFolderChoices } from "../features/project-sidebar/start-folder-menu";
import { rememberedStartFolder, rememberStartFolder } from "../lib/projects/start-folder";
import { SidebarMenuPanel, sidebarMenuKeyDown } from "./SidebarMenuPanel";
import {
  sidebarMenuAction,
  sidebarMenuCheck,
  sidebarMenuGroup,
  sidebarMenuSection,
  sidebarMenuSubmenu,
  type SidebarMenuPanelContent,
} from "../lib/sidebar-menu";
import { useArmedDelete } from "../hooks/use-armed-delete";
import { ProjectDeleteDialog } from "./ProjectDeleteDialog";
import { SessionRenameDialog } from "./SessionRenameDialog";
import { openProjectImportDialog } from "../features/project-import/import-dialog-state";
import {
  IconArchive,
  IconArchiveRestore,
  IconArrowUpDown,
  IconBranch,
  IconCheck,
  IconChevronDown,
  IconCopy,
  IconCircleAlert,
  IconNewSession,
  IconFolder,
  IconMore,
  IconNewProject,
  IconSparkles,
  IconDownload,
  IconPin,
  IconPencil,
  IconSidebar,
  IconStar,
  IconTrash,
  IconX,
} from "./icons";
import { useSidebarResize } from "./sidebar/useSidebarResize";
import { useSidebarMenus } from "./sidebar/useSidebarMenus";
import type { ProjectEntry } from "./sidebar/project-entry";
import { useProjectReorder } from "./sidebar/useProjectReorder";
import { projectName, projectMetaFor, useSidebarProjects } from "./sidebar/useSidebarProjects";

/** Private MIME so a sidebar session drag is never mistaken for an OS file drop. */
const SESSION_DRAG_MIME = "application/x-pi-desktop-session";


function projectDomId(path: string): string {
  let hash = 2166136261;
  for (let index = 0; index < path.length; index += 1) {
    hash ^= path.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `sidebar-project-${(hash >>> 0).toString(36)}`;
}

export function Sidebar({
  onToggleSidebar,
  sidebarToggleShortcut,
  sidebarWidth,
  widthMax = SIDEBAR_WIDTH_MAX,
  onWidthChange,
  onWidthCommit,
  onResizeCollapse,
  className,
  onAnimationEnd,
}: {
  onToggleSidebar: () => void;
  sidebarToggleShortcut: string;
  sidebarWidth: number;
  widthMax?: number;
  onWidthChange: (width: number) => void;
  onWidthCommit: (width: number) => void;
  onResizeCollapse: () => void;
  className?: string;
  onAnimationEnd?: ReactAnimationEventHandler<HTMLElement>;
}) {
  const { t, i18n } = useTranslation();
  const {
    sessions,
    projectMeta,
    sessionMeta,
    showArchived,
    displaySessionSort,
    activeProjectPath,
    taskTitle,
    filtered,
    compareSessions,
    pinnedSessions,
    pinnedSessionIds,
    projectEntries,
    projectEntriesByPath,
    projectFolderIndex,
  } = useSidebarProjects();
  const activeSessionId = useAppStore((s) => s.activeSessionId);
  const selectingSessionId = useAppStore((s) => s.selectingSessionId);
  const projectCollapsed = useAppStore((s) => s.projectCollapsed);
  const runningSessions = useAppStore((s) => s.runningSessions);
  const sessionOutcomes = useAppStore((s) => s.sessionOutcomes);
  const pendingPermissions = useAppStore((s) => s.pendingPermissions);
  const setPage = useAppStore((s) => s.setPage);
  const navBack = useAppStore((s) => s.navBack);
  const canNavBack = useAppStore((s) => s.canNavBack);
  const page = useAppStore((s) => s.page);
  const sidebarPinned = pagePinsSidebar(page);
  const settings = useAppStore((s) => s.settings);
  // Project headers must answer "is anything running under here?" while the
  // group is collapsed, so both affordances are resolved once per render
  // rather than re-derived per row.
  const runningAffordances = resolveSidebarRunningAffordances(settings);
  const prefetchSession = useAppStore((s) => s.prefetchSession);
  const selectSession = useAppStore((s) => s.selectSession);
  const newSession = useAppStore((s) => s.newSession);
  const forkSessionAction = useAppStore((s) => s.forkSession);
  const openProject = useAppStore((s) => s.openProject);
  const refreshProject = useAppStore((s) => s.refreshProject);
  const clearProject = useAppStore((s) => s.clearProject);
  const activateProject = useAppStore((s) => s.activateProject);
  const renameProject = useAppStore((s) => s.renameProject);
  const toggleSessionPinned = useAppStore((s) => s.toggleSessionPinned);
  const archiveSessionAction = useAppStore((s) => s.archiveSession);
  const restoreSession = useAppStore((s) => s.restoreSession);
  const renameSession = useAppStore((s) => s.renameSession);
  const deleteSessionAction = useAppStore((s) => s.deleteSession);
  const setSessionSort = useAppStore((s) => s.setSessionSort);
  const moveSessionProject = useAppStore((s) => s.moveSessionProject);
  const setSessionArchiveVisibility = useAppStore((s) => s.setSessionArchiveVisibility);
  const toggleProjectPinned = useAppStore((s) => s.toggleProjectPinned);
  const archiveProjectAction = useAppStore((s) => s.archiveProject);
  const restoreProject = useAppStore((s) => s.restoreProject);
  const setProjectCollapsed = useAppStore((s) => s.setProjectCollapsed);
  const setProjectSort = useAppStore((s) => s.setProjectSort);
  const reorderProjects = useAppStore((s) => s.reorderProjects);
  const showToast = useAppStore((s) => s.showToast);
  const setSettingsTab = useAppStore((s) => s.setSettingsTab);

  const [renameFor, setRenameFor] = useState<SessionSummary | null>(null);
  const [editProjectFor, setEditProjectFor] = useState<ProjectEntry | null>(null);
  const [deleteProjectFor, setDeleteProjectFor] = useState<ProjectEntry | null>(null);
  // Which row menu item is armed for its second, confirming click.
  const { armed: armedDelete, setArmed: setArmedDelete } = useArmedDelete();
  // Multi-select: Shift/Cmd+click session rows for batch operations.
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const lastClickedIdRef = useRef<string | null>(null);
  const {
    card: sessionHoverCard,
    show: revealSessionHoverCard,
    hide: hideSessionHoverCard,
    scheduleHide: scheduleSessionHoverCardHide,
    keepVisible: keepSessionHoverCardVisible,
    registerDismissGuard: registerSessionHoverCardDismissGuard,
  } = useSessionHoverCard();
  const {
    sortOpen,
    setSortOpen,
    sessionMenu,
    setSessionMenu,
    projectMenu,
    setProjectMenu,
    projectMenuKind,
    sectionMenu,
    setSectionMenu,
    menuPosition,
    menuTriggerRef,
    menuFirstItemRef,
    floatingMenuRef,
    closeMenus,
    placeMenu,
    placeMenuAtPoint,
    openSessionRowMenu,
    openProjectRowMenu,
    openSectionMenu,
  } = useSidebarMenus(hideSessionHoverCard);
  const [expandedProjectSessions, setExpandedProjectSessions] = useState<Record<string, boolean>>({});
  const [draggingSessionId, setDraggingSessionId] = useState<string | null>(null);
  const [dropProjectKey, setDropProjectKey] = useState<string | null>(null);
  const [projectsDropActive, setProjectsDropActive] = useState(false);
  const [windowFocused, setWindowFocused] = useState(true);

  const sessionPrefetchTimerRef = useRef<number | undefined>(undefined);

  const {
    sidebarResizing,
    startSidebarResize,
    moveSidebarResize,
    endSidebarResize,
    cancelSidebarResize,
    handleSidebarResizeKeyDown,
    resetSidebarWidth,
  } = useSidebarResize(
    sidebarWidth, widthMax, sidebarPinned, onWidthChange, onWidthCommit, onResizeCollapse,
  );

  // Mirror window focus onto the sidebar; a blurred window can keep CSS :hover
  // latched on the row under the cursor.
  useEffect(() => {
    const onWindowFocus = () => setWindowFocused(document.hasFocus());
    const onWindowBlur = () => setWindowFocused(false);
    window.addEventListener("focus", onWindowFocus);
    window.addEventListener("blur", onWindowBlur);
    return () => {
      window.removeEventListener("focus", onWindowFocus);
      window.removeEventListener("blur", onWindowBlur);
    };
  }, []);

  // Escape clears multi-select (only when no menu is open — menus consume
  // their own Escape first, so clearing happens on the next press).
  useEffect(() => {
    if (selectedIds.size === 0) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      // Let menu/sort close handlers consume Escape first.
      if (sessionMenu || projectMenu || sectionMenu || sortOpen) return;
      setSelectedIds(new Set());
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [selectedIds.size, sessionMenu, projectMenu, sectionMenu, sortOpen]);

  const selectedSessionId = selectingSessionId ?? activeSessionId;
  const {
    draggingProjectKey,
    dropIndicator,
    suppressProjectTitleClickRef,
    beginProjectReorderPress,
    moveProjectWithKeyboard,
    projectReorderRef,
  } = useProjectReorder(projectEntries, reorderProjects);
  const showSessionHoverCard = useCallback((
    session: SessionSummary,
    target: HTMLElement,
    temporary: boolean,
  ) => {
    const projectPath = session.projectPath ?? "";
    const normalizedProjectPath = normalizeProjectPath(projectPath);
    const entry = projectEntriesByPath.get(normalizedProjectPath ?? "");
    revealSessionHoverCard({
      session: { ...session, title: taskTitle(session.title) },
      target,
      temporary,
      space: isRemoteSession(session)
        ? `${session.remoteWorkspaceLabel ?? t("remote:workspace")} · ${session.remoteHostLabel ?? t("remote:remote")}`
        : temporary ? t("nav.hoverCardTemporarySpace") : entry?.name ?? projectName(projectPath),
      branch: entry?.branch,
    });
  }, [projectEntriesByPath, revealSessionHoverCard, t, taskTitle]);

  const temporarySessions = useMemo(
    () => filtered
      .filter((session) => !normalizeProjectPath(session.projectPath) && !(isRemoteSession(session) && session.remoteProjectId))
      .sort(compareSessions),
    [filtered, compareSessions],
  );
  const temporarySessionHistory = useMemo(
    () => temporarySessions.filter((session) => !pinnedSessionIds.has(session.id)),
    [temporarySessions, pinnedSessionIds],
  );
  const remoteProjectGroups = useMemo(() => groupRemoteProjectSessions(
    filtered.filter((session) => isRemoteSession(session) && !pinnedSessionIds.has(session.id)), compareSessions,
  ), [filtered, pinnedSessionIds, compareSessions]);
  // Flat ordered list of every visible session id — used for Shift+click range selection.
  const flatSessionOrder = useMemo(() => {
    const ids: string[] = [];
    // Pinned first (same order as rendered)
    for (const s of pinnedSessions) ids.push(s.id);
    // Then project sessions
    for (const entry of projectEntries) {
      for (const s of entry.sessions) {
        if (!pinnedSessionIds.has(s.id)) ids.push(s.id);
      }
    }
    for (const group of remoteProjectGroups) for (const session of group.sessions) ids.push(session.id);
    // Then temporary (standalone) sessions
    for (const s of temporarySessionHistory) ids.push(s.id);
    return ids;
  }, [pinnedSessions, projectEntries, pinnedSessionIds, temporarySessionHistory, remoteProjectGroups]);

  /** Handle multi-select click on a session row. Returns true if the click was consumed by multi-select. */
  const handleMultiSelectClick = (event: React.MouseEvent, sessionId: string): boolean => {
    const isMeta = event.metaKey || event.ctrlKey;
    const isShift = event.shiftKey;
    if (!isMeta && !isShift) {
      // Plain click: clear selection, let normal handler run.
      if (selectedIds.size > 0) setSelectedIds(new Set());
      lastClickedIdRef.current = sessionId;
      return false;
    }
    event.preventDefault();
    event.stopPropagation();
    if (isMeta && !isShift) {
      // Toggle individual item
      setSelectedIds((prev) => {
        const next = new Set(prev);
        if (next.has(sessionId)) next.delete(sessionId);
        else next.add(sessionId);
        return next;
      });
      lastClickedIdRef.current = sessionId;
      return true;
    }
    if (isShift) {
      // Range select from lastClickedId to current
      const anchor = lastClickedIdRef.current;
      if (!anchor) {
        setSelectedIds(new Set([sessionId]));
        lastClickedIdRef.current = sessionId;
        return true;
      }
      const startIdx = flatSessionOrder.indexOf(anchor);
      const endIdx = flatSessionOrder.indexOf(sessionId);
      if (startIdx === -1 || endIdx === -1) {
        setSelectedIds(new Set([sessionId]));
        lastClickedIdRef.current = sessionId;
        return true;
      }
      const lo = Math.min(startIdx, endIdx);
      const hi = Math.max(startIdx, endIdx);
      const range = flatSessionOrder.slice(lo, hi + 1);
      setSelectedIds((prev) => {
        const next = new Set(prev);
        for (const id of range) next.add(id);
        return next;
      });
      // Don't update lastClickedIdRef on shift-click so further shifts extend from same anchor
      return true;
    }
    return false;
  };

  // Clear multi-select when sessions list changes (e.g. after batch delete)
  const sessionIdSet = useMemo(() => new Set(sessions.map((s) => s.id)), [sessions]);
  useEffect(() => {
    if (selectedIds.size === 0) return;
    // Remove any selected ids that no longer exist
    let changed = false;
    const next = new Set<string>();
    for (const id of selectedIds) {
      if (sessionIdSet.has(id)) next.add(id);
      else changed = true;
    }
    if (changed) setSelectedIds(next);
  }, [sessionIdSet]); // intentionally not including selectedIds to avoid loop

  const renderSessionStatus = (status: SidebarSessionStatus) => {
    const labelKey =
      status === "running"
        ? "nav.sessionRunning"
        : status === "selected"
          ? "nav.sessionSelected"
          : status === "completed"
            ? "nav.sessionCompleted"
            : status === "failed"
              ? "nav.sessionFailed"
              : "nav.sessionPermission";
    const fallback =
      status === "running"
        ? "In progress"
        : status === "selected"
          ? "Selected"
          : status === "completed"
            ? "Completed"
            : status === "failed"
              ? "Failed"
              : "Permission required";
    const label = t(labelKey, { defaultValue: fallback });
    return (
      <span className={`thread-item-status ${status}`} aria-label={label} title={label}>
        {status === "completed" ? <IconCheck size={10} aria-hidden /> : null}
        {status === "failed" ? <IconCircleAlert size={11} aria-hidden /> : null}
      </span>
    );
  };

  const reportError = useCallback(
    (error: unknown) => {
      showToast(error instanceof Error ? error.message : String(error), {
        variant: "error",
      });
    },
    [showToast],
  );

  const focusComposer = useCallback(() => {
    requestAnimationFrame(() => {
      document.querySelector<HTMLTextAreaElement>(".composer-input")?.focus();
    });
  }, []);

  const selectProject = async (path: string): Promise<boolean> => {
    const normalized = normalizeProjectPath(path);
    if (!normalized) return false;
    if (normalized === activeProjectPath) return true;
    try {
      return Boolean(await activateProject(path));
    } catch (error) {
      reportError(error);
      return false;
    }
  };

  const selectProjectSession = async (session: SessionSummary): Promise<boolean> => {
    try {
      await selectSession(session.id);
      focusComposer();
      return true;
    } catch (error) {
      reportError(error);
      return false;
    }
  };

  const selectTemporarySession = async (sessionId: string) => {
    try {
      await selectSession(sessionId);
      focusComposer();
    } catch (error) {
      reportError(error);
    }
  };

  const scheduleSessionPrefetch = (sessionId: string) => {
    window.clearTimeout(sessionPrefetchTimerRef.current);
    sessionPrefetchTimerRef.current = window.setTimeout(() => {
      void prefetchSession(sessionId).catch(() => undefined);
    }, 120);
  };

  const cancelSessionPrefetch = () => {
    window.clearTimeout(sessionPrefetchTimerRef.current);
    sessionPrefetchTimerRef.current = undefined;
  };

  const openSessionFromHover = useCallback(async (sessionId: string) => {
    cancelSessionPrefetch();
    hideSessionHoverCard();
    try {
      // A dead reference must fail visibly instead of selecting an empty chat.
      // The store's session list is the cheapest complete existence signal; an
      // unknown id still gets one detail read so a stale list cannot block a
      // session that really exists.
      const known = useAppStore.getState().sessions.some((session) => session.id === sessionId);
      if (!known) {
        // Only presence is read from this reply, so ask for the smallest window
        // the host accepts. The uncapped read moved every message of the
        // session over IPC to answer one boolean.
        const detail = await api.getSession(sessionId, { messageLimit: 1 });
        if (!detail.session) {
          reportError(new Error(t("sessionCollaboration.sessionMissing")));
          return;
        }
      }
      await selectSession(sessionId);
      focusComposer();
    } catch (error) {
      reportError(error);
    }
  }, [focusComposer, hideSessionHoverCard, reportError, selectSession, t]);

  useEffect(() => cancelSessionPrefetch, []);

  const setCollapsed = (path: string, value: boolean) => {
    const normalized = normalizeProjectPath(path) || path;
    setProjectCollapsed(normalized, value);
    if (value) {
      setExpandedProjectSessions((previous) =>
        updateProjectSessionExpansion(previous, normalized, false),
      );
    }
  };

  const setSort = (next: SessionSort) => {
    setSessionSort(next);
    setProjectSort(next);
    closeMenus();
  };

  const toggleShowArchived = () => {
    const next = !showArchived;
    setSessionArchiveVisibility(next);
    closeMenus();
  };

  const expandProjectSessions = (projectKey: string) => {
    setExpandedProjectSessions((previous) =>
      updateProjectSessionExpansion(previous, projectKey, true),
    );
  };

  const toggleSessionPin = (session: SessionSummary) => {
    toggleSessionPinned(session.id);
    closeMenus(false);
    // Pinning moves a row between lists, replacing its previous DOM node.
    requestAnimationFrame(() => {
      const row = document.querySelector<HTMLElement>(
        `[data-sidebar-session-row="${CSS.escape(session.id)}"] [data-action="session-menu"]`,
      );
      const target = row && !row.closest('[aria-hidden="true"]')
        ? row
        : document.querySelector<HTMLElement>('[data-action="session-sort"]');
      target?.focus();
    });
  };

  const archiveSession = async (session: SessionSummary) => {
    const archived = sessionArchived(session, sessionMeta[session.id]);
    const wasActive = activeSessionId === session.id;
    const next =
      !archived && wasActive
        ? session.projectPath
          ? projectEntriesByPath
              .get(normalizeProjectPath(session.projectPath) ?? "")
              ?.sessions.find(
                (item) =>
                  item.id !== session.id &&
                  !sessionArchived(item, sessionMeta[item.id]),
              )
          : temporarySessions.find(
              (item) =>
                item.id !== session.id &&
                !sessionArchived(item, sessionMeta[item.id]),
            )
        : undefined;
    try {
      closeMenus();
      if (archived) {
        restoreSession(session.id);
        return;
      }
      if (wasActive && next) {
        if (!(await selectProjectSession(next))) return;
        archiveSessionAction(session.id);
        return;
      }
      if (wasActive) {
        // Archive first so an empty active slot is not reused as its own
        // replacement. Restore it if creating the fallback slot fails.
        archiveSessionAction(session.id);
        try {
          await newSession({ projectPath: session.projectPath ?? null });
        } catch (error) {
          restoreSession(session.id);
          throw error;
        }
        return;
      }
      archiveSessionAction(session.id);
    } catch (error) {
      reportError(error);
    }
  };

  const deleteSession = async (session: SessionSummary) => {
    closeMenus();
    const wasActive = activeSessionId === session.id;
    const sameScope = session.projectPath
      ? projectEntriesByPath.get(normalizeProjectPath(session.projectPath) ?? "")?.sessions ?? []
      : temporarySessions;
    const next = wasActive
      ? sameScope.find(
          (item) =>
            item.id !== session.id &&
            !sessionArchived(item, sessionMeta[item.id]),
        ) ?? projectEntries
          .flatMap((entry) => entry.sessions)
          .find(
            (item) =>
              item.id !== session.id &&
              !sessionArchived(item, sessionMeta[item.id]),
          )
      : undefined;
    try {
      await deleteSessionAction(session.id);
      if (wasActive) {
        if (next) await selectProjectSession(next);
        else await newSession({ projectPath: session.projectPath ?? null });
      }
    } catch (error) {
      reportError(error);
    }
  };

  /**
   * Two-step delete for one row's menu item. The first click arms the item and
   * relabels it; only the second click runs the delete, and the arm expires on
   * its own. The menu stays open between the two clicks.
   */
  const requestDeleteSession = (session: SessionSummary) => {
    if (armedDelete !== session.id) {
      setArmedDelete(session.id);
      return;
    }
    setArmedDelete(null);
    void deleteSession(session);
  };

  /** Batch delete: delete all selected sessions sequentially. */
  const batchDeleteSessions = async () => {
    const ids = [...selectedIds];
    if (ids.length === 0) return;
    closeMenus();
    const toDelete = sessions.filter(
      (s) => ids.includes(s.id) && s.source !== "pi-native",
    );
    for (const session of toDelete) {
      try {
        await deleteSessionAction(session.id);
      } catch (error) {
        reportError(error);
      }
    }
    // If we deleted the active session, create or select a fallback
    if (ids.includes(activeSessionId ?? "")) {
      const remaining = sessions.find(
        (s) => !ids.includes(s.id) && !sessionArchived(s, sessionMeta[s.id]),
      );
      try {
        if (remaining) await selectSession(remaining.id);
        else await newSession({ projectPath: null });
      } catch (error) {
        reportError(error);
      }
    }
    setSelectedIds(new Set());
  };

  /** Batch archive: archive all selected sessions. */
  const batchArchiveSessions = async () => {
    const ids = [...selectedIds];
    if (ids.length === 0) return;
    closeMenus();
    for (const id of ids) {
      const session = sessions.find((s) => s.id === id);
      if (!session) continue;
      const alreadyArchived = sessionArchived(session, sessionMeta[session.id]);
      if (alreadyArchived) continue;
      archiveSessionAction(id);
    }
    // If we archived the active session (and it wasn't already archived), select a fallback
    const activeWasArchived = (() => {
      if (!activeSessionId || !ids.includes(activeSessionId)) return false;
      const s = sessions.find((s) => s.id === activeSessionId);
      return s ? !sessionArchived(s, sessionMeta[s.id]) : false;
    })();
    if (activeWasArchived) {
      const remaining = sessions.find(
        (s) => !ids.includes(s.id) && !sessionArchived(s, sessionMeta[s.id]),
      );
      try {
        if (remaining) await selectSession(remaining.id);
        else await newSession({ projectPath: null });
      } catch (error) {
        reportError(error);
      }
    }
    setSelectedIds(new Set());
  };

  /** Always route project deletion through the explicit confirmation dialog. */
  const requestDeleteProject = (entry: ProjectEntry) => {
    closeMenus(false);
    setDeleteProjectFor(entry);
  };

  const openProjectFolder = async (entry: ProjectEntry) => {
    closeMenus(false);
    try {
      await api.openProjectFolder(entry.path);
    } catch (error) {
      reportError(error);
    }
  };

  const editProjectEntry = (entry: ProjectEntry, name: string) => {
    renameProject(entry.path, name);
  };

  const forkSession = async (session: SessionSummary) => {
    if (!sessionAllows(session, "canEditMessages")) return;
    closeMenus(false);
    try {
      await forkSessionAction(session.id);
      focusComposer();
    } catch (error) {
      reportError(error);
    }
  };

  const copyConversationId = async (session: SessionSummary) => {
    try {
      await navigator.clipboard.writeText(session.id);
      showToast(t("chat.copied"));
    } catch (error) {
      reportError(error);
    }
    closeMenus();
  };

  /**
   * The link another conversation references: pasting it into a Composer draft
   * carries a bounded excerpt of this conversation into that turn (issue #1324).
   */
  const copySessionLink = async (session: SessionSummary) => {
    try {
      await navigator.clipboard.writeText(formatSessionLink(session.id));
      showToast(t("chat.copied"));
    } catch (error) {
      reportError(error);
    }
    closeMenus();
  };

  const copyTextToClipboard = async (value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      showToast(t("chat.copied"));
    } catch (error) {
      reportError(error);
    }
    closeMenus();
  };

  const copySessionPath = async (session: SessionSummary) => {
    if (isRemoteSession(session)) return;
    try {
      const { path } = await api.getSessionScratchPath(session.id);
      await copyTextToClipboard(path);
    } catch (error) {
      reportError(error);
      closeMenus();
    }
  };

  const openSessionPath = async (session: SessionSummary) => {
    if (isRemoteSession(session)) return;
    closeMenus(false);
    try {
      await api.openSessionScratchPath(session.id);
    } catch (error) {
      reportError(error);
    }
  };

  const toggleProjectPin = (entry: ProjectEntry) => {
    toggleProjectPinned(entry.path);
    closeMenus();
  };

  const archiveProject = async (entry: ProjectEntry) => {
    const archived = Boolean(entry.meta.archived);
    const wasActive = entry.active;
    const next = !archived
      ? projectEntries.find(
          (candidate) =>
            candidate.key !== entry.key && !candidate.meta.archived,
        )
      : undefined;
    try {
      closeMenus();
      if (archived) {
        restoreProject(entry.path);
        return;
      }
      // Move the visible context before hiding the active project. This
      // prevents an archived, invisible project from remaining active.
      if (wasActive) {
        if (next) {
          if (!(await selectProject(next.path))) return;
        } else {
          await clearProject();
        }
      }
      archiveProjectAction(entry.path);
    } catch (error) {
      reportError(error);
    }
  };

  const createSession = async (options?: { projectPath?: string | null }) => {
    try {
      await newSession(options);
      focusComposer();
    } catch (error) {
      reportError(error);
    }
  };

  const createProjectSession = async (path: string) => {
    await createSession({ projectPath: path });
  };

  const openProjectPicker = async () => {
    try {
      await openProject();
    } catch (error) {
      reportError(error);
    }
  };

  const moveSessionToProject = useCallback(
    async (sessionId: string, projectPath: string, projectName: string) => {
      if (sessionId.startsWith("remote:")) return;
      // A running turn owns the current project's instructions, tools, and
      // working directory; the host rejects the move as well.
      if (runningSessions[sessionId]) {
        showToast(
          t("nav.moveRunningSessionBlocked", {
            defaultValue: "Stop the running session before moving it.",
          }),
          { variant: "warning" },
        );
        return;
      }
      try {
        const moved = await moveSessionProject(sessionId, projectPath);
        if (!moved) {
          showToast(
            t("nav.moveSessionUnavailable", {
              defaultValue: "This session cannot move to that project.",
            }),
            { variant: "warning" },
          );
          return;
        }
        showToast(
          t("nav.sessionMoved", {
            name: projectName,
            defaultValue: "Moved to " + projectName,
          }),
          { variant: "success" },
        );
      } catch (error) {
        reportError(error);
      }
    },
    [moveSessionProject, reportError, runningSessions, showToast, t],
  );

  /**
   * The row menu acts on the selection while a multi-selection is open, so the
   * panel's items come from the selection rather than from the clicked row.
   */
  const batchSelected = Boolean(
    sessionMenu && selectedIds.size > 1 && selectedIds.has(sessionMenu),
  );

  /**
   * Repository rows of the open menu. Both builders run every render, but they
   * key their probes and reads to the open target, so a closed menu reads
   * nothing; `onDone` is the sidebar's own close path.
   */
  const menuSession = sessionMenu
    ? sessions.find((item) => item.id === sessionMenu)
    : undefined;
  const sessionWorktreeItems = useWorktreeSessionMenuItems({
    sessionId: menuSession?.id ?? "",
    title: taskTitle(menuSession?.title),
    worktree: menuSession?.worktree,
    running: Boolean(menuSession && runningSessions[menuSession.id]),
    onDone: () => closeMenus(false),
  });
  const sessionDeleteLoss = useWorktreeDeleteLossText(
    menuSession && armedDelete === menuSession.id ? menuSession.id : "",
  );
  const menuProject = projectMenu
    ? projectEntries.find((item) => item.key === projectMenu)
    : undefined;
  const projectIsolationItems = useWorktreeProjectMenuItems({
    projectPath: menuProject?.path ?? "",
    projectName: menuProject?.name ?? "",
    onDone: () => closeMenus(false),
  });

  const onMenuKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    sidebarMenuKeyDown(event, closeMenus);
  };

  const menuSortLabel = (value: Exclude<SessionSort, "manual"> | "created") =>
    value === "recent"
      ? t("nav.sortRecent", { defaultValue: "Recently updated" })
      : value === "oldest"
        ? t("nav.sortOldest", { defaultValue: "Oldest first" })
        : value === "name"
          ? t("nav.sortName", { defaultValue: "Name" })
          : t("nav.sortCreated", { defaultValue: "Created date" });

  const sessionMenuContent = useCallback(
    (session: SessionSummary): SidebarMenuPanelContent => {
      const meta = sessionMeta[session.id] ?? {};
      const archived = sessionArchived(session, meta);
      const pinned = sessionPinned(session, meta);
      const native = session.source === "pi-native";
      const gitItems = [
        ...(native || !sessionAllows(session, "canEditMessages")
          ? []
          : [
              sidebarMenuAction({
                id: "fork-session",
                label: t("nav.createBranch"),
                icon: <IconBranch size={14} />,
                title: t("nav.createBranch"),
                disabled: Boolean(runningSessions[session.id]),
                onSelect: () => void forkSession(session),
              }),
            ]),
        ...sessionWorktreeItems,
      ];
      return {
        label: t("nav.sessionActions", { defaultValue: "Session actions" }),
        items: [
          ...(native
            ? []
            : [
                sidebarMenuAction({
                  id: "rename-session",
                  label: t("nav.renameTask", { defaultValue: "Rename task" }),
                  icon: <IconPencil size={14} />,
                  onSelect: () => {
                    closeMenus(false);
                    setRenameFor(session);
                  },
                }),
              ]),
          sidebarMenuAction({
            id: "toggle-session-pin",
            label: pinned
              ? t("nav.unpinTask", { defaultValue: "Unpin" })
              : t("nav.pinTask", { defaultValue: "Pin" }),
            icon: <IconPin size={14} />,
            onSelect: () => toggleSessionPin(session),
          }),
          sidebarMenuAction({
            id: "toggle-session-archive",
            label: archived
              ? t("nav.restoreTask", { defaultValue: "Restore" })
              : t("nav.archiveTask", { defaultValue: "Archive" }),
            icon: archived ? <IconArchiveRestore size={14} /> : <IconArchive size={14} />,
            onSelect: () => void archiveSession(session),
          }),
          ...(gitItems.length
            ? [
                sidebarMenuSubmenu({
                  id: "session-git",
                  label: t("worktree.menu.group", { defaultValue: "Git" }),
                  icon: <IconBranch size={14} />,
                  items: gitItems,
                }),
              ]
            : []),
          sidebarMenuSubmenu({
            id: "session-copy",
            label: t("chat.copy", { defaultValue: "Copy" }),
            icon: <IconCopy size={14} />,
            items: [
              sidebarMenuAction({
                id: "copy-conversation-id",
                label: t("nav.copyConversationId"),
                icon: <IconCopy size={14} />,
                onSelect: () => void copyConversationId(session),
              }),
              ...(!isRemoteSession(session)
                ? [
                    sidebarMenuAction({
                      id: "copy-session-path",
                      label: t("nav.copySessionPath"),
                      icon: <IconFolder size={14} />,
                      onSelect: () => void copySessionPath(session),
                    }),
                  ]
                : []),
              sidebarMenuAction({
                id: "copy-session-link",
                label: t("nav.copySessionLink"),
                icon: <IconCopy size={14} />,
                onSelect: () => void copySessionLink(session),
              }),
            ],
          }),
          ...(settings?.developerMode === true && !isRemoteSession(session)
            ? [
                sidebarMenuAction({
                  id: "open-session-path",
                  label: t("nav.openSessionPath"),
                  icon: <IconFolder size={14} />,
                  onSelect: () => void openSessionPath(session),
                }),
              ]
            : []),
          // mc-agent: a Pi CLI session can be deleted too; its file goes to the Trash.
          sidebarMenuSubmenu({
            id: "session-danger",
            label: t("nav.dangerZone", { defaultValue: "Danger zone" }),
            icon: <IconTrash size={14} />,
            items: [
              sidebarMenuAction({
                id: "delete-session",
                label: native
                  ? armedDelete === session.id
                    ? t("mcProject.deletePiSessionConfirm")
                    : t("mcProject.deletePiSession")
                  : armedDelete === session.id
                    ? t("nav.deleteTaskConfirm", { defaultValue: "Delete?" })
                    : t("nav.deleteTask", { defaultValue: "Delete" }),
                icon: <IconX size={14} />,
                danger: true,
                armed: armedDelete === session.id,
                onSelect: () => requestDeleteSession(session),
              }),
            ],
            notes: sessionDeleteLoss
              ? [{ id: "session-delete-loss", text: sessionDeleteLoss }]
              : undefined,
          }),
        ],
      };
    },
    [
      armedDelete,
      archiveSession,
      copyConversationId,
      copySessionPath,
      copySessionLink,
      forkSession,
      openSessionPath,
      requestDeleteSession,
      runningSessions,
      sessionDeleteLoss,
      sessionMeta,
      sessionWorktreeItems,
      settings?.developerMode,
      t,
      toggleSessionPin,
    ],
  );

  // mc-agent (#41): where a new task of a multi-folder project starts.
  const startFolderMenuContent = (entry: ProjectEntry): SidebarMenuPanelContent => ({
    label: t("mcProject.newTaskStartFolderMenu"),
    items: [
      sidebarMenuGroup({
        id: "project-start-folder",
        label: t("mcProject.newTaskStartFolderMenu"),
        options: projectStartFolderChoices(projectFolderIndex, entry.key, rememberedStartFolder).map(
          (choice) => ({
            id: `start-folder-${choice.path}`,
            label: choice.label,
            selected: choice.selected,
            onSelect: () => {
              closeMenus(false);
              rememberStartFolder(choice.groupId, choice.path);
              void createProjectSession(choice.path);
            },
          }),
        ),
      }),
    ],
  });

  const projectMenuContent = useCallback(
    (entry: ProjectEntry): SidebarMenuPanelContent => {
      const archived = Boolean(entry.meta.archived);
      return {
        label: t("project.openActions", { name: entry.name }),
        items: [
          sidebarMenuAction({
            id: "open-project-folder",
            label: t("project.openFolder", { defaultValue: "Open folder" }),
            icon: <IconFolder size={14} />,
            onSelect: () => void openProjectFolder(entry),
          }),
          sidebarMenuAction({
            id: "edit-project",
            label: t("project.edit", { defaultValue: "Edit project" }),
            icon: <IconPencil size={14} />,
            onSelect: () => {
              closeMenus(false);
              setEditProjectFor(entry);
            },
          }),
          sidebarMenuAction({
            id: "toggle-project-pin",
            label: entry.meta.pinned ? t("project.unpin") : t("project.pin"),
            icon: <IconPin size={14} />,
            onSelect: () => toggleProjectPin(entry),
          }),
          sidebarMenuAction({
            id: "toggle-project-archive",
            label: archived
              ? t("project.restore", { defaultValue: "Restore project" })
              : t("project.archive", { defaultValue: "Archive project" }),
            icon: archived ? <IconArchiveRestore size={14} /> : <IconArchive size={14} />,
            onSelect: () => void archiveProject(entry),
          }),
          sidebarMenuSubmenu({
            id: "project-copy",
            label: t("chat.copy", { defaultValue: "Copy" }),
            icon: <IconCopy size={14} />,
            items: [
              sidebarMenuAction({
                id: "copy-project-name",
                label: t("project.copyName"),
                icon: <IconCopy size={14} />,
                onSelect: () => void copyTextToClipboard(entry.name),
              }),
              sidebarMenuAction({
                id: "copy-project-path",
                label: t("project.copyPath"),
                icon: <IconFolder size={14} />,
                onSelect: () => void copyTextToClipboard(entry.displayPath ?? entry.path),
              }),
            ],
          }),
          sidebarMenuSubmenu({
            id: "project-git",
            label: t("worktree.menu.group", { defaultValue: "Git" }),
            icon: <IconBranch size={14} />,
            items: projectIsolationItems,
          }),
          sidebarMenuSubmenu({
            id: "project-danger",
            label: t("nav.dangerZone", { defaultValue: "Danger zone" }),
            icon: <IconTrash size={14} />,
            items: [
              sidebarMenuAction({
                id: "delete-project",
                label: t("project.delete", { defaultValue: "Delete project" }),
                icon: <IconTrash size={14} />,
                danger: true,
                onSelect: () => requestDeleteProject(entry),
              }),
            ],
          }),
        ],
      };
    },
    [
      archiveProject,
      openProjectFolder,
      projectIsolationItems,
      copyTextToClipboard,
      requestDeleteProject,
      t,
      toggleProjectPin,
    ],
  );

  const batchMenuContent = useCallback(
    (count: number): SidebarMenuPanelContent => ({
      label: t("nav.sessionActions", { defaultValue: "Session actions" }),
      hint: t("nav.batchSelectionHint", {
        defaultValue: "{{count}} sessions selected",
        count,
      }),
      items: [
        sidebarMenuAction({
          id: "batch-archive",
          label: t("nav.batchArchive", { defaultValue: "Archive {{count}} sessions", count }),
          icon: <IconArchive size={14} />,
          onSelect: () => void batchArchiveSessions(),
        }),
        sidebarMenuSubmenu({
          id: "batch-danger",
          label: t("nav.dangerZone", { defaultValue: "Danger zone" }),
          icon: <IconTrash size={14} />,
          items: [
            sidebarMenuAction({
              id: "batch-delete",
              label: armedDelete === "batch"
                ? t("nav.batchDeleteConfirm", { defaultValue: "Delete {{count}} sessions?", count })
                : t("nav.batchDelete", { defaultValue: "Delete {{count}} sessions", count }),
              icon: <IconTrash size={14} />,
              danger: true,
              armed: armedDelete === "batch",
              onSelect: () => {
                if (armedDelete !== "batch") {
                  setArmedDelete("batch");
                  return;
                }
                setArmedDelete(null);
                void batchDeleteSessions();
              },
            }),
          ],
        }),
      ],
    }),
    [armedDelete, batchArchiveSessions, batchDeleteSessions, t],
  );

  const sortMenuContent = useMemo(
    (): SidebarMenuPanelContent => ({
      label: t("nav.sortSessions", { defaultValue: "Sort sessions" }),
      items: [
        sidebarMenuGroup({
          id: "sort",
          label: t("nav.sortSessions", { defaultValue: "Sort sessions" }),
          options: (["recent", "oldest", "name", "created"] as const).map((value) => ({
            id: `sort-${value}`,
            label: menuSortLabel(value),
            selected: displaySessionSort === value,
            onSelect: () => setSort(value),
          })),
        }),
        sidebarMenuSection({
          id: "view",
          label: t("nav.viewOptions", { defaultValue: "View" }),
        }),
        sidebarMenuCheck({
          id: "toggle-show-archived",
          label: t("nav.showArchived", { defaultValue: "Show archived" }),
          checked: showArchived,
          onSelect: toggleShowArchived,
        }),
      ],
    }),
    [displaySessionSort, menuSortLabel, setSort, showArchived, t, toggleShowArchived],
  );

  const beginSessionDrag = useCallback(
    (event: ReactDragEvent<HTMLDivElement>, sessionId: string) => {
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData(SESSION_DRAG_MIME, sessionId);
      event.dataTransfer.setData("text/plain", sessionId);
      setDraggingSessionId(sessionId);
    },
    [],
  );

  const endSessionDrag = useCallback(() => {
    setDraggingSessionId(null);
    setDropProjectKey(null);
  }, []);

  // A dragged row can unmount before its own `dragend` fires (sort refresh,
  // archive, delete), which would otherwise leave the drag session and the
  // group highlight active for the next, unrelated drag.
  useEffect(() => {
    if (!draggingSessionId) return;
    const clearDragState = () => {
      setDraggingSessionId(null);
      setDropProjectKey(null);
    };
    window.addEventListener("dragend", clearDragState);
    window.addEventListener("drop", clearDragState, true);
    return () => {
      window.removeEventListener("dragend", clearDragState);
      window.removeEventListener("drop", clearDragState, true);
    };
  }, [draggingSessionId]);

  const sessionIdFromDrag = (dataTransfer: DataTransfer): string | null => {
    try {
      return dataTransfer.getData(SESSION_DRAG_MIME) || null;
    } catch {
      return null;
    }
  };

  const sessionIdForDragOver = (
    dataTransfer: DataTransfer,
    localSessionId: string | null,
  ): string | null => {
    if (!Array.from(dataTransfer.types).includes(SESSION_DRAG_MIME)) return null;
    return sessionIdFromDrag(dataTransfer) ?? localSessionId;
  };

  // A project group accepts a session row from another group. The current
  // group is not a drop target so a drag within one project is a no-op.
  const onProjectDropTargetOver = (
    event: ReactDragEvent<HTMLElement>,
    entry: ProjectEntry,
  ) => {
    const sessionId = sessionIdForDragOver(event.dataTransfer, draggingSessionId);
    if (!sessionId) return;
    const dragged = sessions.find((item) => item.id === sessionId);
    if (!dragged || normalizeProjectPath(dragged.projectPath) === entry.key) return;
    // mc-agent: a merged project is one drop target for all of its folders.
    if (entry.memberKeys?.includes(normalizeProjectPath(dragged.projectPath) ?? "")) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    setDropProjectKey(entry.key);
  };

  const onProjectDropTargetLeave = (entry: ProjectEntry) => {
    setDropProjectKey((current) => (current === entry.key ? null : current));
  };

  const onProjectDropTargetDrop = (
    event: ReactDragEvent<HTMLElement>,
    entry: ProjectEntry,
  ) => {
    // The transfer payload is authoritative: a stale dragging id must never
    // move a session the user did not drag.
    const sessionId = sessionIdFromDrag(event.dataTransfer);
    setDraggingSessionId(null);
    setDropProjectKey(null);
    const dragged = sessionId
      ? sessions.find((item) => item.id === sessionId)
      : undefined;
    // Without a session payload this is a native folder drop for the projects
    // list, which the container handles.
    if (!dragged) return;
    event.preventDefault();
    event.stopPropagation();
    void moveSessionToProject(dragged.id, entry.path, entry.name);
  };

  // Native folder drops on the projects list add or switch to that project.
  const onProjectsAreaDragOver = (event: ReactDragEvent<HTMLDivElement>) => {
    if (!hasComposerFileDrag(event.dataTransfer)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    setProjectsDropActive(true);
  };

  const onProjectsAreaDragLeave = (event: ReactDragEvent<HTMLDivElement>) => {
    const related = event.relatedTarget;
    if (related instanceof Node && event.currentTarget.contains(related)) return;
    setProjectsDropActive(false);
  };

  const onProjectsAreaDrop = async (event: ReactDragEvent<HTMLDivElement>) => {
    if (!hasComposerFileDrag(event.dataTransfer)) return;
    event.preventDefault();
    setProjectsDropActive(false);
    const directories = composerDropItems(event.dataTransfer, api.getDroppedFilePath)
      .filter((item) => item.isDirectory && item.path);
    if (!directories.length) {
      showToast(
        t("nav.dropFolderToAddProject", {
          defaultValue: "Drop a folder to add it as a project.",
        }),
        { variant: "warning" },
      );
      return;
    }
    for (const directory of directories) {
      try {
        await activateProject(directory.path!);
      } catch (error) {
        reportError(error);
      }
    }
  };

  const renderSessionRows = (
    items: SessionSummary[],
    options?: {
      temporary?: boolean;
      projectPath?: string;
      global?: boolean;
      showLastReplyDate?: boolean;
    },
  ) => items.map((session) => {
    const meta = sessionMeta[session.id] ?? {};
    const normalizedProjectPath = normalizeProjectPath(session.projectPath);
    const temporary = options?.temporary ?? !normalizedProjectPath;
    const owningProject = options?.global && normalizedProjectPath
      ? projectEntriesByPath.get(normalizedProjectPath)?.name
        ?? projectName(normalizedProjectPath, projectMetaFor(normalizedProjectPath, projectMeta).name)
      : t("nav.hoverCardTemporarySpace");
    const active = page === "chat" && selectedSessionId === session.id;
    // mc-agent: which folder of a multi-folder project the session started in.
    const startFolder = temporary ? null : sessionFolderLabel(session.projectPath, projectFolderIndex, normalizeProjectPath);
    const archived = sessionArchived(session, meta);
    const running = Boolean(runningSessions[session.id]);
    const hasPendingPermission = (pendingPermissions[session.id]?.length ?? 0) > 0;
    const status = sidebarSessionStatus({
      running,
      selected: active,
      outcome: sessionOutcomes[session.id],
      hasPendingPermission,
    });
    const lastReplyDate = options?.showLastReplyDate
      ? formatSessionLastReplyDate(
          session.updatedAt,
          new Date(),
          i18n.resolvedLanguage ?? i18n.language,
        )
      : "";
    return (
      <div
        key={session.id}
        className={`thread-item ${active ? "active" : ""} ${archived ? "archived" : ""} ${draggingSessionId === session.id ? "is-dragging" : ""} ${selectedIds.has(session.id) ? "selected" : ""}`}
        data-sidebar-session-row={session.id}
        draggable={!running && !isRemoteSession(session)}
        onDragStart={(event) => {
          if (running || isRemoteSession(session)) {
            event.preventDefault();
            return;
          }
          beginSessionDrag(event, session.id);
        }}
        onDragEnd={endSessionDrag}
        onClick={(event) => {
          const target = event.target as HTMLElement | null;
          if (target?.closest("button, [data-action]")) return;
          if (handleMultiSelectClick(event, session.id)) return;
          cancelSessionPrefetch();
          hideSessionHoverCard();
          void (temporary
            ? selectTemporarySession(session.id)
            : selectProjectSession(session));
        }}
        onContextMenu={(event) => {
          event.preventDefault();
          event.stopPropagation();
          // If right-clicking a non-selected row while multi-select is active,
          // add it to the selection instead of replacing.
          if (selectedIds.size > 0 && !selectedIds.has(session.id)) {
            setSelectedIds((prev) => new Set([...prev, session.id]));
          }
          placeMenuAtPoint(event.clientX, event.clientY);
          openSessionRowMenu(
            session.id,
            event.currentTarget.querySelector<HTMLButtonElement>(
              '[data-action="session-menu"]',
            ),
          );
        }}
      >
        {status ? renderSessionStatus(status) : null}
        <button
          type="button"
          className="thread-item-main"
          onPointerEnter={() => scheduleSessionPrefetch(session.id)}
          onPointerLeave={cancelSessionPrefetch}
          onFocus={() => void prefetchSession(session.id).catch(() => undefined)}
          onMouseEnter={(event) =>
            showSessionHoverCard(session, event.currentTarget, temporary)
          }
          onMouseLeave={scheduleSessionHoverCardHide}
          onFocusCapture={(event) =>
            showSessionHoverCard(session, event.currentTarget, temporary)
          }
          onBlur={scheduleSessionHoverCardHide}
          onClick={(event) => {
            if (handleMultiSelectClick(event, session.id)) return;
            cancelSessionPrefetch();
            hideSessionHoverCard();
            void (temporary
              ? selectTemporarySession(session.id)
              : selectProjectSession(session));
          }}
          aria-current={active ? "page" : undefined}
          aria-describedby={sessionHoverCard?.session.id === session.id ? `session-hover-${session.id}` : undefined}
        >
          {sessionPinned(session, meta) ? (
            <IconPin size={11} className="thread-item-pin" aria-hidden />
          ) : null}
          {session.source === "pi-native" ? (
            <span className="thread-item-source" title="Native Pi session">Pi</span>
          ) : null}
          {isRemoteSession(session) && <span className="thread-item-source" title={session.remoteHostLabel}>{t("remote:remote")}</span>}
          <WorktreeBadge worktree={session.worktree} sessionId={session.id} />
          {startFolder ? (
            <span className="thread-item-source mc-thread-folder" title={startFolder.path}>{startFolder.label}</span>
          ) : null}
          <span className="thread-item-title">{taskTitle(session.title)}</span>
          {options?.global ? (
            <span className="thread-item-project">
              {owningProject}
            </span>
          ) : null}
        </button>
        <div
          className={cx(
            "thread-item-meta",
            sessionMenu === session.id && "is-menu-open",
          )}
        >
          {lastReplyDate ? (
            <span className="thread-item-last-reply">{lastReplyDate}</span>
          ) : null}
          <TooltipButton
            type="button"
            className="thread-item-more"
            data-action="session-menu"
            tooltip={t("nav.sessionActions", { defaultValue: "Session actions" })}
            ariaLabel={t("nav.sessionActions", { defaultValue: "Session actions" })}
            aria-haspopup="menu"
            aria-expanded={sessionMenu === session.id}
            onClick={(event) => {
              event.stopPropagation();
              if (sessionMenu === session.id) {
                closeMenus();
                return;
              }
              placeMenu(event);
              openSessionRowMenu(session.id, event.currentTarget);
            }}
          >
            <IconMore size={14} />
          </TooltipButton>
        </div>
      </div>
    );
  });

  const renderProjectGroup = (entry: ProjectEntry) => {
    const collapsedProject = entry.meta.collapsed ?? projectCollapsed[entry.key] ?? false;
    const projectId = projectDomId(entry.key);
    const isMenuOpen = projectMenu === entry.key && projectMenuKind === "actions";

    // Show the initial page by default; the remaining sessions stay folded
    // behind the Load more affordance.
    const sessionsExpanded = expandedProjectSessions[entry.key] ?? false;
    const history = entry.sessions.filter((session) => !pinnedSessionIds.has(session.id));
    const { visibleSessions, hiddenCount } = getVisibleProjectSessions(
      history,
      sessionsExpanded,
    );

    // The live counts cover every session in the group, including pinned and
    // folded ones, because the header answers for the whole project.
    const runSummary = summarizeProjectRuns(
      entry.sessions,
      runningSessions,
      pendingPermissions,
    );
    const runIsLive = projectRunSummaryIsLive(runSummary);
    const showRunBadge = runningAffordances.badge && runIsLive;
    const showRunRail = runningAffordances.rail && runIsLive;

    const renderProjectSessions = (sessions: SessionSummary[]) => {
      const result: React.ReactNode[] = [
        ...renderSessionRows(sessions, {
          projectPath: entry.path,
      showLastReplyDate: settings?.sidebarSessionTime === true,
        }),
      ];
      // Add "load more" button if there are hidden sessions
      if (hiddenCount > 0) {
        result.push(
          <button
            key="load-more"
            type="button"
            className="sidebar-load-more"
            onClick={() => expandProjectSessions(entry.key)}
          >
            {t("nav.loadMoreCount", { count: hiddenCount })}
          </button>
        );
      }
      return result;
    };

    return (
      <section
        key={entry.key}
        className={`sidebar-session-group project-group ${entry.meta.archived ? "archived" : ""} ${runIsLive ? "has-running-sessions" : ""} ${showRunRail ? "has-run-rail" : ""} ${collapsedProject ? "is-collapsed" : ""} ${dropProjectKey === entry.key ? "is-drop-target" : ""} ${draggingProjectKey === entry.key ? "is-dragging" : ""} ${dropIndicator?.key === entry.key ? (dropIndicator.insertAfter ? "is-drop-after" : "is-drop-before") : ""}`}
        aria-labelledby={projectId}
        data-sidebar-project-group={entry.key}
        data-current-workspace={entry.active ? "true" : undefined}
        onDragOver={(event) => {
          onProjectDropTargetOver(event, entry);
        }}
        onDragLeave={(event) => {
          const relatedTarget = event.relatedTarget;
          if (relatedTarget instanceof Node && event.currentTarget.contains(relatedTarget)) {
            return;
          }
          onProjectDropTargetLeave(entry);
        }}
        onDrop={(event) => {
          onProjectDropTargetDrop(event, entry);
        }}
      >
        {showRunRail ? <ProjectRunRail summary={runSummary} /> : null}
        <div
          className="sidebar-session-group-header"
          onClick={(event) => {
            // Same one-target rule as a session row: the header's own controls
            // stay the only spelled-out targets, so the gutter next to a hidden
            // control still activates and toggles the group.
            const target = event.target as HTMLElement | null;
            if (target?.closest("button, [data-action]")) return;
            void (async () => {
              if (!entry.active && !(await selectProject(entry.path))) return;
              setCollapsed(entry.path, !collapsedProject);
            })();
          }}
          onContextMenu={(event) => {
            if (projectReorderRef.current) {
              event.preventDefault();
              event.stopPropagation();
              return;
            }
            event.preventDefault();
            event.stopPropagation();
            placeMenuAtPoint(event.clientX, event.clientY);
            openProjectRowMenu(
              entry.key,
              event.currentTarget.querySelector<HTMLButtonElement>(
                ".project-more",
              ),
            );
          }}
        >
          <TooltipButton
            type="button"
            id={projectId}
            className="sidebar-session-group-title project-toggle"
            tooltip={entry.displayPath ?? entry.path}
            tooltipDelayMs={500}
            tooltipClassName="ui-tooltip-path"
            ariaLabel={entry.name}
            aria-describedby={`${projectId}-path-description`}
            aria-expanded={!collapsedProject}
            aria-controls={`${projectId}-sessions`}
            aria-keyshortcuts="ArrowUp ArrowDown"
            aria-grabbed={draggingProjectKey === entry.key}
            data-action="toggle-project-collapse"
            onDragStart={(event) => event.preventDefault()}
            onPointerDown={(event) => beginProjectReorderPress(event, entry.key)}
            onKeyDown={(event) => moveProjectWithKeyboard(event, entry.key)}
            onClick={() => {
              if (suppressProjectTitleClickRef.current) {
                suppressProjectTitleClickRef.current = false;
                return;
              }
              void (async () => {
                if (!entry.active && !(await selectProject(entry.path))) return;
                setCollapsed(entry.path, !collapsedProject);
              })();
            }}
          >
            <IconChevronDown
              size={13}
              className={`sidebar-disclosure-icon ${collapsedProject ? "collapsed" : ""}`}
            />
            {entry.meta.pinned ? (
              <IconStar
                size={13}
                fill="currentColor"
                className="sidebar-project-pin"
                aria-hidden
              />
            ) : (
              <IconFolder size={13} aria-hidden />
            )}
            <span>{entry.name}</span>
            {showRunBadge ? <ProjectRunBadge summary={runSummary} /> : null}
            {showRunRail ? <ProjectRunCount summary={runSummary} /> : null}
            {entry.active ? <span className="sidebar-project-active-dot" aria-label={t("project.active", { defaultValue: "Active" })} /> : null}
          </TooltipButton>
          <span id={`${projectId}-path-description`} className="sr-only">
            {entry.displayPath ?? entry.path}
            {". "}
            {t("project.reorder", { name: entry.name, defaultValue: "Reorder {{name}}" })}
          </span>
          <div className="sidebar-menu-wrap">
            <TooltipButton
              type="button"
              className="thread-item-more project-more"
              tooltip={t("project.openActions", { name: entry.name })}
              ariaLabel={t("project.openActions", { name: entry.name })}
              aria-haspopup="menu"
              aria-expanded={isMenuOpen}
              onClick={(event) => {
                event.stopPropagation();
                if (isMenuOpen) {
                  closeMenus();
                  return;
                }
                placeMenu(event);
                openProjectRowMenu(entry.key, event.currentTarget);
              }}
            >
              <IconMore size={14} />
            </TooltipButton>
          </div>
          <TooltipButton
            type="button"
            className="sidebar-session-group-add"
            tooltip={entry.active ? t("project.newTask") : t("project.openAndNewTask", { defaultValue: "Open project and create task" })}
            ariaLabel={entry.active ? t("project.newTask") : t("project.openAndNewTask", { defaultValue: "Open project and create task" })}
            onClick={(event) => {
              // mc-agent (#41): a project with several folders asks where the
              // new task starts; one folder starts right away as before.
              if (projectStartFolderChoices(projectFolderIndex, entry.key, rememberedStartFolder).length > 1) {
                event.stopPropagation();
                if (projectMenu === entry.key && projectMenuKind === "startFolder") {
                  closeMenus();
                  return;
                }
                placeMenu(event);
                openProjectRowMenu(entry.key, event.currentTarget, "startFolder");
                return;
              }
              void createProjectSession(entry.path);
            }}
          >
            <IconNewSession size={13} />
          </TooltipButton>
        </div>
        <div
          id={`${projectId}-sessions`}
          className={`sidebar-session-group-body project ${collapsedProject ? "collapsed" : ""}`}
          role="region"
          aria-hidden={collapsedProject}
          inert={collapsedProject ? true : undefined}
        >
          <div className="sidebar-session-group-clip">
            <div className="sidebar-session-group-list">
              {entry.sessions.length > 0 ? renderProjectSessions(visibleSessions) : (
                <div className="sidebar-session-empty">{t("nav.noProjectSessions")}</div>
              )}
            </div>
          </div>
        </div>
      </section>
    );
  };

  /**
   * One panel renders whatever menu is open. The content builders above decide
   * which rows exist, so this stays placement and nothing else.
   */
  const renderFloatingMenu = () => {
    if (!menuPosition || typeof document === "undefined") return null;
    const position = { top: menuPosition.top, left: menuPosition.left };
    const session = sessionMenu
      ? sessions.find((item) => item.id === sessionMenu)
      : undefined;
    const entry = projectMenu
      ? projectEntries.find((item) => item.key === projectMenu)
      : undefined;
    if (sectionMenu) {
      const isSessions = sectionMenu === "sessions";
      return portalToBody(
        <SidebarMenuPanel
          menuRef={floatingMenuRef}
          firstItemRef={menuFirstItemRef}
          className="sidebar-section-menu"
          position={position}
          onKeyDown={onMenuKeyDown}
          content={{
            label: isSessions ? t("nav.newTemporarySession") : t("nav.newProject"),
            items: [
              sidebarMenuAction({
                id: isSessions ? "new-standalone-session" : "new-project",
                label: isSessions
                  ? t("nav.newTemporarySession")
                  : t("nav.newProject"),
                icon: isSessions
                  ? <IconNewSession size={14} />
                  : <IconNewProject size={14} />,
                onSelect: () => {
                  closeMenus(false);
                  if (isSessions) void createSession({ projectPath: null });
                  else void openProjectPicker();
                },
              }),
              // mc-agent (MC-ADR-0023): describe the project in a chat instead.
              ...(isSessions
                ? []
                : [
                    sidebarMenuAction({
                      id: "new-project-by-conversation",
                      label: t("mcProject.npSidebarAction"),
                      icon: <IconSparkles size={14} />,
                      onSelect: () => {
                        closeMenus(false);
                        void startConversationalProject();
                      },
                    }),
                  ]),
            ],
          }}
        />,
      );
    }
    if (sortOpen) {
      return portalToBody(
        <SidebarMenuPanel
          menuRef={floatingMenuRef}
          firstItemRef={menuFirstItemRef}
          className="sidebar-sort-menu"
          position={position}
          onKeyDown={onMenuKeyDown}
          content={sortMenuContent}
        />,
      );
    }
    if (session) {
      return portalToBody(
        <SidebarMenuPanel
          menuRef={floatingMenuRef}
          firstItemRef={menuFirstItemRef}
          position={position}
          onKeyDown={onMenuKeyDown}
          content={
            batchSelected
              ? batchMenuContent(selectedIds.size)
              : sessionMenuContent(session)
          }
        />,
      );
    }
    if (entry) {
      const content =
        projectMenuKind === "startFolder" ? startFolderMenuContent(entry) : projectMenuContent(entry);
      return portalToBody(
        <SidebarMenuPanel
          menuRef={floatingMenuRef}
          firstItemRef={menuFirstItemRef}
          position={position}
          onKeyDown={onMenuKeyDown}
          content={content}
        />,
      );
    }
    return null;
  };

  return (
    <aside
      className={cx("sidebar", "sidebar-surface", className)}
      data-window-blur={windowFocused ? undefined : "true"}
      onAnimationEnd={onAnimationEnd}
    >
      <div className="sidebar-header">
        <TooltipButton
          type="button"
          className="brand no-drag"
          data-nav="home"
          tooltip={t("nav.home")}
          ariaLabel={t("nav.home")}
          onClick={() => setPage("chat")}
        >
          <BrandLogo size={20} />
          <span>{t("app.shellName")}</span>
        </TooltipButton>
        <div className="sidebar-header-actions no-drag">
          {sidebarPinned ? null : (
            <TooltipButton
              type="button"
              className="icon-btn icon-btn-square"
              tooltip={
                sidebarToggleShortcut
                  ? `${t("nav.collapseSidebar")} (${sidebarToggleShortcut})`
                  : t("nav.collapseSidebar")
              }
              ariaLabel={t("nav.collapseSidebar")}
              aria-expanded={true}
              data-nav="toggle-sidebar"
              onClick={onToggleSidebar}
            >
              <IconSidebar size={15} />
            </TooltipButton>
          )}
        </div>
      </div>

      <div className="sidebar-body no-drag">
        <SidebarAttentionFeed />

        {pinnedSessions.length > 0 ? (
          <section
            className="sidebar-pinned-sessions"
            aria-labelledby="sidebar-pinned-label"
            data-sidebar-session-section="pinned"
          >
            <div className="sidebar-list-toolbar sidebar-list-toolbar-secondary">
              <span id="sidebar-pinned-label" className="sidebar-list-label">
                {t("nav.pinnedSessions")}
              </span>
            </div>
            <div className="sidebar-session-group-body pinned" onScroll={() => closeMenus(false)}>
              {renderSessionRows(pinnedSessions, { global: true })}
            </div>
          </section>
        ) : null}

        <section
          className="sidebar-standalone-sessions"
          aria-labelledby="sidebar-standalone-sessions-label"
          data-sidebar-session-section="temporary"
        >
          <div
            className="sidebar-list-toolbar sidebar-list-toolbar-secondary"
            data-sidebar-section="sessions"
            onContextMenu={(event) => {
              event.preventDefault();
              event.stopPropagation();
              openSectionMenu("sessions", event.clientX, event.clientY);
            }}
            onPointerDown={(event) => {
              // Keep native drag/text selection from eating the secondary click path.
              if (event.button === 2) event.preventDefault();
            }}
          >
            <span id="sidebar-standalone-sessions-label" className="sidebar-list-label">
              {t("nav.sessions", { defaultValue: "Sessions" })}
            </span>
            <div className="sidebar-toolbar-actions">
              <div className="sidebar-menu-wrap">
                <TooltipButton
                  type="button"
                  className={`sidebar-toolbar-button ${sortOpen ? "active" : ""}`}
                  data-action="session-sort"
                  ariaLabel={t("nav.sortSessions", { defaultValue: "Sort sessions" })}
                  tooltip={t("nav.sortSessions", { defaultValue: "Sort sessions" })}
                  aria-haspopup="menu"
                  aria-expanded={sortOpen}
                  onClick={(event) => {
                    if (sortOpen) {
                      closeMenus();
                      return;
                    }
                    placeMenu(event);
                    menuTriggerRef.current = event.currentTarget;
                    setSessionMenu(null);
                    setProjectMenu(null);
                    setSectionMenu(null);
                    setSortOpen(true);
                  }}
                >
                  <IconArrowUpDown size={14} />
                </TooltipButton>
              </div>
              <TooltipButton
                type="button"
                className="sidebar-toolbar-button"
                data-action="new-standalone-session"
                tooltip={t("nav.newTemporarySession")}
                ariaLabel={t("nav.newTemporarySession")}
                onClick={() => void createSession({ projectPath: null })}
              >
                <IconNewSession size={14} />
              </TooltipButton>
            </div>
          </div>
          <div
            className="sidebar-session-group-body standalone"
            onScroll={() => {
              if (sessionMenu || projectMenu || sectionMenu || sortOpen) closeMenus(false);
            }}
            onContextMenu={(event) => {
              if ((event.target as Element).closest?.("[data-sidebar-session-row]")) return;
              event.preventDefault();
              event.stopPropagation();
              openSectionMenu("sessions", event.clientX, event.clientY);
            }}
          >
            {temporarySessionHistory.length > 0 ? (
              renderSessionRows(temporarySessionHistory, { temporary: true })
            ) : temporarySessions.length === 0 ? (
              <div className="sidebar-session-empty">{t("nav.noTemporarySessions")}</div>
            ) : null}
          </div>
        </section>

        <div
          className="sidebar-list-toolbar"
          data-sidebar-section="projects"
          onContextMenu={(event) => {
            event.preventDefault();
            event.stopPropagation();
            openSectionMenu("projects", event.clientX, event.clientY);
          }}
          onPointerDown={(event) => {
            if (event.button === 2) event.preventDefault();
          }}
        >
          <span className="sidebar-list-label">{t("nav.projects")}</span>
          <TooltipButton
            type="button"
            className="sidebar-toolbar-button"
            data-action="new-project"
            tooltip={t("nav.newProject")}
            ariaLabel={t("nav.newProject")}
            onClick={() => void openProjectPicker()}
          >
            <IconNewProject size={14} />
          </TooltipButton>
          {/* mc-agent (MC-ADR-0009): projects and conversations from other agents. */}
          <TooltipButton
            type="button"
            className="sidebar-toolbar-button"
            data-action="import-projects"
            tooltip={t("mcProject.importOpen")}
            ariaLabel={t("mcProject.importOpen")}
            onClick={openProjectImportDialog}
          >
            <IconDownload size={14} />
          </TooltipButton>
        </div>

        <div
          className={`sidebar-session-groups min-h-0 flex-1 overflow-auto px-0.5 ${projectsDropActive ? "is-drop-target" : ""}`}
          onScroll={() => {
            if (sessionMenu || projectMenu || sectionMenu || sortOpen) closeMenus(false);
          }}
          onContextMenu={(event) => {
            if (
              (event.target as Element).closest?.(
                "[data-sidebar-session-row], [data-sidebar-project-group]",
              )
            ) {
              return;
            }
            event.preventDefault();
            event.stopPropagation();
            openSectionMenu("projects", event.clientX, event.clientY);
          }}
          onDragEnter={(event) => {
            if (hasComposerFileDrag(event.dataTransfer)) event.preventDefault();
          }}
          onDragOver={onProjectsAreaDragOver}
          onDragLeave={onProjectsAreaDragLeave}
          onDrop={onProjectsAreaDrop}
        >
          {projectEntries.length > 0 ? projectEntries.map(renderProjectGroup) : (
            <section className="sidebar-session-group" aria-labelledby="sidebar-project-group-label">
              <div className="sidebar-session-group-header">
                <button type="button" id="sidebar-project-group-label" className="sidebar-session-group-title" onClick={() => void openProjectPicker()}>
                  <IconFolder size={13} />
                  <span>{t("project.open")}</span>
                </button>
              </div>
            </section>
          )}
          <RemoteProjectGroups groups={remoteProjectGroups}
            renderSessions={(sessions) => renderSessionRows(sessions, {
              temporary: false,
              showLastReplyDate: settings?.sidebarSessionTime === true,
            })} />
        </div>

        {/* mc-agent (bugs.md B-013): no footer. Plugins, scheduled, notifications,
            settings and updates live in the app rail; upstream's version chip
            showed PI-Desktop's version. */}
      </div>
      {/* mc-agent: pages such as settings put their navigation here. */}
      <SidebarSlotHost />
      <SidebarFooter />
      {renderFloatingMenu()}
      {sessionHoverCard ? (
        <SessionHoverCard
          key={sessionHoverCard.session.id}
          card={sessionHoverCard}
          runningSessions={runningSessions}
          pendingPermissions={pendingPermissions}
          refreshProject={refreshProject}
          onOpenSession={openSessionFromHover}
          keepVisible={keepSessionHoverCardVisible}
          scheduleHide={scheduleSessionHoverCardHide}
          registerDismissGuard={registerSessionHoverCardDismissGuard}
        />
      ) : null}
      <WorktreeDialogs />
      <WorktreeBehindWatcher />
      {renameFor ? (
        <SessionRenameDialog
          session={renameFor}
          onClose={() => setRenameFor(null)}
          onSave={(title) => renameSession(renameFor.id, title)}
          onError={reportError}
        />
      ) : null}
      {editProjectFor ? (
        <ProjectEditDialog
          project={editProjectFor}
          onClose={() => setEditProjectFor(null)}
          onSaved={(group) => {
            editProjectEntry(editProjectFor, group.name);
            // A promoted primary owns the group name from now on, so the entry
            // that opens there later already carries it.
            if (
              normalizeProjectPath(editProjectFor.path) !==
              normalizeProjectPath(group.primaryPath)
            ) {
              renameProject(group.primaryPath, group.name);
            }
          }}
          onError={reportError}
        />
      ) : null}
      {deleteProjectFor ? (
        <ProjectDeleteDialog
          project={{
            name: deleteProjectFor.name,
            path: deleteProjectFor.path,
            sessionCount: deleteProjectFor.sessions.length,
          }}
          runningSessionIds={deleteProjectFor.sessions
            .filter((session) => runningSessions[session.id] === true)
            .map((session) => session.id)}
          onClose={() => setDeleteProjectFor(null)}
          onDeleted={() => {
            setDeleteProjectFor(null);
            showToast(t("project.deleted", { name: deleteProjectFor.name }), {
              variant: "success",
            });
          }}
          onError={reportError}
        />
      ) : null}
      <div
        className={cx("sidebar-resize-handle no-drag", sidebarResizing && "is-resizing")}
        role="separator"
        aria-orientation="vertical"
        aria-label={t("nav.resizeSidebar")}
        aria-valuemin={SIDEBAR_WIDTH_MIN}
        aria-valuemax={clampSidebarWidth(widthMax, widthMax)}
        aria-valuenow={clampSidebarWidth(sidebarWidth, widthMax)}
        aria-valuetext={t("nav.sidebarWidth", { width: clampSidebarWidth(sidebarWidth, widthMax) })}
        tabIndex={0}
        onPointerDown={startSidebarResize}
        onPointerMove={moveSidebarResize}
        onPointerUp={endSidebarResize}
        onPointerCancel={cancelSidebarResize}
        onLostPointerCapture={cancelSidebarResize}
        onKeyDown={handleSidebarResizeKeyDown}
        onDoubleClick={resetSidebarWidth}
      />
    </aside>
  );
}
