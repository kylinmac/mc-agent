import { isRemoteSession } from "../../lib/remote-session-safety";
import { RemoteWorkspace } from "../remote/RemoteWorkspace";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ComponentType,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { useTranslation } from "react-i18next";
import { useBlockingOverlayActive } from "../../lib/blocking-overlay";
import {
  isKnownWorkPanelTab,
  parsePluginViewRef,
  pluginWorkPanelTab,
  subagentTabDisplayLabels,
  toolWorkPanelTab,
} from "../../lib/work-panel-tabs";
import type { PluginViewMeta } from "@pi-desktop/shared";
import { pluginViewIcon, pluginViewInitial } from "../../lib/plugin-view-icons";
import { useAppStore } from "../../stores/app-store";
import type { WorkPanelTab } from "../../stores/app-store";
import { cx } from "../ui";
import { TooltipButton } from "../ui";
import type { IconProps } from "../icons";
import {
  IconActivity,
  IconBot,
  IconClose,
  IconDiff,
  IconFileText,
  IconPanelMaximize,
  IconPanelRestore,
  IconPlug,
  IconPlus,
  IconTerminal,
} from "../icons";
import { ReviewTab } from "./ReviewTab";
import { FilesTab } from "./FilesTab";
import { PluginViewTab } from "./PluginViewTab";
import { SubagentTranscriptTab } from "./SubagentTranscriptTab";
import { TerminalTab } from "../../features/work-tools/TerminalTab";
import { useTerminalCwd, WorkPanelQuickTools } from "../../features/work-tools/WorkPanelQuickTools";
import { WorkPanes } from "../../features/work-tools/WorkPanes";
import { BackgroundPane } from "../../features/work-tools/BackgroundPane";
import {
  MAIN_PANE_MIN_WIDTH,
  WORK_PANEL_COMPACT_MIN_WIDTH,
  clampWorkPanelWidth,
  workPanelGestureMinimum,
  workPanelLayout,
  workPanelRequestedWidth,
  workPanelResetWidth,
  workPanelWidthBounds,
} from "../../lib/work-panel-resize";

const TAB_ICONS = {
  new: IconPlus,
  review: IconDiff,
  file: IconFileText,
  plugin: IconPlug,
  subagent: IconBot,
  terminal: IconTerminal,
  background: IconActivity,
} as const;

type WorkPanelResizeState = {
  pointerId: number;
  startClientX: number;
  startWidth: number;
  minimumWidth: number;
  currentWidth: number;
  frame: number;
};

type WorkPanelTool = {
  id: string;
  tab: WorkPanelTab;
  label: string;
  icon: ComponentType<IconProps> | null;
  initial?: string;
  description?: string;
  shortcut?: string;
};

function tabLabel(
  tab: WorkPanelTab,
  t: (key: string) => string,
  pluginViews: PluginViewMeta[],
) {
  if (tab.kind === "plugin") {
    if (tab.resource === "pi.browser/browser" && tab.label) return tab.label;
    const view = pluginViews.find((candidate) => candidate.ref === tab.resource);
    // A view whose plugin was disabled mid-session no longer resolves; fall
    // back to its id rather than leaving the tab blank until it closes.
    return view?.title ?? tab.resource ?? t("panel.tabs.plugin");
  }
  if (tab.kind === "new") return t("panel.new.title");
  if (tab.kind === "subagent") return tab.label ?? t("panel.tabs.subagent");
  if (tab.kind === "terminal") return tab.label ?? t("mcProject.quickToolTerminal");
  if (tab.kind === "background") return t("mcProject.paneBackground");
  if (tab.kind !== "file") return t(`panel.tabs.${tab.kind}`);
  const path = tab.resource ?? "";
  return path.split("/").filter(Boolean).pop() || t("panel.tabs.file");
}

