import {
  IPC,
  type ExternalMcpCandidate, type ExternalMcpImportPayload,
  type ExternalSkillCandidate, type ExternalSkillImportPayload,
} from "@pi-desktop/shared";
import type { HostProcess } from "../host-process";
import { scanExternalMcp, type McpCandidate } from "../importers/agent-mcp-scan";
import { scanExternalSkills, type SkillCandidate } from "../importers/agent-skill-scan";
import { externalImportScans, importSelections } from "../importers/external-import-selections";
import { mcpCommandLabel, mcpUrlOrigin } from "../mcp-settings-view";
import type { IpcRegistrar } from "./types";

export interface AgentImportIpcDependencies {
  registrar: IpcRegistrar;
  getHost: () => HostProcess | null;
  sendToRenderer: (channel: string, payload?: unknown) => void;
  refreshUserMcp?: (projectPath?: string | null) => Promise<unknown>;
  currentWorkspacePath?: () => string | null;
  scanMcp?: typeof scanExternalMcp;
  scanSkills?: typeof scanExternalSkills;
}

export function mcpImportPreview(candidate: McpCandidate, selectionId: string): ExternalMcpCandidate {
  const { id, source, sourcePath, label, description, transport } = candidate;
  const origin = mcpUrlOrigin(candidate.url);
  const endpoint = origin ? new URL(origin).host : mcpCommandLabel(candidate.command);
  return {
    selectionId, id, source, sourcePath, transport,
    label: label === id ? candidate.rawKey : label,
    displayMeta: description || endpoint || sourcePath,
  };
}

function skillImportPreview(candidate: SkillCandidate, selectionId: string): ExternalSkillCandidate {
  const { source, sourcePath, id, name, shape, description } = candidate;
  return { selectionId, source, sourcePath, id, name, shape, description };
}

export function registerAgentImportIpc({
  registrar, getHost, sendToRenderer, refreshUserMcp, currentWorkspacePath,
  scanMcp = scanExternalMcp, scanSkills = scanExternalSkills,
}: AgentImportIpcDependencies): void {
  const mcp = externalImportScans(scanMcp, mcpImportPreview);
  const skills = externalImportScans(scanSkills, skillImportPreview);

  registrar.handle(IPC.invoke.skillImportScan, skills.scan);
  registrar.handle(IPC.invoke.skillImportRun, async ({ level, projectPath, mode = "copy", items }: ExternalSkillImportPayload) => {
    const host = getHost();
    if (!host) throw new Error("host unavailable");
    const result = await importSelections(items, skills.forDestination(level, projectPath), (candidate) => {
      const { id, name, shape, description, sourcePath, rootDir } = candidate;
      return host.call("skills.import", {
        id, name, shape, description, level, mode, ...(level === "project" ? { projectPath } : {}),
        path: shape === "dir" ? rootDir ?? sourcePath : sourcePath,
      });
    });
    if (result.imported.length) sendToRenderer(IPC.event.pluginChanged, { reason: "skill" });
    return result;
  });

  registrar.handle(IPC.invoke.mcpImportScan, mcp.scan);
  registrar.handle(IPC.invoke.mcpImportRun, async ({ level = "global", projectPath, items }: ExternalMcpImportPayload) => {
    const host = getHost();
    if (!host) throw new Error("host unavailable");
    const result = await importSelections(items, mcp.forDestination(level, projectPath), (candidate) => {
      const { id, label, description, transport, command, args, env, url, headers, disabled } = candidate;
      return host.call("mcp.upsert", {
        createOnly: true,
        server: { id, label, description, transport, command, args, env, url, headers, level,
          ...(level === "project" ? { projectPath } : {}), ...(disabled ? { enabled: false } : {}) },
      });
    });
    if (result.imported.length) {
      // The save is committed. Notify the UI even if rebuilding the active runtime fails.
      try {
        if (refreshUserMcp && currentWorkspacePath) await refreshUserMcp(currentWorkspacePath());
      } catch {
        console.warn("MCP runtime refresh failed after importing servers");
      }
      sendToRenderer(IPC.event.pluginChanged, { reason: "mcp" });
    }
    return result;
  });
}
