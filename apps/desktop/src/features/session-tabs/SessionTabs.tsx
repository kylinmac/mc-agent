import { useEffect, useMemo, useRef, useState, type MouseEvent, type PointerEvent, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { create } from "zustand";
import { useAppStore } from "../../stores/app-store";
import { IconClock, IconClose, IconPalette, IconPlug, IconPlus, IconSettings } from "../../components/icons";
import { NotificationCenter } from "../../components/NotificationCenter";
import type { SessionSummary } from "@pi-desktop/shared";
import { SessionRenameDialog } from "../../components/SessionRenameDialog";
import { sessionPinned } from "../../lib/sidebar-session-groups";
import { ContextMenu, useContextMenu } from "../../components/ContextMenu";
import { setSplitColumns, setSplitDropHint, useSplitView } from "../../lib/mc-split-view";
import { closeSplitColumn, openSessionRight } from "../split-view/split-actions";
import {
  activeTabKey,
  closeTab,
  closeTabGroup,
  type TabCloseScope,
  loadTabs,
  moveTab,
  openTab,
  pruneTabs,
  saveTabs,
  tabDropTarget,
  tabPage,
  type PageTab,
} from "./tab-list";

/* One tab list for every title bar (chat and route pages share it). */
const useTabStore = create<{ tabs: string[]; setTabs: (update: (tabs: string[]) => string[]) => void }>(
  (set) => ({
    tabs: loadTabs(),
    setTabs: (update) =>
      set((state) => {
        const tabs = update(state.tabs);
        if (tabs !== state.tabs) saveTabs(tabs);
        return { tabs };
      }),
  }),
);

function isDefaultTitle(title?: string | null) {
  const trimmed = (title || "").trim().toLowerCase();
  return !trimmed || ["new task", "new chat", "新建任务", "新对话"].includes(trimmed);
}

const PAGE_ICONS: Record<PageTab, ReactNode> = {
  plugins: <IconPlug size={12} aria-hidden />,
  scheduled: <IconClock size={12} aria-hidden />,
  creative: <IconPalette size={12} aria-hidden />,
  settings: <IconSettings size={12} aria-hidden />,
};

/*
  mc-agent: the fixed tab bar across the title bar, after an IDE's editor
  tabs. Conversations and the app pages opened from the rail (plugins,
  scheduled tasks, settings) each get a tab. Clicking a tab switches to it,
  closing one shows its neighbour (or a new task when it was the last), "+"
  starts a new task, and the notification bell sits at the bar's right end.
  Tabs reorder by dragging (past a few pixels, so a click still switches) or
  with Alt+Left / Alt+Right. A conversation tab dragged down onto the
  conversation, or "Open to the right" from its menu, opens it in a column
  beside the current one (MC-ADR-0007).
*/

/** The pointer is over the conversation area, well below the tab strip. */
function overConversation(x: number, y: number, strip: HTMLElement | null): boolean {
  const surface = document.querySelector<HTMLElement>(".chat-surface");
  if (!surface || !strip) return false;
  const rect = surface.getBoundingClientRect();
  return y > strip.getBoundingClientRect().bottom + 24 && y >= rect.top && y <= rect.bottom && x >= rect.left && x <= rect.right;
}

const DRAG_THRESHOLD = 5;
export function SessionTabs({ onNewTask }: { onNewTask: () => void }) {
  const { t } = useTranslation();
  const activeSessionId = useAppStore((s) => s.activeSessionId);
  const sessions = useAppStore((s) => s.sessions);
  const runningSessions = useAppStore((s) => s.runningSessions);
  const page = useAppStore((s) => s.page);
  const setPage = useAppStore((s) => s.setPage);
  const selectSession = useAppStore((s) => s.selectSession);
  const renameSession = useAppStore((s) => s.renameSession);
  const toggleSessionPinned = useAppStore((s) => s.toggleSessionPinned);
  const sessionMeta = useAppStore((s) => s.sessionMeta);
  const showToast = useAppStore((s) => s.showToast);
  const [renameFor, setRenameFor] = useState<SessionSummary | null>(null);
  const tabs = useTabStore((s) => s.tabs);
  const setTabs = useTabStore((s) => s.setTabs);
  const activeKey = activeTabKey(page, activeSessionId);
  const stripRef = useRef<HTMLDivElement | null>(null);
  const drag = useRef<{ pointerId: number; key: string; startX: number; armed: boolean } | null>(null);
  const suppressClick = useRef(false);
  const [dragging, setDragging] = useState<string | null>(null);
  const [drop, setDrop] = useState<{ key: string; after: boolean } | null>(null);
  const splitColumns = useSplitView((s) => s.columns);
  const splitHint = useSplitView((s) => s.dropHint);
  const { contextMenu, openContextMenu, closeContextMenu } = useContextMenu();
  /*
    The conversation to put on the left when the one on screen opens to the
    right: the last other conversation visited, else the nearest tab.
  */
  const companionOf = (key: string): string | undefined => {
    const sessionTabs = tabs.filter((tab) => !tabPage(tab) && tab !== key);
    const visited = [...useAppStore.getState().navStack]
      .reverse()
      .find((entry) => entry.page === "chat" && entry.sessionId && sessionTabs.includes(entry.sessionId));
    if (visited?.sessionId) return visited.sessionId;
    const index = tabs.indexOf(key);
    const before = tabs.slice(0, index).reverse().find((tab) => sessionTabs.includes(tab));
    return before ?? tabs.slice(index + 1).find((tab) => sessionTabs.includes(tab));
  };
  // A conversation can open beside the one on screen unless it is already
  // there; the one on screen alone needs another to sit beside.
  const canOpenRight = (key: string) =>
    !tabPage(key) &&
    !splitColumns.includes(key) &&
    (splitColumns.length > 0 || key !== activeSessionId || companionOf(key) !== undefined);
  const openRight = (key: string) => openSessionRight(key, companionOf(key));

  const onTabPointerDown = (event: PointerEvent<HTMLDivElement>, key: string) => {
    if (event.button !== 0 || (event.target as Element).closest("button")) return;
    drag.current = { pointerId: event.pointerId, key, startX: event.clientX, armed: false };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const onTabPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const current = drag.current;
    if (!current || current.pointerId !== event.pointerId) return;
    if (!current.armed) {
      if (Math.abs(event.clientX - current.startX) < DRAG_THRESHOLD) return;
      current.armed = true;
      setDragging(current.key);
    }
    if (canOpenRight(current.key) && overConversation(event.clientX, event.clientY, stripRef.current)) {
      setSplitDropHint(true);
      setDrop(null);
      return;
    }
    setSplitDropHint(false);
    const rects = [...(stripRef.current?.querySelectorAll<HTMLElement>("[data-tab-key]") ?? [])]
      .filter((element) => element.dataset.tabKey !== current.key)
      .map((element) => {
        const rect = element.getBoundingClientRect();
        return { key: element.dataset.tabKey ?? "", left: rect.left, right: rect.right };
      });
    setDrop(tabDropTarget(event.clientX, rects));
  };
  const onTabPointerUp = (event: PointerEvent<HTMLDivElement>) => {
    const current = drag.current;
    if (!current || current.pointerId !== event.pointerId) return;
    drag.current = null;
    if (current.armed) {
      // The click that follows a drag must not also switch tabs.
      suppressClick.current = true;
      if (splitHint) openRight(current.key);
      else if (drop) setTabs((tabs) => moveTab(tabs, current.key, drop.key, drop.after));
    }
    setSplitDropHint(false);
    setDragging(null);
    setDrop(null);
  };

  const byId = useMemo(() => new Map(sessions.map((session) => [session.id, session])), [sessions]);

  // What is on screen always has a tab.
  useEffect(() => {
    if (activeKey) setTabs((current) => (current.includes(activeKey) ? current : openTab(current, activeKey, activeKey)));
  }, [activeKey, setTabs]);

  // Deleted conversations lose their tab once the session list has loaded.
  useEffect(() => {
    if (sessions.length === 0) return;
    setTabs((current) => {
      const known = new Set(sessions.map((session) => session.id));
      if (activeSessionId) known.add(activeSessionId);
      const pruned = pruneTabs(current, known);
      return pruned.length === current.length ? current : pruned;
    });
  }, [sessions, activeSessionId, setTabs]);

  const pageTitle: Record<PageTab, string> = {
    plugins: t("nav.plugins"),
    scheduled: t("scheduled.title"),
    creative: t("mcProject.creativeTitle"),
    settings: t("nav.settings"),
  };
  const titleOf = (key: string) => {
    const tabPageName = tabPage(key);
    if (tabPageName) return pageTitle[tabPageName];
    const title = byId.get(key)?.title;
    return isDefaultTitle(title) ? t("chat.untitledTask") : (title as string);
  };

  const show = (key: string) => {
    const target = tabPage(key);
    if (target) setPage(target);
    else void selectSession(key);
  };

  const close = (key: string, event?: MouseEvent) => {
    event?.stopPropagation();
    const result = closeTab(tabs, key, activeKey);
    setTabs(() => result.tabs);
    // A conversation in a split column leaves the split; the split decides focus.
    if (splitColumns.includes(key)) {
      closeSplitColumn(key);
      return;
    }
    if (!result.closedActive) return;
    if (result.next) show(result.next);
    else onNewTask();
  };

  const closeGroup = (key: string, scope: TabCloseScope) => {
    const store = useAppStore.getState();
    const current = useTabStore.getState().tabs;
    const result = closeTabGroup(current, key, activeTabKey(store.page, store.activeSessionId), scope);
    const removed = new Set(current.filter((tab) => !result.tabs.includes(tab)));
    const columns = useSplitView.getState().columns.filter((id) => !removed.has(id));
    setSplitColumns(columns.length < 2 ? [] : columns);
    setTabs(() => result.tabs);
    if (!result.closedActive) return;
    const next = columns.length ? columns[0] : result.next;
    if (next) show(next);
    else onNewTask();
  };

  const move = (key: string, direction: number) => setTabs((current) => {
    const neighbour = current[current.indexOf(key) + direction];
    return neighbour ? moveTab(current, key, neighbour, direction > 0) : current;
  });

  return (
    <div className="mc-titlebar-tabs">
      <div ref={stripRef} className="mc-session-tabs" role="tablist" aria-label={t("mcProject.sessionTabsLabel")}>
        {tabs.map((key) => {
          const active = key === activeKey;
          const title = titleOf(key);
          const target = tabPage(key);
          return (
            <div
              key={key}
              role="tab"
              tabIndex={0}
              aria-selected={active}
              aria-keyshortcuts="Alt+ArrowLeft Alt+ArrowRight"
              data-tab-key={key}
              className={[
                "mc-session-tab",
                active && "active",
                splitColumns.includes(key) && "in-split",
                dragging === key && "is-dragging",
                drop?.key === key && (drop.after ? "is-drop-after" : "is-drop-before"),
              ]
                .filter(Boolean)
                .join(" ")}
              title={title}
              onPointerDown={(event) => onTabPointerDown(event, key)}
              onPointerMove={onTabPointerMove}
              onPointerUp={onTabPointerUp}
              onPointerCancel={onTabPointerUp}
              onClick={() => {
                if (suppressClick.current) {
                  suppressClick.current = false;
                  return;
                }
                if (!active) show(key);
              }}
              onAuxClick={(event) => {
                if (event.button === 1) close(key, event);
              }}
              onContextMenu={(event) => {
                const session = byId.get(key);
                const index = tabs.indexOf(key);
                openContextMenu(event, {
                  label: title,
                  items: [
                    ...(session && session.source !== "pi-native" ? [{
                      id: "rename-session", label: t("nav.renameTask"), onSelect: () => setRenameFor(session),
                    }] : []),
                    ...(session ? [{
                      id: "toggle-session-pin",
                      label: t(sessionPinned(session, sessionMeta[key] ?? {}) ? "nav.unpinTask" : "nav.pinTask"),
                      onSelect: () => toggleSessionPinned(key),
                    }] : []),
                    ...(!target ? [{
                      id: "open-right",
                      label: t("mcProject.splitOpenRight"),
                      separatorBefore: Boolean(session),
                      disabled: !canOpenRight(key),
                      onSelect: () => openRight(key),
                    }] : []),
                    ...(splitColumns.includes(key)
                      ? [{ id: "close-column", label: t("mcProject.splitCloseColumn"), onSelect: () => closeSplitColumn(key) }]
                      : []),
                    { id: "move-left", label: t("mcProject.sessionTabMoveLeft"), disabled: index === 0, onSelect: () => move(key, -1) },
                    { id: "move-right", label: t("mcProject.sessionTabMoveRight"), disabled: index === tabs.length - 1, onSelect: () => move(key, 1) },
                    {
                      id: "close-tab",
                      label: t("mcProject.sessionTabCloseCurrent"),
                      separatorBefore: true,
                      onSelect: () => close(key),
                    },
                    { id: "close-others", label: t("mcProject.sessionTabCloseOthers"), disabled: tabs.length < 2, onSelect: () => closeGroup(key, "others") },
                    { id: "close-right", label: t("mcProject.sessionTabCloseRight"), disabled: index === tabs.length - 1, onSelect: () => closeGroup(key, "right") },
                    { id: "close-all", label: t("mcProject.sessionTabCloseAll"), onSelect: () => closeGroup(key, "all") },
                  ],
                });
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  if (!active) show(key);
                  return;
                }
                if (event.altKey && (event.key === "ArrowLeft" || event.key === "ArrowRight")) {
                  event.preventDefault();
                  const index = tabs.indexOf(key);
                  const neighbour = tabs[index + (event.key === "ArrowLeft" ? -1 : 1)];
                  if (neighbour) setTabs((current) => moveTab(current, key, neighbour, event.key === "ArrowRight"));
                }
              }}
            >
              {target ? (
                <span className="mc-session-tab-icon">{PAGE_ICONS[target]}</span>
              ) : (
                <span className={`mc-session-tab-dot${runningSessions[key] ? " running" : ""}`} aria-hidden />
              )}
              <span className="mc-session-tab-title">{title}</span>
              <button
                type="button"
                className="mc-session-tab-close"
                aria-label={t("mcProject.sessionTabClose", { title })}
                onClick={(event) => close(key, event)}
              >
                <IconClose size={11} aria-hidden />
              </button>
            </div>
          );
        })}
        <button
          type="button"
          className="mc-session-tab-new"
          aria-label={t("nav.newTask")}
          title={t("nav.newTask")}
          onClick={onNewTask}
        >
          <IconPlus size={13} aria-hidden />
        </button>
      </div>
      <div className="mc-titlebar-end">
        {(typeof window === "undefined" || window.piDesktop?.platform !== "win32") && <NotificationCenter />}
      </div>
      <ContextMenu state={contextMenu} onClose={closeContextMenu} />
      {renameFor ? <SessionRenameDialog
        session={renameFor}
        onClose={() => setRenameFor(null)}
        onSave={(title) => renameSession(renameFor.id, title)}
        onError={(error) => showToast(error instanceof Error ? error.message : String(error), { variant: "error" })}
      /> : null}
    </div>
  );
}
