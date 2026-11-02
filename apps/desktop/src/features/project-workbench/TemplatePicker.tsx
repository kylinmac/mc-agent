import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { ResourceTemplateSummary } from "@pi-desktop/shared";
import { api } from "../../lib/api";
import { SettingsMenuSelect } from "../../components/settings/SettingsMenuSelect";
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

  const selected = options.find((template) => template.name === value);

  // Same shape as the system prompt section below it: a link-style manage
  // action, a full-width menu of names, then what the choice creates. The
  // folders are listed as chips so a long template no longer overflows the
  // control.
  return (
    <section className="project-create-dialog-section mc-template-picker" aria-labelledby="mc-template-heading">
      <div className="project-create-dialog-section-head">
        <h3 id="mc-template-heading" className="project-create-dialog-section-title">
          {t("mcProject.templateLabel")}
        </h3>
        <button type="button" className="mc-project-prompt-manage" disabled={disabled} onClick={openTemplateSettings}>
          {t("mcProject.templateEditorOpen")}
        </button>
      </div>
      <SettingsMenuSelect
        fullWidth
        label={t("mcProject.templateLabel")}
        value={value}
        options={options.map((template) => ({ id: template.name, label: template.name }))}
        disabled={disabled}
        onChange={onChange}
      />
      {selected && selected.categories.length > 0 ? (
        <ul className="mc-template-folders" aria-label={t("mcProject.templatePickerFolders")}>
          {selected.categories.map((category) => (
            <li key={category} className="mc-template-folder">
              {category}
            </li>
          ))}
        </ul>
      ) : null}
      <p className="mc-workbench-muted">{t("mcProject.templateHint")}</p>
    </section>
  );
}
