import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import type { BuiltinSkillRecord, McpServerRecord, McpServerStatus, UserSkillRecord } from "@pi-desktop/shared";
import { api } from "../../lib/api";
import { useBlockingOverlay } from "../../lib/blocking-overlay";
import type { SettingsTabId } from "../../lib/settings-search";
import { useAppStore } from "../../stores/app-store";
import { Button, OverlayBackdrop, TooltipButton } from "../../components/ui";
import { IconCheck, IconClose } from "../../components/icons";

/*
  mc-agent: what a context category is made of, after the connector panel of
  desktop agents. The MCP tools, skills and built-in tools rows of the session
  info panel open this dialog: the servers or entries the session loads, their
  state, and a way to the settings page that manages them.
*/

export type CapabilityKind = "mcp" | "skills" | "tools";

type Row = { key: string; name: string; detail?: string; badge?: string; state?: "ok" | "off" | "pending" | "failed" };

/** Where each kind is managed; built-in tools have no settings of their own. */
const SETTINGS_TAB: Partial<Record<CapabilityKind, SettingsTabId>> = { mcp: "mcp", skills: "skills" };

function homeRelative(path: string): string {
  return path.replace(/^\/Users\/[^/]+/, "~").replace(/^\/home\/[^/]+/, "~");
}

async function mcpRows(projectPath: string | null, t: (key: string) => string): Promise<Row[]> {
  const queries = [api.listMcpServers({ level: "global" })];
  if (projectPath) queries.push(api.listMcpServers({ level: "project", projectPath }));
  const results = await Promise.allSettled(queries);
  const servers: McpServerRecord[] = [];
  const statuses = new Map<string, McpServerStatus>();
  for (const result of results) {
    if (result.status !== "fulfilled") continue;
    for (const server of result.value.servers) if (!servers.some((known) => known.id === server.id)) servers.push(server);
    for (const status of result.value.statuses) statuses.set(status.serverId, status);
  }
  return servers.map((server) => {
    const status = statuses.get(server.id);
    const state: Row["state"] = !server.enabled
      ? "off"
      : status?.state === "ready"
        ? "ok"
        : status?.state === "failed"
          ? "failed"
          : "pending";
    return {
      key: server.id,
      name: server.label || server.id,
      detail: [server.transport === "http" ? "HTTP" : "stdio", status?.toolCount ? `${status.toolCount} tools` : ""]
        .filter(Boolean)
        .join(" · "),
      badge: server.level === "project" ? t("mcProject.capabilityProject") : t("mcProject.capabilityUser"),
      state,
    };
  });
}

async function skillRows(names: readonly string[], projectPath: string | null, t: (key: string) => string): Promise<Row[]> {
  const lookups = await Promise.allSettled([
    api.listUserSkills({ level: "global" }),
    projectPath ? api.listUserSkills({ level: "project", projectPath }) : Promise.resolve({ skills: [] as UserSkillRecord[] }),
    api.listBuiltinSkills(),
  ]);
  const user: UserSkillRecord[] = [];
  let builtins: BuiltinSkillRecord[] = [];
  if (lookups[0].status === "fulfilled") user.push(...lookups[0].value.skills);
  if (lookups[1].status === "fulfilled") user.push(...lookups[1].value.skills);
  if (lookups[2].status === "fulfilled") builtins = lookups[2].value.builtins;
  return names.map((name) => {
    const own = user.find((skill) => skill.id === name || skill.name === name);
    const builtin = builtins.find((skill) => skill.id === name || skill.name === name);
    // Plugin skills are namespaced "plugin/skill".
    const badge = own
      ? own.level === "project"
        ? t("mcProject.capabilityProject")
        : t("mcProject.capabilityUser")
      : builtin
        ? t("mcProject.capabilityBuiltin")
        : name.includes("/")
          ? t("mcProject.capabilityPlugin")
          : undefined;
    return { key: name, name, detail: own?.description ?? builtin?.description, badge, state: "ok" as const };
  });
}

