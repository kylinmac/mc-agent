import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { SessionCollaborationSummary, SessionContextBreakdown } from "@pi-desktop/shared";
import { api } from "../../lib/api";
import { useAppStore } from "../../stores/app-store";
import { latestTurnContextInspector } from "../../lib/latest-turn-context";
import { calculateContextUsage } from "../../lib/context-usage";
import { reviewChangesFromMessages, summarizeReviewChanges } from "../../lib/workspace-review";
import { toolWorkPanelTab } from "../../lib/work-panel-tabs";
import { normalizeProjectPath } from "../../lib/sidebar-session-groups";
import { isRemoteSession } from "../../lib/remote-session-safety";
import type { SettingsTabId } from "../../lib/settings-search";
import { CapabilityDialog, type CapabilityKind } from "./CapabilityDialog";
import { ProjectMemoryDialog } from "../../components/ProjectMemoryDialog";
import { ProjectInstructionsDialog } from "../../components/ProjectInstructionsDialog";
import { SystemPromptDialog } from "./SystemPromptDialog";
import { formatElapsed, sessionSubagents } from "./session-subagents";
import { focusBackgroundShell, useBackgroundShells } from "../work-tools/background-shells";
import { backgroundTab } from "../work-tools/tool-tabs";
import { expandPane } from "../work-tools/pane-layout";
import { IconChevronDown, IconChevronRight, IconFolder, IconInfo } from "../../components/icons";
import { useProjectFolderIndex } from "../project-sidebar/useProjectFolderIndex";
import { sessionFolderLabel } from "../project-sidebar/project-merge";
import {
  breakdownRows,
  clampPanelWidth,
  DEFAULT_PREFS,
  conversationOffset,
  panelMode,
  readPrefs,
  reorderSections,
  savePrefs,
  SECTION_IDS,
  toggleIn,
  type BreakdownRowKey,
  type PanelPrefs,
  type SectionId,
} from "./session-info-model";

