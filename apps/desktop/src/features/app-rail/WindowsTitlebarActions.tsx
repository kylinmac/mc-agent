import { useTranslation } from "react-i18next";
import { IconSearch, IconSidebar } from "../../components/icons";
import { NotificationCenter } from "../../components/NotificationCenter";
import { TooltipButton } from "../../components/ui";

/** Windows caption buttons occupy the right edge; navigation stays on the left. */
export function WindowsTitlebarActions({ collapsed, onToggleSidebar, onOpenSearch }: {
  collapsed: boolean;
  onToggleSidebar: () => void;
  onOpenSearch: () => void;
}) {
  const { t } = useTranslation();
  const toggleLabel = t(collapsed ? "nav.expandSidebar" : "nav.collapseSidebar");
  return (
    <div className="mc-windows-titlebar-actions no-drag" role="toolbar" aria-label={t("nav.conversation")}>
      <TooltipButton type="button" className="icon-btn icon-btn-square" tooltip={toggleLabel}
        ariaLabel={toggleLabel} aria-expanded={!collapsed} data-nav="toggle-sidebar" onClick={onToggleSidebar}>
        <IconSidebar size={15} />
      </TooltipButton>
      <NotificationCenter placement="below" />
      <TooltipButton type="button" className="icon-btn icon-btn-square" tooltip={t("nav.search")}
        ariaLabel={t("nav.search")} data-nav="search" onClick={onOpenSearch}>
        <IconSearch size={15} />
      </TooltipButton>
    </div>
  );
}