export function CapabilityDialog({
  kind,
  names,
  projectPath,
  onClose,
}: {
  kind: CapabilityKind;
  /** The skill or tool names the session loads (from the context breakdown). */
  names: readonly string[];
  projectPath: string | null;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  useBlockingOverlay();
  const [rows, setRows] = useState<Row[] | null>(null);

  useEffect(() => {
    let canceled = false;
    const load =
      kind === "mcp"
        ? mcpRows(projectPath, t)
        : kind === "skills"
          ? skillRows(names, projectPath, t)
          : Promise.resolve(names.map((name) => ({ key: name, name, state: "ok" as const })));
    load.then(
      (loaded) => {
        if (!canceled) setRows(loaded);
      },
      () => {
        if (!canceled) setRows([]);
      },
    );
    return () => {
      canceled = true;
    };
  }, [kind, names, projectPath, t]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const settingsTab = SETTINGS_TAB[kind];
  const manage = () => {
    if (!settingsTab) return;
    const store = useAppStore.getState();
    store.setSettingsTab(settingsTab);
    store.setPage("settings");
    onClose();
  };

  const title = t(
    kind === "mcp" ? "mcProject.capabilityMcpTitle" : kind === "skills" ? "mcProject.capabilitySkillsTitle" : "mcProject.capabilityToolsTitle",
  );
  const stateLabel = (state: Row["state"]) =>
    state === "off"
      ? t("mcProject.capabilityDisabled")
      : state === "failed"
        ? t("mcProject.capabilityFailed")
        : state === "pending"
          ? t("mcProject.capabilityConnecting")
          : t("mcProject.capabilityReady");

  // Rendered at the document root: the session info panel is a positioned,
  // clipped column.
  return createPortal(
    <OverlayBackdrop
      className="overlay mc-capability-overlay"
      role="presentation"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        className="dialog mc-capability-dialog"
        role="dialog"
        aria-modal
        aria-labelledby="mc-capability-title"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="mc-capability-head">
          <div>
            <h2 id="mc-capability-title">{title}</h2>
            {projectPath ? <p className="mc-capability-sub">{homeRelative(projectPath)}</p> : null}
          </div>
          <TooltipButton
            type="button"
            className="mc-import-close"
            tooltip={t("mcProject.capabilityDone")}
            ariaLabel={t("mcProject.capabilityDone")}
            onClick={onClose}
          >
            <IconClose size={16} />
          </TooltipButton>
        </header>
        <div className="mc-capability-body">
          {rows === null ? (
            <div className="mc-import-state">{t("mcProject.importScanning")}</div>
          ) : rows.length === 0 ? (
            <div className="mc-import-state">{t(kind === "mcp" ? "mcProject.capabilityNoMcp" : "mcProject.capabilityNone")}</div>
          ) : (
            <table className="mc-capability-table">
              <thead>
                <tr>
                  <th>{t(kind === "mcp" ? "mcProject.capabilityServer" : "mcProject.capabilityName")}</th>
                  <th>{t("mcProject.capabilityType")}</th>
                  {kind === "mcp" ? <th>{t("mcProject.capabilityStatus")}</th> : null}
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.key}>
                    <td>
                      <div className="mc-capability-name">{row.name}</div>
                      {row.detail ? <div className="mc-capability-detail" title={row.detail}>{row.detail}</div> : null}
                    </td>
                    <td>{row.badge ? <span className="mc-import-source">{row.badge}</span> : "—"}</td>
                    {kind === "mcp" ? (
                      <td>
                        <span className="mc-capability-state" data-state={row.state} title={stateLabel(row.state)}>
                          {row.state === "ok" ? <IconCheck size={14} aria-hidden /> : stateLabel(row.state)}
                        </span>
                      </td>
                    ) : null}
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
        <footer className="mc-capability-foot">
          {settingsTab ? (
            <Button type="button" variant="primary" onClick={manage}>
              {t(kind === "mcp" ? "mcProject.capabilityManageMcp" : "mcProject.capabilityManageSkills")}
            </Button>
          ) : null}
          <Button type="button" variant="secondary" onClick={onClose}>
            {t("mcProject.capabilityDone")}
          </Button>
        </footer>
      </div>
    </OverlayBackdrop>,
    document.body,
  );
}
