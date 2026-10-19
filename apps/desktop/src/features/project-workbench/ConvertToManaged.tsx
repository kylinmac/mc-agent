import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { ResourceTemplateSummary } from "@pi-desktop/shared";
import { api } from "../../lib/api";
import { Button } from "../../components/ui";

/*
  A simple project (no resource folder) can become a managed one on request
  (MC-ADR-0003 decision 12): pick a template, and host-core creates the
  resource folder and puts it first. Nothing happens without this click.
*/
export function ConvertToManaged({
  groupId,
  onConverted,
  onError,
}: {
  groupId: string;
  onConverted: (primaryPath: string) => void;
  onError: (message: string) => void;
}) {
  const { t } = useTranslation();
  const [templates, setTemplates] = useState<ResourceTemplateSummary[]>([]);
  const [template, setTemplate] = useState("software");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let canceled = false;
    void api
      .listResourceTemplates()
      .then(({ templates: listed }) => {
        if (!canceled) setTemplates(listed);
      })
      .catch(() => {
        // The default template name is still submitted; host-core validates it.
      });
    return () => {
      canceled = true;
    };
  }, []);

  const convert = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const { group } = await api.ensureProjectResources(groupId, template);
      onConverted(group.primaryPath);
    } catch (error) {
      onError(t("mcProject.resourcesError", { message: error instanceof Error ? error.message : String(error) }));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <span className="mc-workbench-tag">{t("mcProject.kindSimple")}</span>
      <select
        className="mc-workbench-select"
        aria-label={t("mcProject.templateLabel")}
        value={template}
        disabled={busy}
        onChange={(event) => setTemplate(event.target.value)}
      >
        {(templates.some((candidate) => candidate.name === template)
          ? templates
          : [{ name: template }, ...templates]
        ).map((candidate) => (
          <option key={candidate.name} value={candidate.name}>
            {candidate.name}
          </option>
        ))}
      </select>
      <Button size="sm" variant="ghost" disabled={busy} onClick={() => void convert()}>
        {busy ? t("mcProject.resourcesPreparing") : t("mcProject.convertToManaged")}
      </Button>
    </>
  );
}
