import { useEffect, useMemo, useRef, useState } from "react";
import { TooltipButton, cx, Button } from "../components/ui";
import {
  IconChevronLeft,
  IconCircleAlert,
  IconCloudDown,
  IconMore,
  IconPlug,
  IconSearch,
} from "../components/icons";
import { IntoSidebarSlot } from "../features/sidebar-slot/SidebarSlot";
import { useAppStore } from "../stores/app-store";
import { AnchoredMenu } from "../components/settings/AnchoredMenu";
import { SearchField } from "../features/plugins/presentation";
import { InstalledPluginView } from "../features/plugins/InstalledPluginView";
import { MarketplacePanel } from "../features/plugins/MarketplacePanel";
import { PluginDetailSheet } from "../features/plugins/PluginDetailSheet";
import { PluginDialogs } from "../features/plugins/PluginDialogs";
import { usePluginsPage } from "../features/plugins/usePluginsPage";

export function PluginsPage() {
  const page = usePluginsPage();
  const {
    t,
    tab,
    setTab,
    refreshMarket,
    query,
    setQuery,
    headerMenu,
    setHeaderMenu,
    overflowActions,
    stats,
    plugins,
    installedQuery,
    filteredInstalled,
    setInstalledQuery,
    marketLoading,
    market,
    showToast,
    installedGroups,
    busyId,
    queueInstall,
  } = page;

  /*
    mc-agent: a sidebar like the settings page's, after desktop agents'
    "Customize" panel: the marketplace entry, then every installed plugin.
    The right side shows the marketplace, or the controls of the plugin
    picked in the sidebar; there is no separate installed list any more.
  */
  const setPage = useAppStore((state) => state.setPage);
  const [selected, setSelected] = useState<string | null>(null);
  const selectedPlugin = selected
    ? plugins.find((plugin) => plugin.id === selected)
    : undefined;
  useEffect(() => {
    // A plugin uninstalled while shown hands the page back to the marketplace.
    if (selected && !selectedPlugin) setSelected(null);
  }, [selected, selectedPlugin]);
  useEffect(() => {
    setTab(selectedPlugin ? "installed" : "market");
  }, [selectedPlugin, setTab]);
  const attention = useMemo(
    () =>
      new Set(
        installedGroups
          .filter((group) => group.id === "attention")
          .flatMap((group) => group.rows.map((row) => row.id)),
      ),
    [installedGroups],
  );

  /**
   * Pending updates are announced once, where the user is looking, instead of
   * holding a banner open across the route. Applying them keeps its entry on
   * the header menu (`plugins.applyAutoUpdates`), and a count that was already
   * on screen when the page opened is not news.
   */
  const reportedUpdatesRef = useRef<number | null>(null);
  useEffect(() => {
    const reported = reportedUpdatesRef.current;
    reportedUpdatesRef.current = stats.updates;
    if (reported === null || reported === stats.updates || stats.updates === 0)
      return;
    showToast(t("plugins.updatesReady", { count: stats.updates }), { variant: "info" });
  }, [stats.updates, showToast, t]);

  const sidebar = (
    <IntoSidebarSlot>
      <aside
        className="settings-nav sidebar-surface mc-plugins-nav"
        aria-label={t("plugins.title")}
      >
        <div className="settings-nav-top drag">
          <div className="settings-search-wrap no-drag">
            <IconSearch size={14} />
            <input
              className="settings-search"
              value={installedQuery}
              onChange={(event) => setInstalledQuery(event.target.value)}
              placeholder={t("plugins.searchInstalled")}
              aria-label={t("plugins.searchInstalled")}
              spellCheck={false}
            />
          </div>
        </div>
        <div className="settings-nav-scroll no-drag">
          <div className="settings-nav-group">
            <button
              type="button"
              className={cx("settings-nav-item", !selectedPlugin && "active")}
              onClick={() => setSelected(null)}
            >
              <span className="settings-nav-icon">
                <IconCloudDown size={14} />
              </span>
              <span className="settings-nav-label">
                {t("plugins.tabMarket")}
              </span>
              {market.length ? (
                <span className="mc-plugins-nav-count">{market.length}</span>
              ) : null}
            </button>
          </div>
          <div className="settings-nav-group">
            <div className="settings-nav-group-label">
              {t("plugins.tabInstalled")} · {stats.total}
            </div>
            {filteredInstalled.length === 0 ? (
              <div className="settings-nav-empty">
                {plugins.length ? t("plugins.noMatches") : t("plugins.empty")}
              </div>
            ) : (
              filteredInstalled.map((plugin) => (
                <div key={plugin.id} className="mc-plugins-nav-row">
                  <button
                    type="button"
                    className={cx(
                      "settings-nav-item",
                      "mc-plugins-nav-item",
                      selected === plugin.id && "active",
                      !plugin.enabled && "is-off",
                    )}
                    title={plugin.description || plugin.name}
                    onClick={() => setSelected(plugin.id)}
                  >
                    <span className="settings-nav-icon">
                      {attention.has(plugin.id) ? (
                        <IconCircleAlert size={14} />
                      ) : (
                        <IconPlug size={14} />
                      )}
                    </span>
                    <span className="settings-nav-label">{plugin.name}</span>
                  </button>
                  {/* mc-agent: update straight from the list, one click. */}
                  {plugin.updateAvailable ? (
                    <button
                      type="button"
                      className="mc-plugins-nav-update"
                      disabled={busyId === plugin.id}
                      title={`${t("plugins.updateNow")} v${plugin.updateAvailable.version}`}
                      aria-label={`${t("plugins.updateNow")} ${plugin.name} v${plugin.updateAvailable.version}`}
                      onClick={() =>
                        queueInstall({
                          id: plugin.id,
                          name: plugin.name,
                          version: plugin.updateAvailable!.version,
                          permissions: plugin.permissions ?? [],
                          newPermissions: plugin.updateAvailable!.permissionDiff ?? [],
                        })
                      }
                    >
                      {busyId === plugin.id ? t("plugins.updating") : t("mcProject.pluginsUpdateShort")}
                    </button>
                  ) : null}
                </div>
              ))
            )}
          </div>
        </div>
        <div className="settings-nav-footer no-drag">
          <button
            type="button"
            className="settings-back no-drag"
            onClick={() => setPage("chat")}
          >
            <IconChevronLeft size={15} />
            <span>{t("settings.backToApp")}</span>
          </button>
        </div>
      </aside>
    </IntoSidebarSlot>
  );

  return (
    <div className="route-scroll">
      {sidebar}
      <div className="page-frame plugins-page mc-slot-page">
        {selectedPlugin ? (
          <InstalledPluginView plugin={selectedPlugin} page={page} />
        ) : (
          <>
            <div className="page-header plugins-page-header">
              <div className="plugins-title-block">
                <span className="plugins-title-icon" aria-hidden>
                  <IconCloudDown size={14} />
                </span>
                <div className="plugins-title-copy">
                  <h1 className="page-title">{t("plugins.tabMarket")}</h1>
                </div>
              </div>
              <div className="plugins-header-actions">
                <Button
                  variant="primary"
                  size="sm"
                  onClick={() => void refreshMarket(query, { refreshRemote: true })}
                >
                  <IconCloudDown size={14} />
                  {t("plugins.refreshMarket")}
                </Button>
                <AnchoredMenu
                  className="plugins-menu-wrap"
                  open={headerMenu}
                  onClose={() => setHeaderMenu(false)}
                  menuClassName="plugins-menu is-end"
                  label={t("plugins.moreActions")}
                  role="menu"
                  align="end"
                  trigger={(ref) => (
                    <TooltipButton
                      ref={ref}
                      type="button"
                      className="plugins-icon-btn plugins-header-menu"
                      ariaLabel={t("plugins.moreActions")}
                      tooltip={t("plugins.moreActions")}
                      aria-haspopup="menu"
                      aria-expanded={headerMenu}
                      onClick={() => setHeaderMenu((open) => !open)}
                    >
                      <IconMore size={16} />
                    </TooltipButton>
                  )}
                >
                  {overflowActions.map((action) => (
                    <button
                      key={action.key}
                      type="button"
                      role="menuitem"
                      data-action={action.key}
                      onClick={() => {
                        setHeaderMenu(false);
                        void action.run();
                      }}
                    >
                      {t(`plugins.${action.key}`)}
                    </button>
                  ))}
                </AnchoredMenu>
              </div>
            </div>
            <div className="plugins-toolbar">
              <div className="plugins-toolbar-end">
                {marketLoading ? (
                  <span className="plugins-result-count" aria-live="polite">
                    {t("plugins.marketLoading")}
                  </span>
                ) : null}
                <SearchField
                  value={query}
                  onChange={setQuery}
                  placeholder={t("plugins.marketSearchPlaceholder")}
                />
              </div>
            </div>
            <MarketplacePanel {...page} />
          </>
        )}
      </div>

      <PluginDetailSheet {...page} />
      <PluginDialogs {...page} />
    </div>
  );
}