function workPanelTools(
  t: (key: string) => string,
  pluginViews: PluginViewMeta[],
): WorkPanelTool[] {
  // Review is the only host-owned launcher. Files, Browser, and every future
  // tool are plugin-contributed views, so their list stays data-driven.
  return [
    {
      id: "review",
      tab: toolWorkPanelTab("review"),
      label: t("panel.tabs.review"),
      icon: IconDiff,
    },
    ...pluginViews.map((view) => {
      const Icon = pluginViewIcon(view.icon);
      return {
        id: view.ref,
        tab: pluginWorkPanelTab(view.pluginId, view.viewId),
        label: view.title,
        icon: Icon,
        ...(Icon ? {} : { initial: pluginViewInitial(view.title) }),
        description: view.pluginName,
      };
    }),
  ];
}

function ToolIcon({ item, size = 15 }: { item: WorkPanelTool; size?: number }) {
  if (item.icon) return <item.icon size={size} />;
  return (
    <span className="work-panel-view-initial" aria-hidden>
      {item.initial}
    </span>
  );
}

export function WorkPanel(props: Parameters<typeof LocalWorkPanel>[0]) {
  const session = useAppStore((state) => state.sessions.find((item) => item.id === state.activeSessionId));
  const sessionId = useAppStore((state) => state.activeSessionId);
  const width = useAppStore((state) => state.workPanelWidth);
  if (session && isRemoteSession(session)) {
    return <RemoteWorkspace key={session.id} session={session} width={Math.min(width, Math.max(280, (props.containerWidth || 900) - 320))}
      exiting={props.exiting} onExitAnimationEnd={props.onExitAnimationEnd} />;
  }
  if (sessionId?.startsWith("remote:")) return null;
  return <LocalWorkPanel {...props} />;
}

/**
 * mc-agent (MC-ADR-0007): in a split view the work panel sits under the
 * focused column instead of at the window's right edge. Remote sessions keep
 * their own workspace view, which has no bottom form.
 */
export function WorkPanelBottomDock() {
  const session = useAppStore((state) => state.sessions.find((item) => item.id === state.activeSessionId));
  const sessionId = useAppStore((state) => state.activeSessionId);
  if ((session && isRemoteSession(session)) || sessionId?.startsWith("remote:")) return null;
  return <LocalWorkPanel dock="bottom" />;
}

