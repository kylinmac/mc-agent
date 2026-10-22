import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { ResourceTemplateSummary } from "@pi-desktop/shared";
import { api } from "../../lib/api";
import { Button } from "../../components/ui";
import { openTemplateSettings } from "./TemplateEditor";

/*
  Resource-folder template choice for the project create dialog (R1.4). The
  list comes from <mc-agent home>/templates; if it cannot be read the picker
  keeps the current value, and host-core still validates the name.
*/
export function TemplatePicker({
  value,
  onChange,
  disabled,
}: {
  value: string;
  onChange: (template: string) => void;
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  const [templates, setTemplates] = useState<ResourceTemplateSummary[]>([]);

  useEffect(() => {
    let canceled = false;
    void api
      .listResourceTemplates()
      .then(({ templates: listed }) => {
        // Creative templates set up studio categories, not resource folders.
        if (!canceled) setTemplates(listed.filter((template) => template.target !== "creative"));
      })
      .catch(() => {
        // Without a listing the default template name is still submitted.
      });
    return () => {
      canceled = true;
    };
  }, []);

  const options = templates.some((template) => template.name === value)
    ? templates
    : [{ name: value, path: "", builtin: true, categories: [] }, ...templates];

  return (
    <section className="project-create-dialog-section mc-template-picker" aria-labelledby="mc-template-heading">
      <div className="project-create-dialog-section-head">
        <label id="mc-template-heading" className="project-create-dialog-section-title" htmlFor="mc-template-select">
          {t("mcProject.templateLabel")}
        </label>
        <Button size="sm" variant="ghost" onClick={openTemplateSettings}>
          {t("mcProject.templateEditorOpen")}
        </Button>
      </div>
      <select
        id="mc-template-select"
        className="mc-workbench-select"
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
      >
        {options.map((template) => (
          <option key={template.name} value={template.name}>
            {template.categories.length > 0
              ? `${template.name} · ${template.categories.join(" / ")}`
              : template.name}
          </option>
        ))}
      </select>
      <p className="mc-workbench-muted">{t("mcProject.templateHint")}</p>
    </section>
  );
}
