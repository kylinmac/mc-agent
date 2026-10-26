import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { ProjectTemplateStatus, ResourceTemplateSummary } from "@pi-desktop/shared";
import { api } from "../../lib/api";
import { useAppStore } from "../../stores/app-store";
import { Button } from "../../components/ui";
import { migrationPrompt } from "./migration-prompt";

/*
  R5 template migration: start an Agent-mode session in the resource folder
  with the chosen template's categories and the chosen model. It organizes
  directly in the conversation, where the user follows or stops it; tool
  approvals follow the user's permission mode. No separate executor exists.
*/
export function TemplateMigration({
  groupId,
  resourceFolder,
  currentCategories,
  workspaces,
  onError,
}: {
  groupId: string;
  resourceFolder: string;
  currentCategories: readonly string[];
  workspaces: ReadonlyArray<{ path: string; description?: string; kind?: "workspace" | "reference" }>;
  onError: (message: string) => void;
}) {
  const { t } = useTranslation();
  const providers = useAppStore((state) => state.providers);
  const [templates, setTemplates] = useState<ResourceTemplateSummary[]>([]);
  const [template, setTemplate] = useState("");
  const models = useMemo(
    () =>
      providers
        .filter((provider) => provider.enabled && provider.hasSecret)
        .flatMap((provider) =>
          provider.models.map((model) => ({
            key: `${provider.id}\u0000${model.id}`,
            providerId: provider.id,
            modelId: model.id,
            label: `${provider.name} · ${model.alias || model.id}`,
          })),
        ),
    [providers],
  );
  const [modelKey, setModelKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<ProjectTemplateStatus | null>(null);
  const [notice, setNotice] = useState("");

  useEffect(() => {
    let canceled = false;
    void api
      .projectTemplateStatus(groupId)
      .then(({ status: loaded }) => {
        if (canceled) return;
        setStatus(loaded);
        // Default to the project's own template so organizing follows it.
        if (loaded?.recorded && loaded.templateExists) setTemplate(loaded.recorded.template);
      })
      .catch(() => {
        // Without metadata the panel offers the current structure.
      });
    return () => {
      canceled = true;
    };
  }, [groupId]);

  const adopt = async () => {
    if (!template) return;
    try {
      await api.adoptProjectTemplate(groupId, template);
      const { status: loaded } = await api.projectTemplateStatus(groupId);
      setStatus(loaded);
      setNotice(t("mcProject.templateAdopted", { name: template }));
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error));
    }
  };

  useEffect(() => {
    let canceled = false;
    void api
      .listResourceTemplates()
      .then(({ templates: listed }) => {
        if (!canceled) setTemplates(listed);
      })
      .catch(() => {
        // Without templates the current structure is still offered.
      });
    return () => {
      canceled = true;
    };
  }, []);

  useEffect(() => {
    if (!modelKey && models[0]) setModelKey(models[0].key);
  }, [models, modelKey]);

  const start = async () => {
    const model = models.find((candidate) => candidate.key === modelKey);
    if (!model || busy) return;
    const chosen = templates.find((candidate) => candidate.name === template);
    const prompt = migrationPrompt({
      resourceFolder,
      categories: chosen ? chosen.categories : currentCategories,
      templateName: chosen ? chosen.name : t("mcProject.migrationCurrentStructure"),
      workspaces,
    });
    setBusy(true);
    try {
      const store = useAppStore.getState();
      await store.newSession({ projectPath: resourceFolder });
      await store.configureActiveSession({
        mode: "agent",
        providerId: model.providerId,
        modelId: model.modelId,
        thinkingLevel: "medium",
      });
      store.setPage("chat");
      await store.sendPrompt(prompt);
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mc-workbench-row mc-workbench-migration">
      <span className="mc-workbench-label">{t("mcProject.migrationTitle")}</span>
      <select
        className="mc-workbench-select"
        aria-label={t("mcProject.migrationTemplate")}
        value={template}
        onChange={(event) => setTemplate(event.target.value)}
      >
        <option value="">{t("mcProject.migrationCurrentStructure")}</option>
        {templates.map((candidate) => (
          <option key={candidate.name} value={candidate.name}>
            {candidate.name}
          </option>
        ))}
      </select>
      <select
        className="mc-workbench-select"
        aria-label={t("mcProject.migrationModel")}
        value={modelKey}
        onChange={(event) => setModelKey(event.target.value)}
      >
        {models.map((model) => (
          <option key={model.key} value={model.key}>
            {model.label}
          </option>
        ))}
      </select>
      <Button size="sm" variant="ghost" disabled={!modelKey || busy} onClick={() => void start()}>
        {t("mcProject.migrationStart")}
      </Button>
      <Button size="sm" variant="ghost" disabled={!template || busy} onClick={() => void adopt()}>
        {t("mcProject.templateAdopt")}
      </Button>
      <span className="mc-workbench-muted">
        {status?.recorded
          ? t("mcProject.templateCurrent", {
              name: status.recorded.template,
              version: status.recorded.templateVersion,
            })
          : t("mcProject.templateUnknown")}
        {status?.outdated ? ` · ${t("mcProject.templateOutdated")}` : ""}
        {status?.recorded?.oneOff
          ? ` · ${t("mcProject.templateOneOff")}`
          : status?.recorded && !status.templateExists
            ? ` · ${t("mcProject.templateMissing")}`
            : ""}
        {notice ? ` · ${notice}` : ""}
      </span>
      <span className="mc-workbench-muted">{t("mcProject.migrationHint")}</span>
    </div>
  );
}
