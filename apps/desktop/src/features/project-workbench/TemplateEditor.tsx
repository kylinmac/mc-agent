import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { ResourceTemplateSummary } from "@pi-desktop/shared";
import { api } from "../../lib/api";
import { Button } from "../../components/ui";
import {
  addCategory,
  describeCategory,
  draftFromSummary,
  folderNameError,
  isDirty,
  removeCategory,
  toPayload,
  type CategoryError,
  type TemplateDraftState,
} from "./template-draft";

/*
  In-app template editing (R1.4): categories (first-level folders) and the
  descriptions in template.json. Starter files are edited in Finder. Saving a
  change bumps the template version, so projects created from it show the
  template as changed. host-core validates and applies every change.
*/
export function TemplateEditor({
  onChanged,
  onError,
}: {
  /** Called after a save or delete so other template lists reload. */
  onChanged: () => void;
  onError: (message: string) => void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [templates, setTemplates] = useState<ResourceTemplateSummary[]>([]);
  const [selected, setSelected] = useState("");
  const [draft, setDraft] = useState<TemplateDraftState | null>(null);
  const [newCategory, setNewCategory] = useState("");
  const [categoryError, setCategoryError] = useState<CategoryError | null>(null);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [copyFrom, setCopyFrom] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;

  const apply = (listed: ResourceTemplateSummary[], focus?: string) => {
    setTemplates(listed);
    const name = focus && listed.some((template) => template.name === focus) ? focus : listed[0]?.name ?? "";
    setSelected(name);
    const summary = listed.find((template) => template.name === name);
    setDraft(summary ? draftFromSummary(summary) : null);
  };

  useEffect(() => {
    if (!open) return;
    let canceled = false;
    void api
      .listResourceTemplates()
      .then(({ templates: listed }) => {
        if (!canceled) apply(listed);
      })
      .catch((error: unknown) => onErrorRef.current(messageOf(error)));
    return () => {
      canceled = true;
    };
  }, [open]);

  const saved = templates.find((template) => template.name === selected);

  const run = async (action: () => Promise<{ templates: ResourceTemplateSummary[] }>, focus: string, done: string) => {
    if (busy) return;
    setBusy(true);
    setNotice("");
    try {
      const { templates: listed } = await action();
      apply(listed, focus);
      setNotice(done);
      onChanged();
    } catch (error) {
      onError(messageOf(error));
    } finally {
      setBusy(false);
    }
  };

  const select = (name: string) => {
    setSelected(name);
    const summary = templates.find((template) => template.name === name);
    setDraft(summary ? draftFromSummary(summary) : null);
    setNotice("");
    setCategoryError(null);
  };

  const add = () => {
    if (!draft) return;
    const result = addCategory(draft, newCategory);
    if ("error" in result) {
      setCategoryError(result.error);
      return;
    }
    setDraft(result.draft);
    setNewCategory("");
    setCategoryError(null);
  };

  const create = () => {
    const name = newName.trim();
    if (folderNameError(name)) {
      onError(t("mcProject.templateNameInvalid"));
      return;
    }
    const source = templates.find((template) => template.name === copyFrom);
    const base: TemplateDraftState = source
      ? { ...draftFromSummary(source), name }
      : { name, description: "", categories: [] };
    void run(
      () => api.saveResourceTemplate(toPayload(base, { create: true, copyFrom: source?.name })),
      name,
      t("mcProject.templateCreated", { name }),
    ).then(() => {
      setCreating(false);
      setNewName("");
    });
  };

  if (!open) {
    return (
      <div className="mc-workbench-row">
        <span className="mc-workbench-label">{t("mcProject.templateEditorTitle")}</span>
        <Button size="sm" variant="ghost" onClick={() => setOpen(true)}>
          {t("mcProject.templateEditorOpen")}
        </Button>
      </div>
    );
  }

  return (
    <div className="mc-workbench-template-editor">
      <div className="mc-workbench-row">
        <span className="mc-workbench-label">{t("mcProject.templateEditorTitle")}</span>
        <select
          className="mc-workbench-select"
          aria-label={t("mcProject.templateEditorSelect")}
          value={selected}
          disabled={busy}
          onChange={(event) => select(event.target.value)}
        >
          {templates.map((template) => (
            <option key={template.name} value={template.name}>
              {template.builtin ? `${template.name} · ${t("mcProject.templateBuiltin")}` : template.name}
            </option>
          ))}
        </select>
        {saved ? <span className="mc-workbench-muted">v{saved.version}</span> : null}
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => setCreating((value) => !value)}>
          {t("mcProject.templateNew")}
        </Button>
        <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>
          {t("mcProject.templateEditorClose")}
        </Button>
      </div>

      {creating ? (
        <div className="mc-workbench-row">
          <input
            className="mc-workbench-description mc-workbench-link-input"
            aria-label={t("mcProject.templateNewName")}
            placeholder={t("mcProject.templateNewName")}
            value={newName}
            onChange={(event) => setNewName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") create();
            }}
          />
          <select
            className="mc-workbench-select"
            aria-label={t("mcProject.templateCopyFrom")}
            value={copyFrom}
            onChange={(event) => setCopyFrom(event.target.value)}
          >
            <option value="">{t("mcProject.templateCopyNone")}</option>
            {templates.map((template) => (
              <option key={template.name} value={template.name}>
                {t("mcProject.templateCopyFromName", { name: template.name })}
              </option>
            ))}
          </select>
          <Button size="sm" disabled={busy || !newName.trim()} onClick={create}>
            {t("mcProject.templateCreate")}
          </Button>
        </div>
      ) : null}

      {draft && saved ? (
        <>
          <input
            className="mc-workbench-description"
            aria-label={t("mcProject.templateDescription")}
            placeholder={t("mcProject.templateDescription")}
            value={draft.description}
            onChange={(event) => setDraft({ ...draft, description: event.target.value })}
          />
          <ul className="mc-workbench-workspaces">
            {draft.categories.map((category) => (
              <li key={category.name} className="mc-workbench-workspace">
                <span className="mc-workbench-path" title={category.name}>
                  <span>{category.saved ? category.name : `${category.name} · ${t("mcProject.templateCategoryNew")}`}</span>
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-label={t("mcProject.templateCategoryRemove", { name: category.name })}
                    onClick={() => setDraft(removeCategory(draft, category.name))}
                  >
                    {t("mcProject.templateCategoryRemoveShort")}
                  </Button>
                </span>
                <input
                  className="mc-workbench-description"
                  aria-label={t("mcProject.templateCategoryDescription", { name: category.name })}
                  placeholder={t("mcProject.templateCategoryDescriptionPlaceholder")}
                  value={category.description}
                  onChange={(event) => setDraft(describeCategory(draft, category.name, event.target.value))}
                />
              </li>
            ))}
          </ul>
          <div className="mc-workbench-row">
            <input
              className="mc-workbench-description mc-workbench-link-input"
              aria-label={t("mcProject.templateCategoryAdd")}
              placeholder={t("mcProject.templateCategoryAddPlaceholder")}
              value={newCategory}
              onChange={(event) => {
                setNewCategory(event.target.value);
                setCategoryError(null);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter") add();
              }}
            />
            <Button size="sm" variant="ghost" disabled={!newCategory.trim()} onClick={add}>
              {t("mcProject.templateCategoryAdd")}
            </Button>
            {categoryError ? (
              <span className="mc-workbench-attention">{t(`mcProject.templateCategoryError_${categoryError}`)}</span>
            ) : null}
          </div>
          <div className="mc-workbench-row">
            <Button
              size="sm"
              disabled={busy || !isDirty(draft, saved)}
              onClick={() =>
                void run(
                  () => api.saveResourceTemplate(toPayload(draft)),
                  saved.name,
                  t("mcProject.templateSaved", { name: saved.name }),
                )
              }
            >
              {t("mcProject.templateSave")}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() => void api.revealResourceTemplate(saved.name).catch((error: unknown) => onError(messageOf(error)))}
            >
              {t("mcProject.templateReveal")}
            </Button>
            {!saved.builtin ? (
              <Button
                size="sm"
                variant="ghost"
                disabled={busy}
                onClick={() => {
                  if (!window.confirm(t("mcProject.templateDeleteConfirm", { name: saved.name }))) return;
                  void run(
                    () => api.deleteResourceTemplate(saved.name),
                    "",
                    t("mcProject.templateDeleted", { name: saved.name }),
                  );
                }}
              >
                {t("mcProject.templateDelete")}
              </Button>
            ) : null}
            {notice ? <span className="mc-workbench-muted">{notice}</span> : null}
          </div>
          <span className="mc-workbench-muted">{t("mcProject.templateEditorHint")}</span>
        </>
      ) : null}
    </div>
  );
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
