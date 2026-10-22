import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { SystemPromptConfig } from "@pi-desktop/shared";
import { api } from "../lib/api";
import { useAppStore } from "../stores/app-store";
import { SettingsMenuSelect } from "./settings/SettingsMenuSelect";

/** The saved system prompt configuration; null until it has loaded or if it cannot. */
export function usePromptConfig(): SystemPromptConfig | null {
  const [config, setConfig] = useState<SystemPromptConfig | null>(null);
  useEffect(() => {
    let canceled = false;
    api.getSystemPromptConfig().then(
      ({ config: loaded }) => {
        if (!canceled) setConfig(loaded);
      },
      () => undefined,
    );
    return () => {
      canceled = true;
    };
  }, []);
  return config;
}

/** The system prompt template section of the project create and edit dialogs. */
export function ProjectPromptPicker({
  config,
  value,
  onChange,
  onLeave,
  disabled,
}: {
  config: SystemPromptConfig | null;
  value: string;
  onChange: (templateId: string) => void;
  /** Closes the dialog before Settings opens. */
  onLeave: () => void;
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  const setPage = useAppStore((state) => state.setPage);
  const setSettingsTab = useAppStore((state) => state.setSettingsTab);
  const templates = config?.templates ?? [];
  const fallback = config?.globalTemplateId
    ? templates.find((template) => template.id === config.globalTemplateId)?.name
    : undefined;
  const options = [
    { id: "", label: t("mcProject.projectPromptDefault") },
    ...templates.map((template) => ({ id: template.id, label: template.name || t("mcProject.promptUntitled") })),
  ];
  const manage = () => {
    onLeave();
    setSettingsTab("systemPrompts");
    setPage("settings");
  };
  return (
    <section className="project-create-dialog-section mc-project-prompt" aria-labelledby="mc-project-prompt-heading">
      <div className="project-create-dialog-section-head">
        <h3 id="mc-project-prompt-heading" className="project-create-dialog-section-title">
          {t("mcProject.projectPromptLabel")}
        </h3>
        <button type="button" className="mc-project-prompt-manage" disabled={disabled} onClick={manage}>
          {t("mcProject.projectPromptManage")}
        </button>
      </div>
      {templates.length > 0 ? (
        <SettingsMenuSelect
          fullWidth
          label={t("mcProject.projectPromptLabel")}
          value={templates.some((template) => template.id === value) ? value : ""}
          options={options}
          disabled={disabled || !config}
          onChange={onChange}
        />
      ) : null}
      <p className="mc-workbench-muted">
        {!config
          ? t("mcProject.projectPromptLoading")
          : templates.length === 0
            ? t("mcProject.projectPromptNoTemplates")
            : value
              ? t("mcProject.projectPromptChosenHint")
              : fallback
                ? t("mcProject.projectPromptDefaultHintGlobal", { name: fallback })
                : t("mcProject.projectPromptDefaultHint")}
      </p>
    </section>
  );
}
