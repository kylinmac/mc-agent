import { useTranslation } from "react-i18next";
import { useAppStore } from "../../stores/app-store";
import { TooltipButton } from "../../components/ui";
import { IconClock, IconHome, IconPlug, IconSettings } from "../../components/icons";

/*
  mc-agent: a narrow rail at the window's left edge holding the app-level
  destinations that used to sit in the sidebar footer (plugins, scheduled
  tasks, settings; notifications moved to the title bar's right end). Each
  opens as a tab in the title bar. It stays visible while the sidebar is
  collapsed. Home on top returns to the conversations (and the sidebar's
  conversation list, which settings replaces with its own nav). Two stacked
  sections: the built-in destinations on top, then,
  below a divider, a slot reserved for plugin-contributed entries (empty
  until plugins can register rail items). Settings alone sits at the bottom,
  like an account slot.
*/
export function AppRail() {
  const { t } = useTranslation();
  const page = useAppStore((s) => s.page);
  const setPage = useAppStore((s) => s.setPage);
  const navBack = useAppStore((s) => s.navBack);
  const canNavBack = useAppStore((s) => s.canNavBack);

  return (
    <nav className="app-rail" aria-label={t("mcProject.appRailLabel")}>
      <div className="app-rail-drag" aria-hidden />
      <div className="footer-actions app-rail-actions no-drag">
        <TooltipButton
          type="button"
          tooltipSide="right"
          className={`footer-action ${page !== "settings" ? "active" : ""}`}
          data-nav="rail-home"
          tooltip={t("mcProject.appRailHome")}
          ariaLabel={t("mcProject.appRailHome")}
          onClick={() => setPage("chat")}
          aria-pressed={page !== "settings"}
        >
          <IconHome size={16} aria-hidden />
        </TooltipButton>
        <TooltipButton
          type="button"
          tooltipSide="right"
          className={`footer-action ${page === "plugins" ? "active" : ""}`}
          data-nav="plugins"
          tooltip={t("nav.plugins")}
          ariaLabel={t("nav.plugins")}
          onClick={() => page === "plugins"
            ? (canNavBack() ? navBack() : setPage("chat"))
            : setPage("plugins")}
          aria-pressed={page === "plugins"}
        >
          <IconPlug size={16} aria-hidden />
        </TooltipButton>
        <TooltipButton
          type="button"
          tooltipSide="right"
          className={`footer-action ${page === "scheduled" ? "active" : ""}`}
          data-nav="scheduled"
          tooltip={t("scheduled.title")}
          ariaLabel={t("scheduled.title")}
          onClick={() => setPage("scheduled")}
          aria-pressed={page === "scheduled"}
        >
          <IconClock size={16} aria-hidden />
        </TooltipButton>
      </div>
      <div className="app-rail-divider" aria-hidden />
      <div className="app-rail-plugins no-drag" data-slot="app-rail-plugins" />
      <div className="app-rail-bottom no-drag">
        <TooltipButton
          type="button"
          tooltipSide="right"
          className={`footer-action ${page === "settings" ? "active" : ""}`}
          data-nav="settings"
          tooltip={t("nav.settings")}
          ariaLabel={t("nav.settings")}
          onClick={() => setPage("settings")}
          aria-pressed={page === "settings"}
        >
          <IconSettings size={16} aria-hidden />
        </TooltipButton>
      </div>
    </nav>
  );
}