function compact(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}k`;
  return String(tokens);
}

function folderName(path?: string | null): string {
  return (path ?? "").split(/[\\/]/).filter(Boolean).at(-1) ?? "";
}

/** What a context category opens: a capability dialog or a settings page. */
const ROW_ACTIONS: Partial<
  Record<
    BreakdownRowKey,
    { dialog?: CapabilityKind; settings?: SettingsTabId; project?: "memory" | "instructions"; systemPrompt?: true }
  >
> = {
  systemPrompt: { systemPrompt: true },
  tools: { dialog: "tools" },
  mcpTools: { dialog: "mcp" },
  skills: { dialog: "skills" },
  // The project's own editors, the ones the projects page opens.
  projectInstructions: { project: "instructions" },
  memory: { project: "memory" },
};

const EMPTY_NAMES: string[] = [];

const EXPANDABLE: Partial<Record<BreakdownRowKey, keyof SessionContextBreakdown>> = {
  tools: "toolNames",
  mcpTools: "mcpToolNames",
  skills: "skillNames",
};

/*
  mc-agent: session information beside the conversation, after the session
  panel of desktop agents (MC-ADR-0004). One button at the top-left opens
  and closes it; docked when the main pane is wide enough (the conversation
  narrows to make room), floating over the conversation otherwise. Sections fold, reorder by dragging their title, and can
  be hidden from the "…" menu; the right edge drags to resize. Layout lives
  in this browser profile. The context section splits usage by kind
  (estimated by the agent runtime) and offers a manual compaction.
*/
const OPEN_KEY = "mc.sessionInfoOpen";
/** The button's left inset plus the space kept after it, less the dock gap the offset adds. */
const BUTTON_GAP = 12 + 8 - 16;
const OPEN_KEEP = 200;
const EMPTY_MESSAGES: never[] = [];

/** Whether the panel is open, per conversation; the last choice is the default for others. */
function readOpenMap(): Record<string, boolean> {
  try {
    const raw = JSON.parse(localStorage.getItem(OPEN_KEY) ?? "{}") as unknown;
    if (!raw || typeof raw !== "object") return {};
    return Object.fromEntries(Object.entries(raw).filter((entry): entry is [string, boolean] => typeof entry[1] === "boolean"));
  } catch {
    return {};
  }
}

function saveOpenMap(map: Record<string, boolean>): void {
  try {
    localStorage.setItem(OPEN_KEY, JSON.stringify(Object.fromEntries(Object.entries(map).slice(-OPEN_KEEP))));
  } catch {
    // best-effort persistence
  }
}

/*
  Each conversation has its own panel (MC-ADR-0007): in a split view every
  column renders one for its session (`scope="column"`), and docked or
  floating follows that column's width. Actions that work on the active
  session (compaction, opening a tool) focus the column first.
*/
export function SessionInfo({
  sessionId: sessionProp,
  scope = "pane",
}: { sessionId?: string; scope?: "pane" | "column" } = {}) {
  const { t } = useTranslation();
  const [prefs, setPrefsState] = useState<PanelPrefs>(readPrefs);
  const [paneWidth, setPaneWidth] = useState(0);
  const [menuOpen, setMenuOpen] = useState(false);
  const [dragging, setDragging] = useState<SectionId | null>(null);
  const [dropTarget, setDropTarget] = useState<SectionId | null>(null);
  const [expanded, setExpanded] = useState<BreakdownRowKey | null>(null);
  const [capability, setCapability] = useState<CapabilityKind | null>(null);
  const [promptOpen, setPromptOpen] = useState(false);
  const [projectEditor, setProjectEditor] = useState<"memory" | "instructions" | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const activeSessionId = useAppStore((s) => s.activeSessionId);
  const sessionId = sessionProp ?? activeSessionId;
  const focused = sessionId === activeSessionId;
  const container = scope === "column" ? ".mc-split-chat" : ".main-pane";
  const sessions = useAppStore((s) => s.sessions);
  const activeWorkspace = useAppStore((s) => s.workspace);
  const messages = useAppStore((s) =>
    s.activeSessionId === sessionId
      ? s.messages
      : ((sessionId ? s.retainedTranscripts[sessionId] : undefined) ?? EMPTY_MESSAGES),
  );
  const isRunning = useAppStore((s) =>
    s.activeSessionId === sessionId ? s.isRunning : Boolean(sessionId && s.runningSessions[sessionId]),
  );
  const providers = useAppStore((s) => s.providers);
  const providerModels = useAppStore((s) => s.providerModels);
  const compactions = useAppStore((s) => (sessionId ? s.sessionCompactions[sessionId] : undefined));
  const openWorkPanelTab = useAppStore((s) => s.openWorkPanelTab);
  const selectSession = useAppStore((s) => s.selectSession);
  const openSubagentTab = useAppStore((s) => s.openSubagentTab);
  const compactContext = useAppStore((s) => s.compactContext);
  const session = sessions.find((candidate) => candidate.id === sessionId);
  // The active workspace describes the active session, and any other in the
  // same folder.
  const workspace =
    focused ||
    (session?.projectPath &&
      normalizeProjectPath(session.projectPath) === normalizeProjectPath(activeWorkspace?.path))
      ? activeWorkspace
      : null;
  const [openMap, setOpenMap] = useState(readOpenMap);
  const open = sessionId !== undefined && openMap[sessionId] !== undefined ? openMap[sessionId] : prefs.open;
  const setOpen = (value: boolean) => {
    if (sessionId) {
      setOpenMap((current) => {
        const { [sessionId]: _previous, ...rest } = current;
        const next = { ...rest, [sessionId]: value };
        saveOpenMap(next);
        return next;
      });
    }
    setPrefs((current) => ({ ...current, open: value }));
  };
  // Work on the active session's state: focus this conversation first.
  const withFocus = (action: () => void) => {
    if (!sessionId || focused) {
      action();
      return;
    }
    void selectSession(sessionId).then(() => {
      if (useAppStore.getState().activeSessionId === sessionId) action();
    });
  };
  const { index } = useProjectFolderIndex(open ? `info:${sessionId ?? ""}` : "closed");
  const mode = panelMode(paneWidth, prefs.width);

  const setPrefs = (update: (current: PanelPrefs) => PanelPrefs) =>
    setPrefsState((current) => {
      const next = update(current);
      savePrefs(next);
      return next;
    });

  // Docked or floating follows the main pane's width. The root only exists
  // once a session is selected, so observe again when that changes.
  const mounted = Boolean(sessionId);
  useEffect(() => {
    if (!mounted) return;
    const pane = rootRef.current?.closest<HTMLElement>(container);
    if (!pane) return;
    setPaneWidth(pane.getBoundingClientRect().width);
    const observer = new ResizeObserver(([entry]) => setPaneWidth(entry.contentRect.width));
    observer.observe(pane);
    return () => observer.disconnect();
  }, [mounted, container]);

  // The conversation band's preferred width (its edge handles set it on the
  // chat surface), so the docked panel can sit in the margin beside it.
  const [contentWidth, setContentWidth] = useState(760);
  useEffect(() => {
    if (!mounted) return;
    const surface = rootRef.current?.closest<HTMLElement>(".main-pane")?.querySelector<HTMLElement>(".chat-surface");
    if (!surface) return;
    const read = () => {
      const value = Number.parseFloat(surface.style.getPropertyValue("--chat-content-max-width"));
      setContentWidth(Number.isFinite(value) && value > 0 ? value : 760);
    };
    read();
    const observer = new MutationObserver(read);
    observer.observe(surface, { attributes: true, attributeFilter: ["style"] });
    return () => observer.disconnect();
  }, [mounted, sessionId]);

  // Docked: the conversation moves aside only by what the panel overlaps
  // (CSS reads this variable).
  const docked = mounted && open && mode === "docked";
  const offset = conversationOffset(paneWidth, prefs.width, contentWidth);
  useEffect(() => {
    const pane = rootRef.current?.closest<HTMLElement>(container);
    if (!pane) return;
    if (docked) pane.style.setProperty("--mc-info-offset", `${offset}px`);
    else pane.style.removeProperty("--mc-info-offset");
    return () => {
      pane.style.removeProperty("--mc-info-offset");
    };
  }, [docked, offset, container]);

  // The conversation never runs under the button either: it keeps to the
  // button's right where the button would overlap it (CSS takes the larger
  // of this and the docked offset).
  const toggleRef = useRef<HTMLDivElement>(null);
  const [toggleWidth, setToggleWidth] = useState(0);
  useEffect(() => {
    const row = toggleRef.current;
    if (!row || typeof ResizeObserver === "undefined") return;
    // The buttons' extent, not the row's: the open row spans the panel.
    const measure = () => {
      const left = row.getBoundingClientRect().left;
      const right = Math.max(left, ...[...row.querySelectorAll(":scope > button")].map((button) => button.getBoundingClientRect().right));
      setToggleWidth(Math.round(right - left));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(row);
    return () => observer.disconnect();
  }, [mounted, open]);
  // In a split column the button sits in the column's header instead, so the
  // conversation keeps its full width; the header makes room for it.
  const gutter =
    scope === "pane" && toggleWidth > 0 ? conversationOffset(paneWidth, toggleWidth + BUTTON_GAP, contentWidth) : 0;
  useEffect(() => {
    const pane = rootRef.current?.closest<HTMLElement>(container);
    if (!pane) return;
    pane.style.setProperty("--mc-info-gutter", `${gutter}px`);
    const column = scope === "column" ? rootRef.current?.closest<HTMLElement>(".mc-split-col") : null;
    // Docked, the panel's top runs through the header, so the title starts past it.
    column?.style.setProperty("--mc-info-toggle", `${docked ? prefs.width - 12 : toggleWidth}px`);
    return () => {
      pane.style.removeProperty("--mc-info-gutter");
      column?.style.removeProperty("--mc-info-toggle");
    };
  }, [gutter, container, scope, toggleWidth, docked, prefs.width]);

  const context = useMemo(() => {
    const inspector = latestTurnContextInspector(messages, providerModels, providers, compactions);
    return inspector ? { ...calculateContextUsage(inspector.usage, inspector.contextWindow), window: inspector.contextWindow } : null;
  }, [messages, providerModels, providers, compactions]);
  const changes = useMemo(() => summarizeReviewChanges(reviewChangesFromMessages(messages)), [messages]);
  // Subtasks: this conversation's `Task` subagents, then the sessions it
  // dispatched (MC-ADR-0005 follow-up).
  const subagents = useMemo(() => sessionSubagents(messages, { turnLive: isRunning }), [messages, isRunning]);
  // The poller is shared with the work panel header, which follows the
  // active session too, so both always ask for the same list.
  const shells = useBackgroundShells(sessionId);
  const anyRunning =
    subagents.some((item) => item.status === "running" || item.status === "creating") ||
    shells.some((shell) => shell.status === "running");
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!open || !anyRunning) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [open, anyRunning]);

  const [breakdown, setBreakdown] = useState<SessionContextBreakdown | null>(null);
  const [collaboration, setCollaboration] = useState<SessionCollaborationSummary | null>(null);
  const [connectors, setConnectors] = useState<{ ready: number; total: number } | null>(null);
  // Refresh when the panel opens, the session changes, or a turn ends.
  const settledMessages = isRunning ? -1 : messages.length;
  useEffect(() => {
    if (!open || !sessionId || settledMessages < 0) return;
    let canceled = false;
    void api
      .sessionContextBreakdown(sessionId)
      .then(({ breakdown: loaded }) => {
        if (!canceled) setBreakdown(loaded);
      })
      .catch(() => {
        if (!canceled) setBreakdown(null);
      });
    void api
      .getSessionCollaboration(sessionId)
      .then((summary) => {
        if (!canceled) setCollaboration(summary);
      })
      .catch(() => {
        if (!canceled) setCollaboration(null);
      });
    void api
      .listMcpServers()
      .then(({ servers, statuses }) => {
        if (canceled) return;
        const enabled = servers.filter((server) => server.enabled !== false);
        const ready = statuses.filter((status) => status.state === "ready").length;
        setConnectors({ ready, total: enabled.length });
      })
      .catch(() => {
        if (!canceled) setConnectors(null);
      });
    return () => {
      canceled = true;
    };
  }, [open, sessionId, settledMessages]);

  // The panel opens and closes only through its button. The layout menu
  // closes on an outside click or Escape.
  useEffect(() => {
    if (!menuOpen) return;
    const onPointer = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Element) || !target.closest(".mc-session-info-menu, .mc-session-info-menu-button")) {
        setMenuOpen(false);
      }
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMenuOpen(false);
    };
    window.addEventListener("pointerdown", onPointer, true);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", onPointer, true);
      window.removeEventListener("keydown", onKey);
    };
  }, [menuOpen]);

  // Drag the right edge to resize; the width is kept between the bounds.
  const startResize = (event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = prefs.width;
    const onMove = (move: PointerEvent) => {
      const width = clampPanelWidth(startWidth + move.clientX - startX);
      setPrefsState((current) => ({ ...current, width }));
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      document.documentElement.removeAttribute("data-mc-resizing");
      setPrefsState((current) => {
        savePrefs(current);
        return current;
      });
    };
    document.documentElement.setAttribute("data-mc-resizing", "true");
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  if (!sessionId) return null;

  const folder = sessionFolderLabel(session?.projectPath, index, normalizeProjectPath);
  const projectKey = normalizeProjectPath(session?.projectPath);
  const projectName = (projectKey && index.get(projectKey)?.groupName) || workspace?.name || folderName(session?.projectPath);
  const branch = session?.worktree?.branch ?? workspace?.branch;
  const model = session?.modelId ?? "";
  const workers = collaboration?.createdSessions ?? [];
  const usedTone = !context ? "" : context.usedPercent >= 85 ? " is-high" : context.usedPercent >= 65 ? " is-mid" : "";
  const rows = breakdown ? breakdownRows(breakdown) : [];

  const sectionTitle: Record<SectionId, string> = {
    environment: t("mcProject.sessionInfoEnvironment"),
    context: t("mcProject.sessionInfoContext"),
    changes: t("mcProject.sessionInfoChanges"),
    workers: t("mcProject.sessionInfoWorkers"),
    background: t("mcProject.paneBackground"),
    connectors: t("mcProject.sessionInfoConnectors"),
  };

  const sectionBody: Record<SectionId, ReactNode> = {
    environment: (
      <dl>
        <dt>{t("mcProject.sessionInfoProject")}</dt>
        <dd title={session?.projectPath ?? ""}>{projectName || t("mcProject.sessionInfoNoProject")}</dd>
        {session?.projectPath ? (
          <>
            <dt>{t("mcProject.startFolderLabel")}</dt>
            <dd className="mc-session-info-folder">
              {folder ? <span>{folder.label}</span> : null}
              <span className="mc-session-info-path-row">
                <span className="mc-session-info-path" title={session.projectPath}>
                  {/* Left-to-right marks keep slashes in place under the rtl trim. */}
                  {`\u200E${session.projectPath}\u200E`}
                </span>
                <button
                  type="button"
                  className="mc-session-info-close"
                  aria-label={t("mcProject.sessionInfoOpenFolder")}
                  title={t("mcProject.sessionInfoOpenFolder")}
                  onClick={() => void api.openProjectFolder(session.projectPath as string).catch(() => undefined)}
                >
                  <IconFolder size={12} aria-hidden />
                </button>
              </span>
            </dd>
          </>
        ) : null}
        {branch ? (
          <>
            <dt>{t("mcProject.sessionInfoBranch")}</dt>
            <dd>
              {branch}
              {session?.worktree ? ` · ${t("mcProject.sessionInfoWorktree")}` : ""}
            </dd>
          </>
        ) : null}
        {model ? (
          <>
            <dt>{t("mcProject.sessionInfoModel")}</dt>
            <dd>{model}</dd>
          </>
        ) : null}
      </dl>
    ),
    context: (
      <>
        {context ? (
          <div className="mc-session-info-row">
            <span className={`mc-session-info-percent${usedTone}`}>
              {t("mcProject.sessionInfoUsed", { percent: context.usedPercent })}
            </span>
            <span className="mc-session-info-muted">
              {compact(context.usedTokens)} / {compact(context.window)}
            </span>
          </div>
        ) : (
          <div className="mc-session-info-muted">{t("mcProject.sessionInfoNoUsage")}</div>
        )}
        {breakdown ? (
          <>
            <div className="mc-session-info-stack" aria-hidden>
              {rows
                .filter((row) => row.key !== "free" && row.tokens > 0)
                .map((row) => (
                  <span
                    key={row.key}
                    className={`is-${row.key}`}
                    style={{ width: `${(row.tokens / breakdown.contextWindow) * 100}%` }}
                  />
                ))}
            </div>
            <ul className="mc-session-info-breakdown">
              {rows.map((row) => {
                const namesKey = EXPANDABLE[row.key];
                const names = namesKey ? (breakdown[namesKey] as string[]) : [];
                const canExpand = names.length > 0;
                const isExpanded = expanded === row.key;
                // mc-agent: a category with something to manage opens it (a
                // dialog, or its settings page); the chevron still lists names.
                // Memory and instructions belong to a project; a conversation
                // outside one has none to edit.
                const rowAction = ROW_ACTIONS[row.key];
                const action = rowAction?.project && !session?.projectPath ? undefined : rowAction;
                const label = t(`mcProject.sessionInfoKind_${row.key}`);
                return (
                  <li key={row.key}>
                    <div className="mc-session-info-breakdown-line">
                      <span className={`mc-session-info-swatch is-${row.key}`} aria-hidden />
                      <span className="mc-session-info-breakdown-label">
                        {action ? (
                          <button
                            type="button"
                            className="mc-session-info-kind-link"
                            title={t("mcProject.capabilityOpen", { name: label })}
                            onClick={() =>
                              action.systemPrompt
                                ? setPromptOpen(true)
                                : action.project
                                  ? setProjectEditor(action.project)
                                : action.dialog
                                  ? setCapability(action.dialog)
                                  : openSettings(action.settings as SettingsTabId)
                            }
                          >
                            {label}
                          </button>
                        ) : (
                          label
                        )}
                        {row.count !== undefined ? <span className="mc-session-info-muted"> · {row.count}</span> : null}
                        {canExpand ? (
                          <button
                            type="button"
                            className="mc-session-info-expand"
                            aria-expanded={isExpanded}
                            aria-label={t("mcProject.capabilityShowNames", { name: label })}
                            onClick={() => setExpanded(isExpanded ? null : row.key)}
                          >
                            {isExpanded ? <IconChevronDown size={11} aria-hidden /> : <IconChevronRight size={11} aria-hidden />}
                          </button>
                        ) : null}
                      </span>
                      <span className="mc-session-info-muted">{compact(row.tokens)}</span>
                      <span className="mc-session-info-breakdown-percent">{row.percent.toFixed(1)}%</span>
                    </div>
                    {isExpanded ? (
                      <ul className="mc-session-info-names">
                        {names.map((name) => (
                          <li key={name}>{name}</li>
                        ))}
                      </ul>
                    ) : null}
                  </li>
                );
              })}
            </ul>
            <div className="mc-session-info-muted">{t("mcProject.sessionInfoEstimated")}</div>
          </>
        ) : (
          <div className="mc-session-info-muted">{t("mcProject.sessionInfoNoBreakdown")}</div>
        )}
        <div className="mc-session-info-row mc-session-info-compact">
          <span className="mc-session-info-muted">
            {breakdown
              ? t("mcProject.sessionInfoUntilCompact", {
                  tokens: compact(Math.max(0, breakdown.autoCompactAt - breakdown.usedTokens)),
                })
              : t("mcProject.sessionInfoCompactions", { count: compactions?.length ?? 0 })}
          </span>
          <button
            type="button"
            className="mc-session-info-button"
            disabled={isRunning}
            onClick={() => withFocus(() => void compactContext())}
          >
            {t("mcProject.sessionInfoCompact")}
          </button>
        </div>
      </>
    ),
    changes:
      changes.changeCount > 0 ? (
        <div className="mc-session-info-row">
          <span className="diff-counts">
            <span className="diff-count-add">+{changes.additions}</span>{" "}
            <span className="diff-count-del">−{changes.deletions}</span>
          </span>
          <button
            type="button"
            className="mc-session-info-link"
            onClick={() => withFocus(() => openWorkPanelTab(toolWorkPanelTab("review")))}
          >
            {t("mcProject.sessionInfoReview", { count: changes.changeCount })}
          </button>
        </div>
      ) : (
        <div className="mc-session-info-muted">{t("mcProject.sessionInfoNoChanges")}</div>
      ),
    workers: (
      <>
        {subagents.length > 0 ? (
          <>
            {workers.length > 0 ? <div className="mc-session-info-sublabel">{t("mcProject.sessionInfoSubagents")}</div> : null}
            <ul className="mc-session-info-list">
              {subagents.map((item) => {
                const end = item.completedAt ?? (item.status === "running" ? now : undefined);
                const elapsed = item.startedAt !== undefined && end !== undefined ? formatElapsed(end - item.startedAt) : "";
                const label = item.status === "creating" ? t("chat.subagentCreating") : t(`chat.subagentStatus.${item.status}`);
                return (
                  <li key={item.delegationId}>
                    <button
                      type="button"
                      className="mc-session-info-subtask"
                      data-status={item.status}
                      disabled={Boolean(session && isRemoteSession(session))}
                      title={[item.agentName, label, elapsed].filter(Boolean).join(" · ")}
                      onClick={() => withFocus(() => openSubagentTab(item.delegationId, item.agentName || undefined))}
                    >
                      <span className="mc-session-info-subtask-dot" aria-hidden />
                      <span className="mc-session-info-subtask-name">{item.agentName || t("panel.tabs.subagent")}</span>
                      <span className="mc-session-info-subtask-meta">{[label, elapsed].filter(Boolean).join(" · ")}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </>
        ) : null}
        {collaboration?.createdBySession ? (
          <button
            type="button"
            className="mc-session-info-link"
            onClick={() => void selectSession(collaboration.createdBySession!.sessionId)}
          >
            {t("mcProject.sessionInfoDispatchedBy", { title: collaboration.createdBySession.title })}
          </button>
        ) : null}
        {workers.length > 0 ? (
          <>
          {subagents.length > 0 ? <div className="mc-session-info-sublabel">{t("mcProject.sessionInfoWorkerSessions")}</div> : null}
          <ul className="mc-session-info-list">
            {workers.map((worker) => (
              <li key={worker.sessionId}>
                <button
                  type="button"
                  className="mc-session-info-link"
                  disabled={worker.available === false}
                  onClick={() => void selectSession(worker.sessionId)}
                >
                  {worker.title || worker.sessionId}
                </button>
              </li>
            ))}
          </ul>
          </>
        ) : !collaboration?.createdBySession && subagents.length === 0 ? (
          <div className="mc-session-info-muted">{t("mcProject.sessionInfoNoWorkers")}</div>
        ) : null}
      </>
    ),
    // Background commands (MC-ADR-0006); a click opens the command's output
    // in the work panel's background pane, as Claude Code's session panel does.
    background:
      shells.length > 0 ? (
        <ul className="mc-session-info-list">
          {shells.map((shell) => {
            const label =
              shell.status === "running"
                ? t("mcProject.backgroundRunning")
                : shell.status === "killed"
                  ? t("mcProject.backgroundKilled")
                  : shell.status === "failed"
                    ? t("mcProject.backgroundFailed")
                    : t("mcProject.backgroundExited", { code: shell.exitCode ?? "?" });
            const elapsed = formatElapsed((shell.endedAt ?? now) - shell.startedAt);
            return (
              <li key={shell.id}>
                <button
                  type="button"
                  className="mc-session-info-subtask"
                  data-status={shell.status}
                  title={`${shell.command}\n${shell.cwd}`}
                  onClick={() =>
                    withFocus(() => {
                      openWorkPanelTab(backgroundTab());
                      expandPane("background");
                      focusBackgroundShell(shell.id);
                    })
                  }
                >
                  <span className="mc-session-info-subtask-dot" aria-hidden />
                  <span className="mc-session-info-subtask-name mc-session-info-command">{shell.command}</span>
                  <span className="mc-session-info-subtask-meta">{`${label} · ${elapsed}`}</span>
                </button>
              </li>
            );
          })}
        </ul>
      ) : (
        <div className="mc-session-info-muted">{t("mcProject.sessionInfoNoBackground")}</div>
      ),
    connectors: (
      <button type="button" className="mc-session-info-link" onClick={() => setCapability("mcp")}>
        {connectors
          ? t("mcProject.sessionInfoConnectorsCount", { ready: connectors.ready, total: connectors.total })
          : t("mcProject.capabilityMcpTitle")}
      </button>
    ),
  };


  /*
    The layout menu opens from a right-click on the button or a section title.
    A separate "…" button would widen the button row as the panel opens, and
    the conversation, which keeps clear of that row, would shift with it.
  */
  const openCustomize = (event: React.MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    if (!open) setOpen(true);
    setMenuOpen(true);
  };

  const openSettings = (tab: SettingsTabId) => {
    const store = useAppStore.getState();
    store.setSettingsTab(tab);
    store.setPage("settings");
  };
  const capabilityDialog = capability ? (
    <CapabilityDialog
      kind={capability}
      names={
        capability === "skills"
          ? (breakdown?.skillNames ?? EMPTY_NAMES)
          : capability === "tools"
            ? (breakdown?.toolNames ?? EMPTY_NAMES)
            : EMPTY_NAMES
      }
      projectPath={session?.projectPath ?? null}
      onClose={() => setCapability(null)}
    />
  ) : null;

  // The project's memory and instructions editors, as the projects page opens them.
  const memoryProject = (() => {
    const path = session?.projectPath;
    if (!path) return null;
    const group = projectKey ? index.get(projectKey) : undefined;
    return group
      ? // A plain folder project edits its own AGENTS.md and path memory, as on
        // the projects page; a multi-folder project edits the group's.
        { name: group.groupName, path: group.path, groupId: group.groupId, legacy: group.legacy }
      : { name: projectName || folderName(path), path };
  })();
  const showError = (error: unknown) =>
    useAppStore.getState().showToast(error instanceof Error ? error.message : String(error), { variant: "error" });
  const memoryDialog = !memoryProject ? null : projectEditor === "memory" ? (
    <ProjectMemoryDialog
      project={memoryProject}
      onClose={() => setProjectEditor(null)}
      onSaved={() => useAppStore.getState().showToast(t("project.memorySaved"), { variant: "success" })}
      onError={showError}
    />
  ) : projectEditor === "instructions" ? (
    <ProjectInstructionsDialog
      project={memoryProject}
      onClose={() => setProjectEditor(null)}
      onSaved={() => useAppStore.getState().showToast(t("project.instructionsSaved"), { variant: "success" })}
      onError={showError}
    />
  ) : null;

  const toggleRow = (
    <div className="mc-session-info-toggle-row" ref={toggleRef}>
      <button
        type="button"
        className={`mc-session-info-trigger${open ? " active" : ""}`}
        aria-expanded={open}
        aria-label={t("mcProject.sessionInfoTitle")}
        title={`${t("mcProject.sessionInfoTitle")}\n${t("mcProject.sessionInfoCustomizeHint")}`}
        onClick={() => {
          setMenuOpen(false);
          setOpen(!open);
        }}
        onContextMenu={openCustomize}
      >
        <IconInfo size={13} aria-hidden />
        {context ? <span className={`mc-session-info-percent${usedTone}`}>{context.usedPercent}%</span> : null}
      </button>
      {open && menuOpen ? (
        <div className="mc-session-info-menu" role="menu">
          {SECTION_IDS.map((id) => (
            <button
              key={id}
              type="button"
              role="menuitemcheckbox"
              aria-checked={!prefs.hidden.includes(id)}
              className="mc-session-info-menu-item"
              onClick={() => setPrefs((current) => ({ ...current, hidden: toggleIn(current.hidden, id) }))}
            >
              <span className="mc-session-info-check">{prefs.hidden.includes(id) ? "" : "✓"}</span>
              {sectionTitle[id]}
            </button>
          ))}
          <div className="mc-session-info-menu-divider" />
          <button
            type="button"
            role="menuitem"
            className="mc-session-info-menu-item"
            onClick={() => {
              setPrefs((current) => ({ ...DEFAULT_PREFS, order: [...SECTION_IDS], open: current.open }));
              setMenuOpen(false);
            }}
          >
            <span className="mc-session-info-check" />
            {t("mcProject.sessionInfoResetLayout")}
          </button>
        </div>
      ) : null}
    </div>
  );

  if (!open) {
    return (
      <div className="mc-session-info" ref={rootRef}>
        {toggleRow}
      </div>
    );
  }

  return (
    <div
      className={`mc-session-info is-open is-${mode}`}
      ref={rootRef}
      style={{ width: prefs.width }}
    >
      {toggleRow}
      <aside className="mc-session-info-card" aria-label={t("mcProject.sessionInfoTitle")}>
        {prefs.order
          .filter((id) => !prefs.hidden.includes(id))
          .map((id) => {
            const collapsed = prefs.collapsed.includes(id);
            return (
              <section
                key={id}
                className={`mc-session-info-section${dragging === id ? " is-dragging" : ""}${dropTarget === id && dragging !== id ? " is-drop-target" : ""}`}
                onDragOver={(event) => {
                  if (!dragging) return;
                  event.preventDefault();
                  setDropTarget(id);
                }}
                onDrop={(event) => {
                  event.preventDefault();
                  if (dragging) setPrefs((current) => ({ ...current, order: reorderSections(current.order, dragging, id) }));
                  setDragging(null);
                  setDropTarget(null);
                }}
              >
                <button
                  type="button"
                  className="mc-session-info-section-head"
                  onContextMenu={openCustomize}
                  draggable
                  aria-expanded={!collapsed}
                  title={t("mcProject.sessionInfoSectionHint")}
                  onDragStart={(event) => {
                    event.dataTransfer.effectAllowed = "move";
                    event.dataTransfer.setData("text/plain", id);
                    setDragging(id);
                  }}
                  onDragEnd={() => {
                    setDragging(null);
                    setDropTarget(null);
                  }}
                  onClick={() => setPrefs((current) => ({ ...current, collapsed: toggleIn(current.collapsed, id) }))}
                >
                  <h3>{sectionTitle[id]}</h3>
                  {collapsed ? <IconChevronRight size={12} aria-hidden /> : <IconChevronDown size={12} aria-hidden />}
                </button>
                {collapsed ? null : <div className="mc-session-info-section-body">{sectionBody[id]}</div>}
              </section>
            );
          })}
      </aside>
      {capabilityDialog}
      {memoryDialog}
      {promptOpen && sessionId ? <SystemPromptDialog sessionId={sessionId} onClose={() => setPromptOpen(false)} /> : null}
      {mode === "docked" ? (
        <div
          className="mc-session-info-resize"
          role="separator"
          aria-orientation="vertical"
          aria-label={t("mcProject.sessionInfoResize")}
          onPointerDown={startResize}
          onDoubleClick={() => setPrefs((current) => ({ ...current, width: DEFAULT_PREFS.width }))}
        />
      ) : null}
    </div>
  );
}
