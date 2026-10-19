import { useTranslation } from "react-i18next";
import { useAppStore } from "../../stores/app-store";
import { TooltipButton } from "../../components/ui";
import { IconDiff, IconFolder, IconGlobe, IconTerminal } from "../../components/icons";
import { pluginWorkPanelTab, toolWorkPanelTab } from "../../lib/work-panel-tabs";
import { isRemoteSession } from "../../lib/remote-session-safety";
import { browserTab, FILES_VIEW, terminalTab } from "./tool-tabs";

/*
  mc-agent: the work panel's common tools as one-click icons in its header,
  after Claude Code and Codex (MC-ADR-0005). Terminal and browser open a new
  tab each click; changes and files switch to their single tab. The "+"
  launcher stays for plugin views.
*/
export function WorkPanelQuickTools() {
  const { t } = useTranslation();
  const openWorkPanelTab = useAppStore((s) => s.openWorkPanelTab);
  const activeSessionId = useAppStore((s) => s.activeSessionId);
  const sessions = useAppStore((s) => s.sessions);
  const workspace = useAppStore((s) => s.workspace);
  const pluginViews = useAppStore((s) => s.pluginViews);
  const session = sessions.find((candidate) => candidate.id === activeSessionId);
  // The terminal starts where the conversation does (its start folder).
  const cwd = session && !isRemoteSession(session) ? session.projectPath : workspace?.remote ? undefined : workspace?.path;
  const hasView = (pluginId: string, viewId: string) =>
    pluginViews.some((view) => view.pluginId === pluginId && view.viewId === viewId);

  return (
    <div className="mc-quick-tools" role="group" aria-label={t("mcProject.quickToolsLabel")}>
      <TooltipButton
        type="button"
        className="work-panel-new-tab"
        tooltip={cwd ? t("mcProject.quickToolTerminal") : t("mcProject.quickToolTerminalUnavailable")}
        ariaLabel={t("mcProject.quickToolTerminal")}
        disabled={!cwd}
        onClick={() => cwd && openWorkPanelTab(terminalTab(cwd))}
      >
        <IconTerminal size={15} />
      </TooltipButton>
      <TooltipButton
        type="button"
        className="work-panel-new-tab"
        tooltip={t("panel.tabs.review")}
        ariaLabel={t("panel.tabs.review")}
        onClick={() => openWorkPanelTab(toolWorkPanelTab("review"))}
      >
        <IconDiff size={15} />
      </TooltipButton>
      {hasView("pi.browser", "browser") ? (
        <TooltipButton
          type="button"
          className="work-panel-new-tab"
          tooltip={t("mcProject.quickToolBrowser")}
          ariaLabel={t("mcProject.quickToolBrowser")}
          onClick={() => openWorkPanelTab(browserTab())}
        >
          <IconGlobe size={15} />
        </TooltipButton>
      ) : null}
      {hasView(FILES_VIEW.pluginId, FILES_VIEW.viewId) ? (
        <TooltipButton
          type="button"
          className="work-panel-new-tab"
          tooltip={t("mcProject.quickToolFiles")}
          ariaLabel={t("mcProject.quickToolFiles")}
          onClick={() => openWorkPanelTab(pluginWorkPanelTab(FILES_VIEW.pluginId, FILES_VIEW.viewId))}
        >
          <IconFolder size={15} />
        </TooltipButton>
      ) : null}
    </div>
  );
}
