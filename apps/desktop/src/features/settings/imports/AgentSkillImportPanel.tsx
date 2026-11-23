import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { ExternalSkillCandidate, ExternalSkillSourceKind } from "../../../lib/api";
import { api } from "../../../lib/api";
import { ImportOption } from "../import-workbench";
import { ExternalAgentImportPanel, type ExternalAgentImportDestination } from "./ExternalAgentImportPanel";

const SKILL_SOURCE_KEY: Record<ExternalSkillSourceKind, string> = {
  "claude-user": "settings.importAgentScanSourceClaudeUser",
  "claude-project": "settings.importAgentScanSourceClaudeProject",
  "pi-user": "settings.importAgentScanSourcePiUser",
  "pi-project": "settings.importAgentScanSourcePiProject",
};

export function AgentSkillImportPanel({ level, projectPath, onImported }: ExternalAgentImportDestination) {
  const { t } = useTranslation();
  const [mode, setMode] = useState<"copy" | "link">("copy");
  return (
    <ExternalAgentImportPanel<ExternalSkillSourceKind, ExternalSkillCandidate>
      description={t("settings.importAgentSkillsDesc")}
      foundKey="settings.importAgentScanFoundSkills"
      groupPrefix="import-skill-group"
      sourceNames={SKILL_SOURCE_KEY}
      row={(candidate) => ({
        title: candidate.name || candidate.id, meta: candidate.description || candidate.sourcePath,
        badge: candidate.shape === "dir" ? t("settings.importAgentScanShapeDir") : t("settings.importAgentScanShapeFile"),
      })}
      scan={() => api.scanExternalSkills(projectPath ? { projectPath } : undefined)}
      run={(items) => api.runExternalSkillsImport({
        level, ...(level === "project" && projectPath ? { projectPath } : {}), mode, items,
      })}
      onImported={onImported}
      options={
        <ImportOption
          label={t("settings.importAgentScanMode")} value={mode}
          onChange={(id) => setMode(id === "link" ? "link" : "copy")}
          hint={t("settings.importAgentScanModeHint")}
          options={[
            { id: "copy", label: t("settings.importAgentScanModeCopy") },
            { id: "link", label: t("settings.importAgentScanModeLink") },
          ]}
        />
      }
    />
  );
}
