import { useEffect, useRef, useState } from "react";
import type { ActivationScope, MarketPluginDetail, MarketPluginSummary, PluginSummary } from "@pi-desktop/shared";
import { Button, SettingsToggle, cx } from "../../components/ui";
import {
  IconCircleAlert,
  IconLink,
  IconPanel,
  IconPlug,
  IconReview,
  IconSettings,
  IconTrash,
  IconTriangleAlert,
  IconShield,
} from "../../components/icons";
import { ScopeControl } from "../../components/extensions/ScopeControl";
import { Markdown } from "../../components/Markdown";
import { api } from "../../lib/api";
import { useAppStore } from "../../stores/app-store";
import { openHttpUrl } from "../../lib/open-http-url";
import { authorParts, formatDate, versionWithdrawn } from "./model";
import { PluginRowDetails } from "./presentation";
import type { PluginsPageModel } from "./usePluginsPage";

/*
  mc-agent: one installed plugin on the whole page (the extensions sidebar
  picks it). Every action is a visible control instead of a row menu, and the
  marketplace's own information (links, safety notes, versions, README) is
  shown in place rather than in the detail sheet.
*/

type MarketInfo = { state: "loading" } | { state: "missing" } | { state: "ready"; detail: MarketPluginDetail };

function useMarketInfo(id: string): MarketInfo {
  const [info, setInfo] = useState<MarketInfo>({ state: "loading" });
  useEffect(() => {
    let canceled = false;
    setInfo({ state: "loading" });
    api.marketGetDetail(id).then(
      (res) => {
        if (canceled) return;
        const raw = res.plugin as (MarketPluginDetail & { summary?: MarketPluginSummary }) | undefined;
        if (!raw) {
          setInfo({ state: "missing" });
          return;
        }
        const detail: MarketPluginDetail = raw.summary
          ? {
              ...raw.summary,
              readmeMarkdown: raw.readmeMarkdown,
              versions: raw.versions ?? [],
              homepage: raw.homepage,
              repository: raw.repository,
              permissions: raw.permissions ?? raw.summary.permissionSummary ?? [],
              safetyNotes: raw.safetyNotes,
            }
          : raw;
        setInfo({ state: "ready", detail });
      },
      () => {
        if (!canceled) setInfo({ state: "missing" });
      },
    );
    return () => {
      canceled = true;
    };
  }, [id]);
  return info;
}

