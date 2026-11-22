import { useTranslation } from "react-i18next";
import { IconClock, IconHome, IconPlug, IconSettings } from "../../components/icons";
import { TooltipButton } from "../../components/ui";
import { pluginViewIcon, pluginViewInitial } from "../../lib/plugin-view-icons";
import { pluginWorkPanelTab } from "../../lib/work-panel-tabs";
import { useAppStore } from "../../stores/app-store";
import { BROWSER_VIEW_REF, FILES_VIEW_REF } from "../../lib/work-panel/work-panes-model";
import { UpdateRailButton } from "./UpdateRailButton";

/*
  mc-agent Zen shell (MC-ADR-0029 / R35–R36): replaces the standalone 52px
  leftmost AppRail column with a quiet, monochrome horizontal dock at the
  bottom of the sidebar. Mounted outside `.sidebar-body` so it remains visible
  on Settings and Plugins pages too, while retiring the Creative Studio entry.
*/
export function SidebarFooter() {
  const { t } = useTranslation();
  const page = useAppStore((s) => s.page);
  const setPage = useAppStore((s) => s.setPage);
  const navBack = useAppStore((s) => s.navBack);
  const canNavBack = useAppStore((s) => s.canNavBack);
  const pluginViews = useAppStore((s) => s.pluginViews);
  const activeSessionId = useAppStore((s) => s.activeSessionId);
  const openWorkPanelTab = useAppStore((s) => s.openWorkPanelTab);
  const railViews = pluginViews.filter(
    (view) => view.ref !== BROWSER_VIEW_REF && view.ref !== FILES_VIEW_REF,
  );

  return (
    <div
      className="mc-sidebar-footer no-drag"
      role="navigation"
      aria-label={t("mcProject.appRailLabel")}
    >
      <div className="mc-sidebar-footer-group">
        <TooltipButton
          type="button"
          className={`footer-action ${page === "chat" ? "active" : ""}`}
          data-nav="rail-home"
          tooltip={t("mcProject.appRailHome")}
          ariaLabel={t("mcProject.appRailHome")}
          onClick={() => setPage("chat")}
          aria-pressed={page === "chat"}
        >
          <IconHome size={15} aria-hidden />
        </TooltipButton>
        <TooltipButton
          type="button"
          className={`footer-action ${page === "plugins" ? "active" : ""}`}
          data-nav="plugins"
          tooltip={t("nav.plugins")}
          ariaLabel={t("nav.plugins")}
          onClick={() =>
            page === "plugins"
              ? canNavBack()
                ? navBack()
                : setPage("chat")
              : setPage("plugins")
          }
          aria-pressed={page === "plugins"}
        >
          <IconPlug size={15} aria-hidden />
        </TooltipButton>
        <TooltipButton
          type="button"
          className={`footer-action ${page === "scheduled" ? "active" : ""}`}
          data-nav="scheduled"
          tooltip={t("scheduled.title")}
          ariaLabel={t("scheduled.title")}
          onClick={() =>
            page === "scheduled"
              ? canNavBack()
                ? navBack()
                : setPage("chat")
              : setPage("scheduled")
          }
          aria-pressed={page === "scheduled"}
        >
          <IconClock size={15} aria-hidden />
        </TooltipButton>
        <div className="mc-sidebar-footer-plugins" data-slot="app-rail-plugins">
          {railViews.map((view) => {
            const Icon = pluginViewIcon(view.icon);
            return (
              <TooltipButton
                key={view.ref}
                type="button"
                className="footer-action"
                data-nav={`rail-view:${view.ref}`}
                tooltip={
                  activeSessionId
                    ? view.title
                    : t("mcProject.appRailViewNeedsSession", { name: view.title })
                }
                ariaLabel={view.title}
                disabled={!activeSessionId}
                onClick={() => {
                  setPage("chat");
                  openWorkPanelTab(pluginWorkPanelTab(view.pluginId, view.viewId));
                }}
              >
                {Icon ? (
                  <Icon size={15} aria-hidden />
                ) : (
                  <span className="app-rail-initial" aria-hidden>
                    {pluginViewInitial(view.title)}
                  </span>
                )}
              </TooltipButton>
            );
          })}
        </div>
      </div>

      <div className="mc-sidebar-footer-end">
        <UpdateRailButton />
        <TooltipButton
          type="button"
          className={`footer-action ${page === "settings" ? "active" : ""}`}
          data-nav="settings"
          tooltip={t("nav.settings")}
          ariaLabel={t("nav.settings")}
          onClick={() =>
            page === "settings"
              ? canNavBack()
                ? navBack()
                : setPage("chat")
              : setPage("settings")
          }
          aria-pressed={page === "settings"}
        >
          <IconSettings size={15} aria-hidden />
        </TooltipButton>
      </div>
    </div>
  );
}
