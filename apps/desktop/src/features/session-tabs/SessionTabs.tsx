import { useEffect, useMemo, type MouseEvent, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { create } from "zustand";
import { useAppStore } from "../../stores/app-store";
import { IconClock, IconClose, IconPlug, IconPlus, IconSettings } from "../../components/icons";
import { NotificationCenter } from "../../components/NotificationCenter";
import {
  activeTabKey,
  closeTab,
  loadTabs,
  openTab,
  pruneTabs,
  saveTabs,
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
*/
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
      <div className="mc-session-tabs" role="tablist" aria-label={t("mcProject.sessionTabsLabel")}>
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
              className={`mc-session-tab${active ? " active" : ""}`}
              title={title}
              onClick={() => {
                if (!active) show(key);
              }}
              onAuxClick={(event) => {
                if (event.button === 1) close(key, event);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  if (!active) show(key);
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