function LocalWorkPanel({
  panelBlocked = false,
  exiting = false,
  onExitAnimationEnd,
  containerWidth = 0,
  sidebarCollapsed = false,
  sidebarExiting = false,
  sidebarWidth = 0,
  onAutoCollapseSidebar,
  maximized = false,
  onToggleMaximize,
  dock = "side",
}: {
  /**
   * Hides every native surface in the panel. Both the preview browser and a
   * plugin view are `WebContentsView`s composited above renderer content, so a
   * blocking overlay must suppress them alike.
   */
  panelBlocked?: boolean;
  /** Plays work-panel-out; parent unmounts after animationend. */
  exiting?: boolean;
  onExitAnimationEnd?: () => void;
  /** Current renderer shell width used for the three-column budget. */
  containerWidth?: number;
  /** Sidebar state is part of the shared shell budget. */
  sidebarCollapsed?: boolean;
  /** Keep the dock in the budget while `sidebar-out` still occupies flex space. */
  sidebarExiting?: boolean;
  sidebarWidth?: number;
  /** Called on the first frame where the main pane would hit its hard floor. */
  onAutoCollapseSidebar?: () => void;
  /** Preview mode: the panel takes MainChat's width as well. */
  maximized?: boolean;
  /** Toggles the preview mode from the panel header. */
  onToggleMaximize?: () => void;
  /** mc-agent: "bottom" fills its split-view column slot; no width, no maximize. */
  dock?: "side" | "bottom";
}) {
  const { t } = useTranslation();
  const blockingOverlayActive = useBlockingOverlayActive();
  const rawTabs = useAppStore((s) => s.workPanelTabs);
  const tabs = rawTabs.filter(isKnownWorkPanelTab);
  const activeTabId = useAppStore((s) => s.activeWorkPanelTabId);
  const activeSessionId = useAppStore((s) => s.activeSessionId);
  const pluginViews = useAppStore((s) => s.pluginViews);
  const width = useAppStore((s) => s.workPanelWidth);
  const yieldedWidth = useAppStore((s) => s.workPanelYieldedWidth);
  const activateTab = useAppStore((s) => s.activateWorkPanelTab);
  const openWorkPanelTab = useAppStore((s) => s.openWorkPanelTab);
  const replaceWorkPanelTab = useAppStore((s) => s.replaceWorkPanelTab);
  const setWidth = useAppStore((s) => s.setWorkPanelWidth);
  const terminalCwd = useTerminalCwd();
  const tools = workPanelTools(t, pluginViews);
  // Subagent tabs may share an agent name; repeats gain a 1-based `#n`
  // suffix in strip order so the row stays unambiguous. The base label
  // already falls back to panel.tabs.subagent when no name was captured.
  const subagentTabsInOrder = tabs.filter((tab) => tab.kind === "subagent");
  const subagentDisplayLabels = subagentTabDisplayLabels(
    subagentTabsInOrder.map((tab) => tabLabel(tab, t, pluginViews)),
  );
  const subagentLabelById = new Map(
    subagentTabsInOrder.map(
      (tab, index) => [tab.id, subagentDisplayLabels[index]] as const,
    ),
  );

  const [panelDragWidth, setPanelDragWidth] = useState<number | null>(null);
  const panelResizeState = useRef<WorkPanelResizeState | null>(null);
  const [nativeSurfaceReadyForExit, setNativeSurfaceReadyForExit] =
    useState(false);

  // The first render can precede ResizeObserver's first notification. Use a
  // conservative shell estimate for that frame; the measured width takes over
  // before a user can interact with the divider.
  const sidebarOccupiesBudget = !sidebarCollapsed || sidebarExiting;
  const budgetWidth =
    containerWidth > 0
      ? containerWidth
      : (panelDragWidth ?? width) +
        (sidebarOccupiesBudget ? sidebarWidth : 0) +
        MAIN_PANE_MIN_WIDTH;
  // A drag preview is an explicit width; otherwise the panel asks for its
  // preferred width, or the width it lent to a manually reopened sidebar.
  const requestedPanelWidth =
    panelDragWidth ??
    workPanelRequestedWidth({
      containerWidth: budgetWidth,
      sidebarWidth,
      sidebarCollapsed: !sidebarOccupiesBudget,
      preferredWidth: width,
      yieldedWidth,
    });
  const layout = workPanelLayout({
    containerWidth: budgetWidth,
    sidebarWidth,
    sidebarCollapsed: !sidebarOccupiesBudget,
    requestedPanelWidth,
    maximized,
  });
  const renderPanelWidth = layout.panelWidth;
  const panelMinimum = workPanelGestureMinimum(renderPanelWidth);
  const isResizing = panelDragWidth !== null;

  useLayoutEffect(() => {
    if (dock === "side" && !exiting && layout.shouldCollapseSidebar) onAutoCollapseSidebar?.();
  }, [dock, exiting, layout.shouldCollapseSidebar, onAutoCollapseSidebar]);

  useEffect(() => {
    if (isResizing) {
      document.documentElement.setAttribute("data-work-panel-resizing", "true");
    } else {
      document.documentElement.removeAttribute("data-work-panel-resizing");
    }
    return () => {
      document.documentElement.removeAttribute("data-work-panel-resizing");
    };
  }, [isResizing]);

  useEffect(() => {
    if (!exiting) {
      setNativeSurfaceReadyForExit(false);
      return;
    }
    // Plugin views (and the host guest clamped to them) hide via `blocked`
    // before the dock CSS animation starts.
    setNativeSurfaceReadyForExit(true);
  }, [exiting]);

  const selectTool = useCallback(
    (item: WorkPanelTool, sourceTabId?: string) => {
      if (sourceTabId) {
        replaceWorkPanelTab(sourceTabId, item.tab);
        return;
      }
      const existing = tabs.find((tab) => tab.id === item.tab.id);
      if (existing) activateTab(existing.id);
      else openWorkPanelTab(item.tab);
    },
    [activateTab, openWorkPanelTab, replaceWorkPanelTab, tabs],
  );

  const finishPanelResize = useCallback(
    (target: HTMLDivElement, pointerId: number, cancelled: boolean) => {
      const drag = panelResizeState.current;
      if (drag?.pointerId !== pointerId) return;
      panelResizeState.current = null;
      if (drag.frame) cancelAnimationFrame(drag.frame);
      if (target.hasPointerCapture(pointerId)) target.releasePointerCapture(pointerId);
      setPanelDragWidth(null);
      if (!cancelled && drag.currentWidth !== drag.startWidth) {
        setWidth(drag.currentWidth);
      }
    },
    [setWidth],
  );

  const onPanelResizeStart = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      // While maximized there is no second column to trade width with.
      if (maximized) return;
      if (event.button !== 0 || panelResizeState.current) return;
      event.preventDefault();
      event.stopPropagation();
      event.currentTarget.focus({ preventScroll: true });
      const startWidth = clampWorkPanelWidth(renderPanelWidth, panelMinimum);
      panelResizeState.current = {
        pointerId: event.pointerId,
        startClientX: event.clientX,
        startWidth,
        minimumWidth: panelMinimum,
        currentWidth: startWidth,
        frame: 0,
      };
      setPanelDragWidth(startWidth);
      event.currentTarget.setPointerCapture(event.pointerId);
    },
    [maximized, panelMinimum, renderPanelWidth],
  );

  const onPanelResizeMove = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    const drag = panelResizeState.current;
    if (drag?.pointerId !== event.pointerId) return;
    drag.currentWidth = clampWorkPanelWidth(
      drag.startWidth + drag.startClientX - event.clientX,
      drag.minimumWidth,
    );
    if (drag.frame) return;
    drag.frame = requestAnimationFrame(() => {
      if (panelResizeState.current !== drag) return;
      drag.frame = 0;
      setPanelDragWidth(drag.currentWidth);
    });
  }, []);

  const onPanelResizeCommit = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      finishPanelResize(event.currentTarget, event.pointerId, false);
    },
    [finishPanelResize],
  );

  const onPanelResizeCancel = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      finishPanelResize(event.currentTarget, event.pointerId, true);
    },
    [finishPanelResize],
  );

  useEffect(
    () => () => {
      const drag = panelResizeState.current;
      if (drag?.frame) cancelAnimationFrame(drag.frame);
      panelResizeState.current = null;
      document.documentElement.removeAttribute("data-work-panel-resizing");
    },
    [],
  );

  const onPanelResizeKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      const drag = panelResizeState.current;
      if (event.key === "Escape" && drag) {
        event.preventDefault();
        finishPanelResize(event.currentTarget, drag.pointerId, true);
        return;
      }
      // While maximized there is no second column to trade width with.
      if (maximized) return;
      const step = event.shiftKey ? 32 : 16;
      const { minimum, maximum } = workPanelWidthBounds(
        panelMinimum,
        layout.maxPanelWidth,
      );
      let nextWidth: number | null = null;
      if (event.key === "ArrowLeft") nextWidth = renderPanelWidth + step;
      else if (event.key === "ArrowRight") nextWidth = renderPanelWidth - step;
      else if (event.key === "Home") nextWidth = minimum;
      else if (event.key === "End") nextWidth = maximum;
      if (nextWidth === null) return;
      event.preventDefault();
      const committedWidth = clampWorkPanelWidth(nextWidth, minimum);
      // A key that cannot move the separator commits nothing, so it neither
      // rewrites the preferred width nor ends a width lent to the sidebar.
      if (committedWidth === renderPanelWidth) return;
      setWidth(committedWidth);
    },
    [finishPanelResize, layout.maxPanelWidth, maximized, panelMinimum, renderPanelWidth, setWidth],
  );

  /**
   * Double-click reset: the default width, kept inside the same live bounds
   * the keyboard path uses, so a reset never breaches the MainChat floor or
   * reopens a compact panel wider than the window allows.
   */
  const onPanelResizeReset = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      // While maximized there is no second column to trade width with.
      if (maximized) return;
      // A gesture that is still open (a second pointer) must not overwrite the
      // reset when it is finally released.
      const drag = panelResizeState.current;
      if (drag) finishPanelResize(event.currentTarget, drag.pointerId, true);
      setPanelDragWidth(null);
      setWidth(workPanelResetWidth(panelMinimum, layout.maxPanelWidth));
    },
    [finishPanelResize, layout.maxPanelWidth, maximized, panelMinimum, setWidth],
  );

  // Terminals in the same folder share a name; number repeats the same way.
  const terminalTabsInOrder = tabs.filter((tab) => tab.kind === "terminal");
  const terminalDisplayLabels = subagentTabDisplayLabels(
    terminalTabsInOrder.map((tab) => tabLabel(tab, t, pluginViews)),
  );
  const terminalLabelById = new Map(
    terminalTabsInOrder.map((tab, index) => [tab.id, terminalDisplayLabels[index]] as const),
  );
  const labelFor = (tab: WorkPanelTab) =>
    tab.kind === "subagent"
      ? (subagentLabelById.get(tab.id) ?? t("panel.tabs.subagent"))
      : (terminalLabelById.get(tab.id) ?? tabLabel(tab, t, pluginViews));
  const iconFor = (tab: WorkPanelTab) =>
    tab.kind === "plugin"
      ? pluginViewIcon(pluginViews.find((view) => view.ref === tab.resource)?.icon) ?? TAB_ICONS.plugin
      : TAB_ICONS[tab.kind];

  // mc-agent (MC-ADR-0005): each pane renders the tab it shows; several
  // panes, and so several surfaces, are on screen at once.
  const renderSurface = (tab: WorkPanelTab, { blocked }: { blocked: boolean }) => {
    const surfaceProps = {
      id: `work-panel-surface-${tab.id}`,
      className: "work-panel-tabpane",
      role: "tabpanel",
    };
    if (tab.kind === "subagent") {
      return (
        <div key={tab.id} {...surfaceProps}>
          <SubagentTranscriptTab delegationId={tab.resource ?? ""} />
        </div>
      );
    }
    if (tab.kind === "terminal") {
      return tab.resource ? (
        <div key={tab.id} {...surfaceProps}>
          <TerminalTab tabId={tab.id} cwd={tab.resource} active={tab.id === activeTabId} />
        </div>
      ) : null;
    }
    if (tab.kind === "background") {
      return (
        <div key={tab.id} {...surfaceProps}>
          <BackgroundPane />
        </div>
      );
    }
    if (tab.kind === "review") {
      return (
        <div key={tab.id} {...surfaceProps}>
          <ReviewTab />
        </div>
      );
    }
    if (tab.kind === "file") {
      return (
        <div key={tab.id} {...surfaceProps}>
          <FilesTab />
        </div>
      );
    }
    if (tab.kind === "plugin") {
      const ref = parsePluginViewRef(tab.resource);
      if (!ref) return null;
      return (
        <div key={tab.id} {...surfaceProps}>
          <PluginViewTab
            pluginId={ref.pluginId}
            viewId={ref.viewId}
            title={labelFor(tab)}
            icon={pluginViews.find((view) => view.ref === tab.resource)?.icon}
            sessionId={activeSessionId ?? undefined}
            location={tab.location}
            tabId={tab.id}
            // Native WebContentsViews composite above renderer content.
            blocked={blocked || exiting || panelBlocked || blockingOverlayActive}
          />
        </div>
      );
    }
    return (
      <div key={tab.id} {...surfaceProps} data-testid="work-panel-empty">
        <div className="work-panel-launcher">
          <div className="work-panel-launcher-title">{t("panel.new.title")}</div>
          <div className="work-panel-launcher-list" role="group" aria-label={t("panel.toolsAndPanels")}>
            {tools.map((item) => (
              <button
                key={item.id}
                type="button"
                className="work-panel-launcher-row"
                data-work-panel-launcher-item={item.id}
                onClick={() => selectTool(item, tab.id)}
              >
                <span className="work-panel-launcher-icon" aria-hidden>
                  <ToolIcon item={item} />
                </span>
                <span className="work-panel-launcher-label">{item.label}</span>
              </button>
            ))}
          </div>
        </div>
      </div>
    );
  };
  const exitAnimationReady = exiting && nativeSurfaceReadyForExit;
  const panelStyle = {
    width: renderPanelWidth,
    maxWidth: layout.maxPanelWidth,
    "--work-panel-width": `${renderPanelWidth}px`,
  } as CSSProperties;

  const main = (
    <div className="work-panel-main">
      <header className="work-panel-header">
        {/* mc-agent: the tools sit where the tab strip was; tabs live in
            each tool's pane (MC-ADR-0005). */}
        <div className="work-panel-tab-strip-wrap">
          <WorkPanelQuickTools />
        </div>
        {dock === "side" ? (
          <div className="work-panel-actions no-drag">
            <TooltipButton
              type="button"
              className="work-panel-maximize"
              tooltip={t(maximized ? "panel.restore" : "panel.maximize")}
              ariaLabel={t(maximized ? "panel.restore" : "panel.maximize")}
              aria-pressed={maximized}
              onClick={() => onToggleMaximize?.()}
            >
              {maximized ? (
                <IconPanelRestore size={15} />
              ) : (
                <IconPanelMaximize size={15} />
              )}
            </TooltipButton>
          </div>
        ) : null}
      </header>
      <div className="work-panel-body">
        {tabs.length > 0 ? (
          <WorkPanes
            tabs={tabs}
            activeTabId={activeTabId}
            terminalCwd={terminalCwd}
            labelFor={labelFor}
            iconFor={iconFor}
            renderSurface={renderSurface}
          />
        ) : (
          <div className="work-panel-tabpane mc-panes-empty" data-testid="work-panel-empty">
            {t("mcProject.panesEmpty")}
          </div>
        )}
      </div>
    </div>
  );

  if (dock === "bottom") {
    return (
      <section className="work-panel is-bottom-dock" data-testid="work-panel">
        {main}
      </section>
    );
  }

  return (
    <aside
      className={cx(
        "work-panel",
        maximized && "is-maximized",
        exiting && !exitAnimationReady && "is-exit-pending",
        exitAnimationReady && "is-exiting",
      )}
      style={panelStyle}
      data-testid="work-panel"
      data-resizing={isResizing ? "true" : undefined}
      data-exiting={exiting ? "true" : undefined}
      onAnimationEnd={(event) => {
        if (!exitAnimationReady) return;
        if (event.target !== event.currentTarget) return;
        if (!event.animationName.startsWith("work-panel-out")) return;
        onExitAnimationEnd?.();
      }}
    >
      <div
        className="work-panel-resize no-drag"
        role="separator"
        aria-orientation="vertical"
        aria-label={t("panel.resize")}
        aria-valuemin={Math.min(
          panelMinimum,
          Math.max(WORK_PANEL_COMPACT_MIN_WIDTH, layout.maxPanelWidth),
        )}
        aria-valuemax={Math.max(
          Math.min(panelMinimum, layout.maxPanelWidth),
          layout.maxPanelWidth,
        )}
        aria-valuenow={Math.round(panelDragWidth ?? renderPanelWidth)}
        aria-disabled={maximized || undefined}
        data-maximized={maximized ? "true" : undefined}
        tabIndex={0}
        onPointerDown={onPanelResizeStart}
        onPointerMove={onPanelResizeMove}
        onPointerUp={onPanelResizeCommit}
        onPointerCancel={onPanelResizeCancel}
        onLostPointerCapture={onPanelResizeCancel}
        onKeyDown={onPanelResizeKeyDown}
        onDoubleClick={onPanelResizeReset}
      />
      {main}
    </aside>
  );
}
