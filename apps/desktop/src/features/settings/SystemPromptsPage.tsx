import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { ProjectGroupRecord, SystemPromptConfig, SystemPromptTemplate } from "@pi-desktop/shared";
import { api } from "../../lib/api";
import { useAppStore } from "../../stores/app-store";
import { Button, Input } from "../../components/ui";
import { IconPlus, IconTrash } from "../../components/icons";
import { SettingsMenuSelect } from "../../components/settings/SettingsMenuSelect";
import { SettingsCard } from "./primitives";

/*
  mc-agent: system prompt templates and where they apply (MC-ADR-0010).
  A template is a persona (replacing the default one; empty keeps it) plus
  rules added after the base prompt. One template applies to a conversation,
  whole: its project's, else its model's, else the global default; with none,
  SYSTEM.md / APPEND_SYSTEM.md and the built-in prompt apply as before.
*/

const EMPTY: SystemPromptConfig = { templates: [], globalTemplateId: null, modelRules: [], projectRules: [] };
const NONE = "";

function newTemplateId(): string {
  return `t-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

function sameConfig(a: SystemPromptConfig, b: SystemPromptConfig): boolean {
  const strip = ({ updatedAt: _updated, ...rest }: SystemPromptConfig) => rest;
  return JSON.stringify(strip(a)) === JSON.stringify(strip(b));
}

export function SystemPromptsPage() {
  const { t } = useTranslation();
  const showToast = useAppStore((state) => state.showToast);
  const [saved, setSaved] = useState<SystemPromptConfig | null>(null);
  const [draft, setDraft] = useState<SystemPromptConfig>(EMPTY);
  const [editing, setEditing] = useState<string | null>(null);
  const [groups, setGroups] = useState<ProjectGroupRecord[]>([]);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let canceled = false;
    api.getSystemPromptConfig().then(
      ({ config }) => {
        if (canceled) return;
        const loaded = { ...EMPTY, ...config };
        setSaved(loaded);
        setDraft(loaded);
      },
      (error: unknown) => showToast(error instanceof Error ? error.message : String(error), { variant: "error" }),
    );
    api.listProjectGroups().then(
      ({ groups: listed }) => {
        if (!canceled) setGroups(listed.filter((group) => !group.remote));
      },
      () => undefined,
    );
    return () => {
      canceled = true;
    };
  }, [showToast]);

  const dirty = saved !== null && !sameConfig(saved, draft);
  const templateOptions = useMemo(
    () => draft.templates.map((template) => ({ id: template.id, label: template.name || t("mcProject.promptUntitled") })),
    [draft.templates, t],
  );
  const withNone = [{ id: NONE, label: t("mcProject.promptNone") }, ...templateOptions];
  const projectOptions = groups.map((group) => ({ id: group.primaryPath, label: `${group.name} · ${group.primaryPath}` }));

  const update = (change: (current: SystemPromptConfig) => SystemPromptConfig) => setDraft((current) => change(current));
  const updateTemplate = (id: string, patch: Partial<SystemPromptTemplate>) =>
    update((current) => ({
      ...current,
      templates: current.templates.map((template) => (template.id === id ? { ...template, ...patch } : template)),
    }));

  const addTemplate = () => {
    const id = newTemplateId();
    update((current) => ({
      ...current,
      templates: [...current.templates, { id, name: t("mcProject.promptNewName", { n: current.templates.length + 1 }), persona: "", append: "" }],
    }));
    setEditing(id);
  };

  // A removed template takes its rules with it.
  const removeTemplate = (id: string) =>
    update((current) => ({
      ...current,
      templates: current.templates.filter((template) => template.id !== id),
      globalTemplateId: current.globalTemplateId === id ? null : current.globalTemplateId,
      modelRules: current.modelRules.filter((rule) => rule.templateId !== id),
      projectRules: current.projectRules.filter((rule) => rule.templateId !== id),
    }));

  const save = async () => {
    setSaving(true);
    try {
      const { config } = await api.setSystemPromptConfig(draft);
      const stored = { ...EMPTY, ...config };
      setSaved(stored);
      setDraft(stored);
      showToast(t("mcProject.promptSaved"), { variant: "success" });
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), { variant: "error" });
    } finally {
      setSaving(false);
    }
  };

  const firstTemplate = draft.templates[0]?.id;

  const ruleTemplateSelect = (value: string, onChange: (templateId: string) => void) => (
    <SettingsMenuSelect label={t("mcProject.promptTemplate")} value={value} options={templateOptions} onChange={onChange} />
  );
  const removeButton = (label: string, onClick: () => void) => (
    <button type="button" className="mc-prompts-icon" aria-label={label} title={label} onClick={onClick}>
      <IconTrash size={14} aria-hidden />
    </button>
  );

  return (
    <div className="settings-stack mc-prompts">
      <p className="mc-prompts-intro">{t("mcProject.promptRulesDesc")}</p>

      <SettingsCard
        title={t("mcProject.promptTemplates")}
        description={t("mcProject.promptTemplatesDesc")}
        action={
          <Button variant="secondary" size="sm" onClick={addTemplate}>
            <IconPlus size={13} aria-hidden /> {t("mcProject.promptAddTemplate")}
          </Button>
        }
      >
        {draft.templates.length === 0 ? (
          <div className="settings-row">
            <div className="settings-row-copy mc-prompts-muted">{t("mcProject.promptNoTemplates")}</div>
          </div>
        ) : (
          draft.templates.map((template) => {
            const open = editing === template.id;
            return (
              <div key={template.id} className="settings-row mc-prompts-template" data-open={open ? "true" : undefined}>
                <div className="mc-prompts-template-row">
                  <button
                    type="button"
                    className="settings-row-copy mc-prompts-template-toggle"
                    aria-expanded={open}
                    onClick={() => setEditing(open ? null : template.id)}
                  >
                    <span className="settings-row-title">{template.name || t("mcProject.promptUntitled")}</span>
                    <span className="settings-row-detail">
                      {[
                        template.persona.trim() ? t("mcProject.promptHasPersona") : t("mcProject.promptDefaultPersona"),
                        template.append.trim()
                          ? t("mcProject.promptHasAppend", { chars: template.append.trim().length })
                          : "",
                      ]
                        .filter(Boolean)
                        .join(" · ")}
                    </span>
                  </button>
                  <Button variant="ghost" size="sm" onClick={() => setEditing(open ? null : template.id)}>
                    {open ? t("mcProject.promptCollapse") : t("mcProject.promptEdit")}
                  </Button>
                  {removeButton(t("mcProject.promptRemoveTemplate", { name: template.name }), () => removeTemplate(template.id))}
                </div>
                {open ? (
                  <div className="mc-prompts-editor">
                    <label className="mc-prompts-field">
                      <span>{t("mcProject.promptName")}</span>
                      <Input
                        value={template.name}
                        maxLength={80}
                        onChange={(event) => updateTemplate(template.id, { name: event.target.value })}
                      />
                    </label>
                    <label className="mc-prompts-field">
                      <span>{t("mcProject.promptPersona")}</span>
                      <textarea
                        className="field-textarea mc-prompts-textarea"
                        value={template.persona}
                        placeholder={t("mcProject.promptPersonaPlaceholder")}
                        spellCheck={false}
                        onChange={(event) => updateTemplate(template.id, { persona: event.target.value })}
                      />
                    </label>
                    <label className="mc-prompts-field">
                      <span>{t("mcProject.promptAppend")}</span>
                      <textarea
                        className="field-textarea mc-prompts-textarea"
                        value={template.append}
                        placeholder={t("mcProject.promptAppendPlaceholder")}
                        spellCheck={false}
                        onChange={(event) => updateTemplate(template.id, { append: event.target.value })}
                      />
                    </label>
                  </div>
                ) : null}
              </div>
            );
          })
        )}
      </SettingsCard>

      <SettingsCard
        title={t("mcProject.promptByProject")}
        action={
          <Button
            variant="secondary"
            size="sm"
            disabled={!firstTemplate || projectOptions.length === 0}
            onClick={() =>
              update((current) => {
                const used = new Set(current.projectRules.map((rule) => rule.path));
                const path = projectOptions.find((option) => !used.has(option.id))?.id;
                return path && firstTemplate
                  ? { ...current, projectRules: [...current.projectRules, { path, templateId: firstTemplate }] }
                  : current;
              })
            }
          >
            <IconPlus size={13} aria-hidden /> {t("mcProject.promptAddProjectRule")}
          </Button>
        }
      >
        {draft.projectRules.length === 0 ? (
          <div className="settings-row">
            <div className="settings-row-copy mc-prompts-muted">
              {firstTemplate ? t("mcProject.promptNoProjectRules") : t("mcProject.promptNeedTemplate")}
            </div>
          </div>
        ) : (
          draft.projectRules.map((rule, index) => (
            <div key={`p-${index}`} className="settings-row mc-prompts-rule">
              <div className="settings-row-copy">
                <SettingsMenuSelect
                  fullWidth
                  label={t("mcProject.promptProject")}
                  value={rule.path}
                  options={
                    projectOptions.some((option) => option.id === rule.path)
                      ? projectOptions
                      : [{ id: rule.path, label: rule.path }, ...projectOptions]
                  }
                  onChange={(path) =>
                    update((current) => ({
                      ...current,
                      projectRules: current.projectRules.map((item, at) => (at === index ? { ...item, path } : item)),
                    }))
                  }
                />
              </div>
              <span className="mc-prompts-arrow" aria-hidden>→</span>
              {ruleTemplateSelect(rule.templateId, (templateId) =>
                update((current) => ({
                  ...current,
                  projectRules: current.projectRules.map((item, at) => (at === index ? { ...item, templateId } : item)),
                })),
              )}
              {removeButton(t("mcProject.promptRemoveRule"), () =>
                update((current) => ({ ...current, projectRules: current.projectRules.filter((_, at) => at !== index) })),
              )}
            </div>
          ))
        )}
      </SettingsCard>

      <SettingsCard
        title={t("mcProject.promptByModel")}
        description={t("mcProject.promptModelHint")}
        action={
          <Button
            variant="secondary"
            size="sm"
            disabled={!firstTemplate}
            onClick={() =>
              update((current) =>
                firstTemplate
                  ? { ...current, modelRules: [...current.modelRules, { pattern: "", templateId: firstTemplate }] }
                  : current,
              )
            }
          >
            <IconPlus size={13} aria-hidden /> {t("mcProject.promptAddModelRule")}
          </Button>
        }
      >
        {draft.modelRules.length === 0 ? (
          <div className="settings-row">
            <div className="settings-row-copy mc-prompts-muted">
              {firstTemplate ? t("mcProject.promptNoModelRules") : t("mcProject.promptNeedTemplate")}
            </div>
          </div>
        ) : (
          draft.modelRules.map((rule, index) => (
            <div key={`m-${index}`} className="settings-row mc-prompts-rule">
              <div className="settings-row-copy">
                <Input
                  value={rule.pattern}
                  placeholder="claude-*"
                  aria-label={t("mcProject.promptModelPattern")}
                  onChange={(event) =>
                    update((current) => ({
                      ...current,
                      modelRules: current.modelRules.map((item, at) =>
                        at === index ? { ...item, pattern: event.target.value } : item,
                      ),
                    }))
                  }
                />
              </div>
              <span className="mc-prompts-arrow" aria-hidden>→</span>
              {ruleTemplateSelect(rule.templateId, (templateId) =>
                update((current) => ({
                  ...current,
                  modelRules: current.modelRules.map((item, at) => (at === index ? { ...item, templateId } : item)),
                })),
              )}
              {removeButton(t("mcProject.promptRemoveRule"), () =>
                update((current) => ({ ...current, modelRules: current.modelRules.filter((_, at) => at !== index) })),
              )}
            </div>
          ))
        )}
      </SettingsCard>

      <SettingsCard title={t("mcProject.promptGlobal")}>
        <div className="settings-row">
          <div className="settings-row-copy">
            <div className="settings-row-title">{t("mcProject.promptGlobal")}</div>
            <div className="settings-row-detail">{t("mcProject.promptGlobalDesc")}</div>
          </div>
          <div className="settings-row-control">
            <SettingsMenuSelect
              label={t("mcProject.promptGlobal")}
              value={draft.globalTemplateId ?? NONE}
              options={withNone}
              onChange={(id) => update((current) => ({ ...current, globalTemplateId: id || null }))}
            />
          </div>
        </div>
      </SettingsCard>

      <div className="mc-prompts-actions">
        <Button variant="secondary" disabled={!dirty || saving} onClick={() => saved && setDraft(saved)}>
          {t("mcProject.promptDiscard")}
        </Button>
        <Button variant="primary" disabled={!dirty || saving} onClick={() => void save()}>
          {saving ? t("settings.saving") : t("mcProject.promptSave")}
        </Button>
      </div>
    </div>
  );
}
