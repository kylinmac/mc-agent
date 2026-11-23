import { useTranslation } from "react-i18next";
import type { ExternalMcpCandidate, ExternalMcpSourceKind } from "../../../lib/api";
import { api } from "../../../lib/api";
import { ExternalAgentImportPanel, type ExternalAgentImportDestination } from "./ExternalAgentImportPanel";

const MCP_SOURCE_KEY: Record<ExternalMcpSourceKind, string> = {
  "claude-desktop": "settings.importAgentScanSourceClaudeDesktop",
  "claude-code": "settings.importAgentScanSourceClaudeCode",
  "cursor-global": "settings.importAgentScanSourceCursorGlobal",
  "cursor-project": "settings.importAgentScanSourceCursorProject",
  codex: "settings.importAgentScanSourceCodex",
  opencode: "settings.importAgentScanSourceOpenCode",
  "chatgpt-desktop": "settings.importAgentScanSourceChatgpt",
};

export function AgentMcpImportPanel({ level, projectPath, onImported }: ExternalAgentImportDestination) {
  const { t } = useTranslation();
  return (
    <ExternalAgentImportPanel<ExternalMcpSourceKind, ExternalMcpCandidate>
      description={t("settings.importAgentMcpDesc")}
      foundKey="settings.importAgentScanFoundMcp"
      groupPrefix="import-mcp-group"
      sourceNames={MCP_SOURCE_KEY}
      row={(candidate) => ({
        title: candidate.label || candidate.id, meta: candidate.displayMeta,
        badge: candidate.transport === "http" ? t("settings.importAgentScanTransportHttp") : t("settings.importAgentScanTransportStdio"),
      })}
      scan={() => api.scanExternalMcp(projectPath ? { projectPath } : undefined)}
      run={(items) => api.runExternalMcpImport({
        level, ...(level === "project" && projectPath ? { projectPath } : {}), items,
      })}
      onImported={onImported}
    />
  );
}
