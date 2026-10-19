import { Fragment, useCallback, useEffect, useRef, useState, type ComponentType, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { useAppStore } from "../../stores/app-store";
import type { WorkPanelTab } from "../../lib/work-panel-tabs";
import { cx } from "../../components/ui";
import type { IconProps } from "../../components/icons";
import {
  IconChevronDown,
  IconChevronRight,
  IconClose,
  IconDiff,
  IconFolder,
  IconGlobe,
  IconPlug,
  IconPlus,
  IconTerminal,
} from "../../components/icons";
import {
  groupPanes,
  movePane,
  paneActiveTab,
  paneDropTarget,
  paneFlexGrow,
  paneOf,
  resizePanePair,
  togglePaneCollapsed,
  type PaneId,
} from "./work-panes-model";
import { expandPane, updatePanePrefs, usePanePrefs } from "./pane-layout";
import { browserTab, terminalTab } from "./tool-tabs";

/*
  mc-agent work panel as stacked panes (MC-ADR-0005), after VS Code's and
  Codex's side panels: one pane per tool (terminal, browser, files, changes,
  other), each with its own tabs. A pane collapses to its header, its header
  drags it up or down, and the divider between panes drags their heights.
  A pane exists while it has tabs; closing the pane closes its tabs.

  Native plugin views composite above the renderer and would swallow the
  pointer, so they are hidden while a pane is being dragged or resized.
*/

const PANE_ICONS: Record<PaneId, ComponentType<IconProps>> = {
  terminal: IconTerminal,
  browser: IconGlobe,
  files: IconFolder,
  review: IconDiff,
  other: IconPlug,
};

type Props = {
  tabs: WorkPanelTab[];
  activeTabId: string | null;
  /** Folder a new terminal starts in, when the session has a local one. */
  terminalCwd?: string;
  labelFor: (tab: WorkPanelTab) => string;
  iconFor: (tab: WorkPanelTab) => ComponentType<IconProps>;
  renderSurface: (tab: WorkPanelTab, options: { blocked: boolean }) => ReactNode;
};

type PaneDrag = { pointerId: number; source: PaneId; startY: number; armed: boolean };

export function WorkPanes({ tabs, activeTabId, terminalCwd, labelFor, iconFor, renderSurface }: Props) {
  const { t } = useTranslation();
  const prefs = usePanePrefs();
  const activateTab = useAppStore((s) => s.activateWorkPanelTab);
  const closeTab = useAppStore((s) => s.closeWorkPanelTab);
  const openTab = useAppStore((s) => s.openWorkPanelTab);
  const reorderTabs = useAppStore((s) => s.reorderWorkPanelTabs);
  const [remembered, setRemembered] = useState<Partial<Record<PaneId, string>>>({});
  const [interacting, setInteracting] = useState(false);
  const [drop, setDrop] = useState<{ id: PaneId; after: boolean } | null>(null);
  const [draggingPane, setDraggingPane] = useState<PaneId | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const paneDrag = useRef<PaneDrag | null>(null);

  const groups = groupPanes(tabs, prefs.order);
  const expandedIds = groups.map((group) => group.id).filter((id) => !prefs.collapsed.includes(id));
  const grows = paneFlexGrow(expandedIds, prefs.sizes);
  const focusedPane = tabs.find((tab) => tab.id === activeTabId);
  const focusedPaneId = focusedPane ? paneOf(focusedPane) : null;

  // The focused tab (opened from chat, a tool icon or a chip) becomes its
  // pane's shown tab, and a collapsed pane opens to show it.
  // Keyed by id: a tab object replaced in place (a browser page's title) must
  // not reopen a pane the user just collapsed.
  const focusedTabId = focusedPane?.id;
  useEffect(() => {
    if (!focusedTabId || !focusedPaneId) return;
    setRemembered((current) =>
      current[focusedPaneId] === focusedTabId ? current : { ...current, [focusedPaneId]: focusedTabId },
    );
    expandPane(focusedPaneId);
  }, [focusedTabId, focusedPaneId]);

  const paneElement = (id: PaneId) =>
    rootRef.current?.querySelector<HTMLElement>(`[data-mc-pane="${id}"]`) ?? null;

  const closePane = (paneTabs: WorkPanelTab[]) => {
    for (const tab of paneTabs) closeTab(tab.id);
  };

  const addTab = (id: PaneId) => {
    if (id === "terminal" && terminalCwd) openTab(terminalTab(terminalCwd));
    if (id === "browser") openTab(browserTab());
  };

  // Header drag: reorder panes.
  const onHeaderPointerDown = (event: React.PointerEvent<HTMLElement>, id: PaneId) => {
    if (event.button !== 0 || (event.target as Element).closest("button")) return;
    paneDrag.current = { pointerId: event.pointerId, source: id, startY: event.clientY, armed: false };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const onHeaderPointerMove = (event: React.PointerEvent<HTMLElement>) => {
    const drag = paneDrag.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    if (!drag.armed) {
      if (Math.abs(event.clientY - drag.startY) < 4) return;
      drag.armed = true;
      setInteracting(true);
      setDraggingPane(drag.source);
    }
    const rects = groups.flatMap((group) => {
      const rect = paneElement(group.id)?.getBoundingClientRect();
      return rect ? [{ id: group.id, top: rect.top, bottom: rect.bottom }] : [];
    });
    const target = paneDropTarget(event.clientY, rects);
    setDrop(target && target.id !== drag.source ? target : null);
  };
  const onHeaderPointerUp = (event: React.PointerEvent<HTMLElement>) => {
    const drag = paneDrag.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    paneDrag.current = null;
    if (drag.armed && drop) {
      updatePanePrefs((current) => ({ ...current, order: movePane(current.order, drag.source, drop.id, drop.after) }));
    }
    setDrop(null);
    setDraggingPane(null);
    setInteracting(false);
  };

  // Divider drag: trade height between the nearest expanded panes around it.
  const onDividerPointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>, index: number) => {
      if (event.button !== 0) return;
      const expanded = (id: PaneId) => !prefs.collapsed.includes(id);
      const above = [...groups.slice(0, index)].reverse().find((group) => expanded(group.id));
      const below = groups.slice(index).find((group) => expanded(group.id));
      const elementA = above && paneElement(above.id);
      const elementB = below && paneElement(below.id);
      if (!above || !below || !elementA || !elementB) return;
      event.preventDefault();
      const target = event.currentTarget;
      target.setPointerCapture(event.pointerId);
      const start = {
        y: event.clientY,
        heightA: elementA.getBoundingClientRect().height,
        heightB: elementB.getBoundingClientRect().height,
        weightA: prefs.sizes[above.id] ?? 1,
        weightB: prefs.sizes[below.id] ?? 1,
      };
      setInteracting(true);
      const onMove = (move: PointerEvent) => {
        const next = resizePanePair(start, move.clientY - start.y);
        updatePanePrefs((current) => ({
          ...current,
          sizes: { ...current.sizes, [above.id]: next.weightA, [below.id]: next.weightB },
        }));
      };
      const onEnd = () => {
        target.removeEventListener("pointermove", onMove);
        target.removeEventListener("pointerup", onEnd);
        target.removeEventListener("pointercancel", onEnd);
        setInteracting(false);
      };
      target.addEventListener("pointermove", onMove);
      target.addEventListener("pointerup", onEnd);
      target.addEventListener("pointercancel", onEnd);
    },
    [groups, prefs.collapsed, prefs.sizes],
  );

  const resetSizes = () => updatePanePrefs((current) => ({ ...current, sizes: {} }));

  return (
    <div ref={rootRef} className="mc-panes" data-interacting={interacting ? "true" : undefined}>
      {groups.map((group, index) => {
        const collapsed = prefs.collapsed.includes(group.id);
        const shown = paneActiveTab(group.tabs, remembered[group.id]);
        const PaneIcon = PANE_ICONS[group.id];
        const paneTitle = t(`mcProject.pane${group.id[0]?.toUpperCase()}${group.id.slice(1)}`);
        // A pane holding just its own single tool needs no tab chip.
        const showChips = !(group.tabs.length === 1 && (group.id === "review" || group.id === "files"));
        const canAdd = (group.id === "terminal" && Boolean(terminalCwd)) || group.id === "browser";
        return (
          <Fragment key={group.id}>
            {index > 0 ? (
              <div
                className="mc-pane-divider"
                role="separator"
                aria-orientation="horizontal"
                aria-label={t("mcProject.paneResize")}
                onPointerDown={(event) => onDividerPointerDown(event, index)}
                onDoubleClick={resetSizes}
              />
            ) : null}
            <section
              className={cx(
                "mc-pane",
                collapsed && "is-collapsed",
                focusedPaneId === group.id && "is-focused",
                draggingPane === group.id && "is-dragging",
                drop?.id === group.id && (drop.after ? "is-drop-after" : "is-drop-before"),
              )}
              data-mc-pane={group.id}
              style={collapsed ? undefined : { flexGrow: grows[group.id] ?? 1 }}
              aria-label={paneTitle}
            >
              <header
                className="mc-pane-header"
                title={t("mcProject.paneDragHint")}
                onPointerDown={(event) => onHeaderPointerDown(event, group.id)}
                onPointerMove={onHeaderPointerMove}
                onPointerUp={onHeaderPointerUp}
                onPointerCancel={onHeaderPointerUp}
              >
                <button
                  type="button"
                  className="mc-pane-toggle"
                  aria-expanded={!collapsed}
                  onClick={() =>
                    updatePanePrefs((current) => ({
                      ...current,
                      collapsed: togglePaneCollapsed(current.collapsed, group.id),
                    }))
                  }
                >
                  {collapsed ? <IconChevronRight size={12} /> : <IconChevronDown size={12} />}
                  <PaneIcon size={13} />
                  <span>{paneTitle}</span>
                </button>
                {showChips ? (
                  <div className="mc-pane-tabs" role="tablist" aria-label={paneTitle}>
                    {group.tabs.map((tab) => {
                      const label = labelFor(tab);
                      const Icon = iconFor(tab);
                      const selected = tab.id === shown?.id;
                      return (
                        <div
                          key={tab.id}
                          className={cx("mc-pane-tab", selected && "active")}
                          draggable
                          onDragStart={(event) => {
                            event.dataTransfer.setData("text/x-mc-pane-tab", tab.id);
                            event.dataTransfer.effectAllowed = "move";
                          }}
                          onDragOver={(event) => {
                            if (event.dataTransfer.types.includes("text/x-mc-pane-tab")) event.preventDefault();
                          }}
                          onDrop={(event) => {
                            const source = event.dataTransfer.getData("text/x-mc-pane-tab");
                            const sourceTab = group.tabs.find((item) => item.id === source);
                            if (!sourceTab || source === tab.id) return;
                            event.preventDefault();
                            const rect = event.currentTarget.getBoundingClientRect();
                            reorderTabs(source, tab.id, event.clientX > rect.left + rect.width / 2);
                          }}
                        >
                          <button
                            type="button"
                            role="tab"
                            aria-selected={selected}
                            className="mc-pane-tab-button"
                            title={tab.kind === "subagent" ? label : tab.resource ?? label}
                            onClick={() => {
                              setRemembered((current) => ({ ...current, [group.id]: tab.id }));
                              activateTab(tab.id);
                              expandPane(group.id);
                            }}
                            onAuxClick={(event) => {
                              if (event.button !== 1) return;
                              event.preventDefault();
                              closeTab(tab.id);
                            }}
                          >
                            <Icon size={12} />
                            <span>{label}</span>
                          </button>
                          <button
                            type="button"
                            className="mc-pane-tab-close"
                            aria-label={t("panel.closeTab", { name: label })}
                            title={t("panel.closeTab", { name: label })}
                            onClick={() => closeTab(tab.id)}
                          >
                            <IconClose size={10} />
                          </button>
                        </div>
                      );
                    })}
                  </div>
                ) : (
                  <div className="mc-pane-tabs" />
                )}
                <div className="mc-pane-actions">
                  {canAdd ? (
                    <button
                      type="button"
                      className="mc-pane-action"
                      aria-label={t("mcProject.paneNewTab")}
                      title={t("mcProject.paneNewTab")}
                      onClick={() => addTab(group.id)}
                    >
                      <IconPlus size={13} />
                    </button>
                  ) : null}
                  <button
                    type="button"
                    className="mc-pane-action"
                    aria-label={t("mcProject.paneClose")}
                    title={t("mcProject.paneClose")}
                    onClick={() => closePane(group.tabs)}
                  >
                    <IconClose size={12} />
                  </button>
                </div>
              </header>
              {!collapsed && shown ? (
                <div className="mc-pane-body">{renderSurface(shown, { blocked: interacting })}</div>
              ) : null}
            </section>
          </Fragment>
        );
      })}
    </div>
  );
}
