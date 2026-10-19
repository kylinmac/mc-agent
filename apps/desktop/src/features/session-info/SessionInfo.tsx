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
import { formatElapsed, sessionSubagents } from "./session-subagents";
import { focusBackgroundShell, useBackgroundShells } from "../work-tools/background-shells";
import { backgroundTab } from "../work-tools/tool-tabs";
import { expandPane } from "../work-tools/pane-layout";
import { IconChevronDown, IconChevronRight, IconFolder, IconInfo, IconMore } from "../../components/icons";
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
export function SessionInfo() {
  const { t } = useTranslation();
  const [prefs, setPrefsState] = useState<PanelPrefs>(readPrefs);
  const [paneWidth, setPaneWidth] = useState(0);
  const [menuOpen, setMenuOpen] = useState(false);
  const [dragging, setDragging] = useState<SectionId | null>(null);
  const [dropTarget, setDropTarget] = useState<SectionId | null>(null);
  const [expanded, setExpanded] = useState<BreakdownRowKey | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const activeSessionId = useAppStore((s) => s.activeSessionId);
  const sessions = useAppStore((s) => s.sessions);
  const workspace = useAppStore((s) => s.workspace);
  const messages = useAppStore((s) => s.messages);
  const isRunning = useAppStore((s) => s.isRunning);
  const providers = useAppStore((s) => s.providers);
  const providerModels = useAppStore((s) => s.providerModels);
  const compactions = useAppStore((s) => (s.activeSessionId ? s.sessionCompactions[s.activeSessionId] : undefined));
  const openWorkPanelTab = useAppStore((s) => s.openWorkPanelTab);
  const selectSession = useAppStore((s) => s.selectSession);
  const openSubagentTab = useAppStore((s) => s.openSubagentTab);
  const compactContext = useAppStore((s) => s.compactContext);
  const session = sessions.find((candidate) => candidate.id === activeSessionId);
  const open = prefs.open;
  const { index } = useProjectFolderIndex(open ? `info:${activeSessionId ?? ""}` : "closed");
  const mode = panelMode(paneWidth, prefs.width);

  const setPrefs = (update: (current: PanelPrefs) => PanelPrefs) =>
    setPrefsState((current) => {
      const next = update(current);
      savePrefs(next);
      return next;
    });

  // Docked or floating follows the main pane's width. The root only exists
  // once a session is selected, so observe again when that changes.
  const mounted = Boolean(activeSessionId);
  useEffect(() => {
    if (!mounted) return;
    const pane = rootRef.current?.closest<HTMLElement>(".main-pane");
    if (!pane) return;
    setPaneWidth(pane.getBoundingClientRect().width);
    const observer = new ResizeObserver(([entry]) => setPaneWidth(entry.contentRect.width));
    observer.observe(pane);
    return () => observer.disconnect();
  }, [mounted]);

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
  }, [mounted, activeSessionId]);

  // Docked: the conversation moves aside only by what the panel overlaps
  // (CSS reads this variable).
  const docked = mounted && open && mode === "docked";
  const offset = conversationOffset(paneWidth, prefs.width, contentWidth);
  useEffect(() => {
    const pane = rootRef.current?.closest<HTMLElement>(".main-pane");
    if (!pane) return;
    if (docked) pane.style.setProperty("--mc-info-offset", `${offset}px`);
    else pane.style.removeProperty("--mc-info-offset");
    return () => {
      pane.style.removeProperty("--mc-info-offset");
    };
  }, [docked, offset]);

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
  const shells = useBackgroundShells(activeSessionId);
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
    if (!open || !activeSessionId || settledMessages < 0) return;
    let canceled = false;
    void api
      .sessionContextBreakdown(activeSessionId)
      .then(({ breakdown: loaded }) => {
        if (!canceled) setBreakdown(loaded);
      })
      .catch(() => {
        if (!canceled) setBreakdown(null);
      });
    void api
      .getSessionCollaboration(activeSessionId)
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
  }, [open, activeSessionId, settledMessages]);

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

  if (!activeSessionId) return null;

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
                const line = (
                  <>
                    <span className={`mc-session-info-swatch is-${row.key}`} aria-hidden />
                    <span className="mc-session-info-breakdown-label">
                      {t(`mcProject.sessionInfoKind_${row.key}`)}
                      {row.count !== undefined ? <span className="mc-session-info-muted"> · {row.count}</span> : null}
                      {canExpand ? (
                        isExpanded ? <IconChevronDown size={11} aria-hidden /> : <IconChevronRight size={11} aria-hidden />
                      ) : null}
                    </span>
                    <span className="mc-session-info-muted">{compact(row.tokens)}</span>
                    <span className="mc-session-info-breakdown-percent">{row.percent.toFixed(1)}%</span>
                  </>
                );
                return (
                  <li key={row.key}>
                    {canExpand ? (
                      <button
                        type="button"
                        className="mc-session-info-breakdown-line is-expandable"
                        aria-expanded={isExpanded}
                        onClick={() => setExpanded(isExpanded ? null : row.key)}
                      >
                        {line}
                      </button>
                    ) : (
                      <div className="mc-session-info-breakdown-line">{line}</div>
                    )}
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
            onClick={() => void compactContext()}
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
            onClick={() => openWorkPanelTab(toolWorkPanelTab("review"))}
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
                      onClick={() => openSubagentTab(item.delegationId, item.agentName || undefined)}
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
                  onClick={() => {
                    openWorkPanelTab(backgroundTab());
                    expandPane("background");
                    focusBackgroundShell(shell.id);
                  }}
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
      <div className="mc-session-info-muted">
        {connectors
          ? t("mcProject.sessionInfoConnectorsCount", { ready: connectors.ready, total: connectors.total })
          : "—"}
      </div>
    ),
  };


  const toggleRow = (
    <div className="mc-session-info-toggle-row">
      <button
        type="button"
        className={`mc-session-info-trigger${open ? " active" : ""}`}
        aria-expanded={open}
        aria-label={t("mcProject.sessionInfoTitle")}
        title={t("mcProject.sessionInfoTitle")}
        onClick={() => {
          setMenuOpen(false);
          setPrefs((current) => ({ ...current, open: !current.open }));
        }}
      >
        <IconInfo size={13} aria-hidden />
        {context ? <span className={`mc-session-info-percent${usedTone}`}>{context.usedPercent}%</span> : null}
      </button>
      {open ? (
        <button
          type="button"
          className="mc-session-info-close mc-session-info-menu-button"
          aria-label={t("mcProject.sessionInfoCustomize")}
          title={t("mcProject.sessionInfoCustomize")}
          aria-expanded={menuOpen}
          onClick={() => setMenuOpen((value) => !value)}
        >
          <IconMore size={13} aria-hidden />
        </button>
      ) : null}
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
