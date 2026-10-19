import { useEffect, useMemo, useRef, useState, type MouseEvent, type PointerEvent, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { create } from "zustand";
import { useAppStore } from "../../stores/app-store";
import { IconClock, IconClose, IconPlug, IconPlus, IconSettings } from "../../components/icons";
import { NotificationCenter } from "../../components/NotificationCenter";
import {
  activeTabKey,
  closeTab,
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
  settings: <IconSettings size={12} aria-hidden />,
};

/*
  mc-agent: the fixed tab bar across the title bar, after an IDE's editor
  tabs. Conversations and the app pages opened from the rail (plugins,
  scheduled tasks, settings) each get a tab. Clicking a tab switches to it,
  closing one shows its neighbour (or a new task when it was the last), "+"
  starts a new task, and the notification bell sits at the bar's right end.
  Tabs reorder by dragging (past a few pixels, so a click still switches) or
  with Alt+Left / Alt+Right.
*/

const DRAG_THRESHOLD = 5;
export function SessionTabs({ onNewTask }: { onNewTask: () => void }) {
  const { t } = useTranslation();
  const activeSessionId = useAppStore((s) => s.activeSessionId);
  const sessions = useAppStore((s) => s.sessions);
  const runningSessions = useAppStore((s) => s.runningSessions);
  const page = useAppStore((s) => s.page);
  const setPage = useAppStore((s) => s.setPage);
  const selectSession = useAppStore((s) => s.selectSession);
  const tabs = useTabStore((s) => s.tabs);
  const setTabs = useTabStore((s) => s.setTabs);
  const activeKey = activeTabKey(page, activeSessionId);
  const stripRef = useRef<HTMLDivElement | null>(null);
  const drag = useRef<{ pointerId: number; key: string; startX: number; armed: boolean } | null>(null);
  const suppressClick = useRef(false);
  const [dragging, setDragging] = useState<string | null>(null);
  const [drop, setDrop] = useState<{ key: string; after: boolean } | null>(null);

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
      if (drop) setTabs((tabs) => moveTab(tabs, current.key, drop.key, drop.after));
    }
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
    if (!result.closedActive) return;
    if (result.next) show(result.next);
    else onNewTask();
  };

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
        <NotificationCenter />
      </div>
    </div>
  );
}
