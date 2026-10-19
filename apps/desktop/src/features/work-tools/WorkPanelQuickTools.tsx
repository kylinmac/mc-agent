import type { ComponentType } from "react";
import { useTranslation } from "react-i18next";
import { useAppStore } from "../../stores/app-store";
import { TooltipButton } from "../../components/ui";
import type { IconProps } from "../../components/icons";
import { IconDiff, IconFolder, IconGlobe, IconTerminal } from "../../components/icons";
import { pluginWorkPanelTab, toolWorkPanelTab } from "../../lib/work-panel-tabs";
import { isRemoteSession } from "../../lib/remote-session-safety";
import { browserTab, FILES_VIEW, terminalTab } from "./tool-tabs";
import { paneOf, type PaneId } from "./work-panes-model";
import { expandPane } from "./pane-layout";

/** The folder a new terminal starts in: the conversation's start folder. */
export function useTerminalCwd(): string | undefined {
  const session = useAppStore((s) => s.sessions.find((candidate) => candidate.id === s.activeSessionId));
  const workspace = useAppStore((s) => s.workspace);
  if (session) return isRemoteSession(session) ? undefined : session.projectPath;
  return workspace?.remote ? undefined : workspace?.path;
}

/*
  mc-agent: the work panel's tools as one-click icons in its header, after
  Claude Code and Codex (MC-ADR-0005). Each tool has its own pane below;
  an icon is lit while its pane is open. Terminal and browser add a tab to
  their pane each click; files and changes open (or expand) their pane.
*/
export function WorkPanelQuickTools() {
  const { t } = useTranslation();
  const openWorkPanelTab = useAppStore((s) => s.openWorkPanelTab);
  const tabs = useAppStore((s) => s.workPanelTabs);
  const pluginViews = useAppStore((s) => s.pluginViews);
  const cwd = useTerminalCwd();
  const openPanes = new Set(tabs.map(paneOf));
  const hasView = (pluginId: string, viewId: string) =>
    pluginViews.some((view) => view.pluginId === pluginId && view.viewId === viewId);

  const tools: Array<{
    pane: PaneId;
    icon: ComponentType<IconProps>;
    label: string;
    tooltip?: string;
    disabled?: boolean;
    open: () => void;
  }> = [
    {
      pane: "terminal",
      icon: IconTerminal,
      label: t("mcProject.quickToolTerminal"),
      tooltip: cwd ? undefined : t("mcProject.quickToolTerminalUnavailable"),
      disabled: !cwd,
      open: () => cwd && openWorkPanelTab(terminalTab(cwd)),
    },
    ...(hasView("pi.browser", "browser")
      ? [{ pane: "browser" as const, icon: IconGlobe, label: t("mcProject.quickToolBrowser"), open: () => openWorkPanelTab(browserTab()) }]
      : []),
    ...(hasView(FILES_VIEW.pluginId, FILES_VIEW.viewId)
      ? [{
          pane: "files" as const,
          icon: IconFolder,
          label: t("mcProject.quickToolFiles"),
          open: () => openWorkPanelTab(pluginWorkPanelTab(FILES_VIEW.pluginId, FILES_VIEW.viewId)),
        }]
      : []),
    {
      pane: "review",
      icon: IconDiff,
      label: t("panel.tabs.review"),
      open: () => openWorkPanelTab(toolWorkPanelTab("review")),
    },
  ];

  return (
    <div className="mc-quick-tools no-drag" role="group" aria-label={t("mcProject.quickToolsLabel")}>
      {tools.map((tool) => (
        <TooltipButton
          key={tool.pane}
          type="button"
          className="work-panel-new-tab mc-quick-tool"
          tooltip={tool.tooltip ?? tool.label}
          ariaLabel={tool.label}
          aria-pressed={openPanes.has(tool.pane)}
          disabled={tool.disabled}
          onClick={() => {
            tool.open();
            expandPane(tool.pane);
          }}
        >
          <tool.icon size={15} />
        </TooltipButton>
      ))}
    </div>
  );
}
