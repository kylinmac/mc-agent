import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { ResourceTemplateSummary } from "@pi-desktop/shared";
import { api } from "../../lib/api";
import { useAppStore } from "../../stores/app-store";
import { Button } from "../../components/ui";
import { migrationPrompt } from "./migration-prompt";

/*
  R5 template migration: start a Plan-mode session in the resource folder with
  the chosen template's categories and the chosen model. The model proposes a
  copy/move plan and nothing changes until the user approves it through the
  upstream Plan flow; no separate executor exists.
*/
export function TemplateMigration({
  resourceFolder,
  currentCategories,
  workspaces,
  onError,
}: {
  resourceFolder: string;
  currentCategories: readonly string[];
  workspaces: ReadonlyArray<{ path: string; description?: string }>;
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
        mode: "plan",
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
      <span className="mc-workbench-muted">{t("mcProject.migrationHint")}</span>
    </div>
  );
}