export function InstalledPluginView({
  plugin,
  page,
}: {
  plugin: PluginSummary;
  page: PluginsPageModel;
}) {
  const {
    t,
    locale,
    busyId,
    queueInstall,
    projects,
    currentProjectPath,
    run,
    refreshPlugins,
    reloadingId,
    reloadPlugin,
    setSettingsPlugin,
    servicesByPlugin,
  } = page;
  const market = useMarketInfo(plugin.id);
  // The row's details sit behind a disclosure in the list; here they are
  // simply shown (the toggle is hidden in CSS).
  const detailsRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    const details = detailsRef.current?.querySelector("details");
    if (details) details.open = true;
  });
  const detail = market.state === "ready" ? market.detail : null;
  const update = plugin.updateAvailable;
  const broken = plugin.status === "error" || plugin.status === "load_error";
  const description = plugin.description || detail?.description;
  const links = [
    { key: "repository", url: detail?.repository },
    { key: "homepage", url: detail?.homepage },
  ].filter((link): link is { key: string; url: string } => !!link.url);

  return (
    <div className="mc-plugin-view">
      <header className="mc-plugin-view-head">
        <span className={cx("plugins-glyph", broken && "is-broken")} aria-hidden>
          {broken ? <IconCircleAlert size={16} /> : <IconPlug size={16} />}
        </span>
        <div className="mc-plugin-view-ident">
          <h1 className="page-title">
            {plugin.name}
            {plugin.source === "dev" ? <span className="plugins-tag">{t("plugins.tagLocal")}</span> : null}
            {plugin.bundled ? <span className="plugins-tag">{t("plugins.tagBundled")}</span> : null}
          </h1>
          <div className="plugins-row-meta">
            <span className="plugins-row-id">{plugin.id}</span>
            <span className="plugins-dot" aria-hidden>
              ·
            </span>
            <span>v{plugin.version}</span>
            {plugin.author || detail?.author ? (
              <>
                <span className="plugins-dot" aria-hidden>
                  ·
                </span>
                <span>{authorParts(plugin.author || detail?.author).name}</span>
              </>
            ) : null}
          </div>
        </div>
      </header>

      <div className="mc-plugin-view-actions">
        <ScopeControl
          target={plugin}
          label={plugin.name}
          compact
          projects={projects}
          currentProjectPath={currentProjectPath}
          onSetEnabled={(enabled) =>
            run(async () => {
              if (enabled) await api.enablePlugin(plugin.id);
              else await api.disablePlugin(plugin.id);
              await refreshPlugins();
            })
          }
          onSetScope={(scope: ActivationScope) =>
            run(async () => {
              await api.setPluginScope(plugin.id, scope);
              await refreshPlugins();
            })
          }
        />
        {update ? (
          <Button
            variant="primary"
            size="sm"
            disabled={busyId === plugin.id}
            onClick={() =>
              queueInstall({
                id: plugin.id,
                name: plugin.name,
                version: update.version,
                permissions: plugin.permissions ?? [],
                newPermissions: update.permissionDiff ?? [],
              })
            }
          >
            {busyId === plugin.id ? t("plugins.updating") : `${t("plugins.updateNow")} v${update.version}`}
          </Button>
        ) : null}
        {plugin.ui?.panel ? (
          <Button variant="secondary" size="sm" onClick={() => void run(() => api.openPluginPanel(plugin.id))}>
            <IconPanel size={14} />
            {t("plugins.openPanel")}
          </Button>
        ) : null}
        {plugin.id === "mc.computer-use" ? (
          // mc-agent (X-PERM-02): the helper's macOS permissions live on one page.
          <Button
            variant="secondary"
            size="sm"
            onClick={() => {
              const store = useAppStore.getState();
              store.setSettingsTab("systemPermissions");
              store.setPage("settings");
            }}
          >
            <IconShield size={14} />
            {t("mcProject.permCheck")}
          </Button>
        ) : null}
        {plugin.enabled && plugin.settings?.length ? (
          <Button variant="secondary" size="sm" onClick={() => setSettingsPlugin(plugin)}>
            <IconSettings size={14} />
            {t("plugins.openSettings")}
          </Button>
        ) : null}
        {plugin.source === "dev" ? (
          <Button
            variant="secondary"
            size="sm"
            disabled={busyId === plugin.id || reloadingId === plugin.id}
            onClick={() => void reloadPlugin(plugin.id)}
          >
            <IconReview size={14} />
            {t("plugins.reload")}
          </Button>
        ) : null}
        <label className="mc-plugin-view-toggle">
          <SettingsToggle
            checked={!!plugin.autoUpdate}
            label={t("mcProject.pluginsAutoUpdate")}
            onChange={() =>
              void run(async () => {
                await api.setPluginAutoUpdate(plugin.id, !plugin.autoUpdate);
                await refreshPlugins();
              })
            }
          />
          <span>{t("mcProject.pluginsAutoUpdate")}</span>
        </label>
        {/* A bundled plugin belongs to the application; the host refuses its
            removal (ADR 0104, ADR 0241). */}
        {plugin.bundled ? null : (
          <Button
            variant="secondary"
            size="sm"
            className="mc-plugin-view-danger"
            disabled={busyId === plugin.id}
            onClick={() =>
              void run(async () => {
                await api.uninstallPlugin(plugin.id);
                await refreshPlugins();
              })
            }
          >
            <IconTrash size={14} />
            {t("plugins.uninstall")}
          </Button>
        )}
      </div>

      {plugin.errorMessage ? <p className="plugins-row-error">{plugin.errorMessage}</p> : null}
      {description ? <p className="mc-plugins-description">{description}</p> : null}

      <section ref={detailsRef} className="mc-plugin-view-section">
        <PluginRowDetails plugin={plugin} services={servicesByPlugin.get(plugin.id)} />
      </section>

      {links.length ? (
        <section className="mc-plugin-view-section">
          <div className="plugins-sheet-links">
            {links.map((link) => (
              <button key={link.key} type="button" className="plugins-sheet-link" onClick={() => openHttpUrl(link.url)}>
                <IconLink size={13} />
                <span className="plugins-sheet-link-label">{t(`plugins.${link.key}`)}</span>
                <span className="plugins-sheet-link-url">{link.url}</span>
              </button>
            ))}
          </div>
        </section>
      ) : null}

      {detail?.safetyNotes ? (
        <section className="plugins-callout">
          <span className="plugins-callout-icon" aria-hidden>
            <IconTriangleAlert size={15} />
          </span>
          <div>
            <h3 className="plugins-callout-title">{t("plugins.safetyNotes")}</h3>
            <p className="plugins-callout-body">{detail.safetyNotes}</p>
          </div>
        </section>
      ) : null}

      {market.state === "loading" ? <p className="mc-plugin-view-muted">{t("plugins.detailLoading")}</p> : null}
      {market.state === "missing" ? <p className="mc-plugin-view-muted">{t("mcProject.pluginsNotInMarket")}</p> : null}

      {detail ? (
        <div className={cx("mc-plugin-view-columns", !detail.readmeMarkdown && "is-single")}>
          {detail.readmeMarkdown ? (
            <section className="mc-plugin-view-section mc-plugin-view-readme">
              <h3 className="plugins-sheet-section-title">{t("plugins.readme")}</h3>
              <div className="plugins-readme">
                <Markdown source={detail.readmeMarkdown} />
              </div>
            </section>
          ) : null}
          {detail.versions?.length ? (
            <section className="mc-plugin-view-section mc-plugin-view-versions">
              <h3 className="plugins-sheet-section-title">{t("plugins.versions")}</h3>
              <ul>
                {detail.versions.map((version) => (
                  <li key={version.version} className={cx(version.version === plugin.version && "is-current")}>
                    <div className="mc-plugin-view-version-top">
                      <strong>v{version.version}</strong>
                      {version.version === plugin.version ? (
                        <span className="plugins-tag">{t("plugins.installedLabel")}</span>
                      ) : versionWithdrawn(version) ? (
                        <span className="plugins-tag">{t("plugins.withdrawn")}</span>
                      ) : null}
                      <span className="mc-plugin-view-muted">{formatDate(version.publishedAt, locale)}</span>
                    </div>
                    {version.changelog ? (
                      <div className="mc-plugin-view-changelog">
                        <Markdown source={version.changelog} />
                      </div>
                    ) : null}
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
