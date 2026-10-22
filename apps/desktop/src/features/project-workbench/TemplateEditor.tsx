import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { ResourceTemplateSummary, ResourceTemplateTarget } from "@pi-desktop/shared";
import { api } from "../../lib/api";
import { useAppStore } from "../../stores/app-store";
import { Button } from "../../components/ui";
import { IconClose, IconFolder, IconPlus } from "../../components/icons";
import {
  addFolder,
  describeFolder,
  draftFromSummary,
  folderDepth,
  folderName,
  folderNameError,
  isDirty,
  MAX_FOLDER_DEPTH,
  removeFolder,
  toPayload,
  type FolderError,
  type TemplateDraftState,
} from "./template-draft";

/*
  In-app template editing (R1.4), on Settings → Project templates: one card
  per template, its folders as a tree with a description on every level, and
  "New template" at the top. Starter files are edited in Finder. Saving a
  change bumps the template version, so projects created from it show the
  template as changed. host-core validates and applies every change.
*/

type Listed = { templates: ResourceTemplateSummary[] };

export function TemplateManager({ onError }: { onError: (message: string) => void }) {
  const { t } = useTranslation();
  const [templates, setTemplates] = useState<ResourceTemplateSummary[]>([]);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [copyFrom, setCopyFrom] = useState("");
  const [newTarget, setNewTarget] = useState<ResourceTemplateTarget>("resources");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;

  useEffect(() => {
    let canceled = false;
    void api
      .listResourceTemplates()
      .then(({ templates: listed }) => {
        if (!canceled) setTemplates(listed);
      })
      .catch((error: unknown) => onErrorRef.current(messageOf(error)));
    return () => {
      canceled = true;
    };
  }, []);

  const run = async (action: () => Promise<Listed>, done: string): Promise<boolean> => {
    if (busy) return false;
    setBusy(true);
    setNotice("");
    try {
      const { templates: listed } = await action();
      setTemplates(listed);
      setNotice(done);
      return true;
    } catch (error) {
      onError(messageOf(error));
      return false;
    } finally {
      setBusy(false);
    }
  };

  const create = () => {
    const name = newName.trim();
    if (folderNameError(name)) {
      onError(t("mcProject.templateNameInvalid"));
      return;
    }
    const source = templates.find((template) => template.name === copyFrom);
    const base: TemplateDraftState = source
      ? { ...draftFromSummary(source), name, target: newTarget }
      : { name, description: "", folders: [], target: newTarget };
    void run(
      () => api.saveResourceTemplate(toPayload(base, { create: true, copyFrom: source?.name })),
      t("mcProject.templateCreated", { name }),
    ).then((ok) => {
      if (!ok) return;
      setCreating(false);
      setNewName("");
      setCopyFrom("");
    });
  };

  return (
    <div className="mc-templates">
      <div className="mc-templates-head">
        <p className="mc-templates-intro">{t("mcProject.templateSettingsDesc")}</p>
        <Button size="sm" disabled={busy} onClick={() => setCreating(true)}>
          <IconPlus size={14} aria-hidden />
          {t("mcProject.templateNew")}
        </Button>
      </div>
      {notice ? <p className="mc-templates-notice">{notice}</p> : null}

      {creating ? (
        <section className="mc-template-card mc-template-card-new" aria-label={t("mcProject.templateNew")}>
          <div className="mc-template-new-row">
            <input
              autoFocus
              className="mc-workbench-description"
              aria-label={t("mcProject.templateNewName")}
              placeholder={t("mcProject.templateNewName")}
              value={newName}
              onChange={(event) => setNewName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") create();
                if (event.key === "Escape") setCreating(false);
              }}
            />
            <select
              className="mc-workbench-select"
              aria-label={t("mcProject.templateTarget")}
              value={newTarget}
              onChange={(event) => setNewTarget(event.target.value as ResourceTemplateTarget)}
            >
              <option value="resources">{t("mcProject.templateTargetResources")}</option>
              <option value="creative">{t("mcProject.templateTargetCreative")}</option>
            </select>
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
            <Button size="sm" variant="ghost" onClick={() => setCreating(false)}>
              {t("mcProject.templateCancel")}
            </Button>
          </div>
        </section>
      ) : null}

      {templates.map((template) => (
        <TemplateCard
          key={`${template.name}:${template.version}:${(template.folders ?? template.categories).join("|")}`}
          template={template}
          busy={busy}
          onSave={(draft) =>
            run(
              () => api.saveResourceTemplate(toPayload(draft)),
              t("mcProject.templateSaved", { name: template.name }),
            )
          }
          onDelete={() => {
            if (!window.confirm(t("mcProject.templateDeleteConfirm", { name: template.name }))) return;
            void run(
              () => api.deleteResourceTemplate(template.name),
              t("mcProject.templateDeleted", { name: template.name }),
            );
          }}
          onReveal={() =>
            void api.revealResourceTemplate(template.name).catch((error: unknown) => onError(messageOf(error)))
          }
        />
      ))}

      <p className="mc-templates-hint">{t("mcProject.templateEditorHint")}</p>
    </div>
  );
}

/** Where a new folder is being typed: the top level, or inside a folder. */
const TOP = "\u0000top";

function TemplateCard({
  template,
  busy,
  onSave,
  onDelete,
  onReveal,
}: {
  template: ResourceTemplateSummary;
  busy: boolean;
  onSave: (draft: TemplateDraftState) => Promise<boolean>;
  onDelete: () => void;
  onReveal: () => void;
}) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState(() => draftFromSummary(template));
  const [adding, setAdding] = useState<string | null>(null);
  const [newFolder, setNewFolder] = useState("");
  const [folderError, setFolderError] = useState<FolderError | null>(null);
  const dirty = isDirty(draft, template);

  const startAdding = (parent: string) => {
    setAdding(parent);
    setNewFolder("");
    setFolderError(null);
  };

  const commitFolder = () => {
    if (adding === null) return;
    const result = addFolder(draft, adding === TOP ? null : adding, newFolder);
    if ("error" in result) {
      setFolderError(result.error);
      return;
    }
    setDraft(result.draft);
    setAdding(null);
    setNewFolder("");
  };

  const addRow = (depth: number) => (
    <div className="mc-template-node mc-template-node-adding">
      <span className="mc-template-node-name" style={{ paddingLeft: `${depth * 18 + 8}px` }}>
        <IconFolder size={14} aria-hidden />
        <input
          autoFocus
          className="mc-workbench-description"
          aria-label={t("mcProject.templateFolderName")}
          placeholder={t("mcProject.templateFolderName")}
          value={newFolder}
          onChange={(event) => {
            setNewFolder(event.target.value);
            setFolderError(null);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") commitFolder();
            if (event.key === "Escape") setAdding(null);
          }}
        />
      </span>
      <span className="mc-template-node-add-actions">
        <Button size="sm" disabled={!newFolder.trim()} onClick={commitFolder}>
          {t("mcProject.templateFolderAdd")}
        </Button>
        <Button size="sm" variant="ghost" onClick={() => setAdding(null)}>
          {t("mcProject.templateCancel")}
        </Button>
        {folderError ? (
          <span className="mc-workbench-attention">{t(`mcProject.templateFolderError_${folderError}`)}</span>
        ) : null}
      </span>
    </div>
  );

  return (
    <section className="mc-template-card" aria-label={template.name}>
      <header className="mc-template-card-head">
        <div className="mc-template-card-title">
          <strong>{template.name}</strong>
          <span className="mc-template-badge">
            {t(template.target === "creative" ? "mcProject.templateTargetCreative" : "mcProject.templateTargetResources")}
          </span>
          {template.builtin ? <span className="mc-template-badge">{t("mcProject.templateBuiltin")}</span> : null}
          <span className="mc-template-version">v{template.version}</span>
        </div>
        <div className="mc-template-card-actions">
          {dirty ? (
            <>
              <Button size="sm" variant="ghost" disabled={busy} onClick={() => setDraft(draftFromSummary(template))}>
                {t("mcProject.templateRevert")}
              </Button>
              <Button size="sm" disabled={busy} onClick={() => void onSave(draft)}>
                {t("mcProject.templateSave")}
              </Button>
            </>
          ) : null}
          <Button size="sm" variant="ghost" disabled={busy} onClick={onReveal}>
            {t("mcProject.templateReveal")}
          </Button>
          {!template.builtin ? (
            <Button size="sm" variant="ghost" disabled={busy} onClick={onDelete}>
              {t("mcProject.templateDelete")}
            </Button>
          ) : null}
        </div>
      </header>

      <input
        className="mc-template-description"
        aria-label={t("mcProject.templateDescription")}
        placeholder={t("mcProject.templateDescription")}
        value={draft.description}
        onChange={(event) => setDraft({ ...draft, description: event.target.value })}
      />

      <div className="mc-template-tree" role="tree" aria-label={t("mcProject.templateFolders")}>
        {draft.folders.length === 0 && adding !== TOP ? (
          <div className="mc-template-empty">{t("mcProject.templateNoFolders")}</div>
        ) : null}
        {draft.folders.map((folder) => {
          const depth = folderDepth(folder.path);
          const name = folderName(folder.path);
          return (
            <div key={folder.path} role="none">
              <div
                role="treeitem"
                aria-level={depth + 1}
                className="mc-template-node"
              >
                <span
                  className="mc-template-node-name"
                  title={folder.path}
                  style={{ paddingLeft: `${depth * 18 + 8}px` }}
                >
                  <IconFolder size={14} aria-hidden />
                  <span>{name}</span>
                  {folder.saved ? null : <span className="mc-template-new-tag">{t("mcProject.templateCategoryNew")}</span>}
                </span>
                <input
                  className="mc-template-node-description"
                  aria-label={t("mcProject.templateCategoryDescription", { name: folder.path })}
                  placeholder={t("mcProject.templateCategoryDescriptionPlaceholder")}
                  value={folder.description}
                  onChange={(event) => setDraft(describeFolder(draft, folder.path, event.target.value))}
                />
                <span className="mc-template-node-actions">
                  {depth + 1 < MAX_FOLDER_DEPTH ? (
                    <button
                      type="button"
                      className="mc-template-icon-button"
                      title={t("mcProject.templateFolderAddInside", { name })}
                      aria-label={t("mcProject.templateFolderAddInside", { name })}
                      onClick={() => startAdding(folder.path)}
                    >
                      <IconPlus size={13} />
                    </button>
                  ) : null}
                  <button
                    type="button"
                    className="mc-template-icon-button"
                    title={t("mcProject.templateCategoryRemove", { name: folder.path })}
                    aria-label={t("mcProject.templateCategoryRemove", { name: folder.path })}
                    onClick={() => setDraft(removeFolder(draft, folder.path))}
                  >
                    <IconClose size={13} />
                  </button>
                </span>
              </div>
              {adding === folder.path ? addRow(depth + 1) : null}
            </div>
          );
        })}
        {adding === TOP ? addRow(0) : null}
      </div>

      {adding === TOP ? null : (
        <button type="button" className="mc-template-add-top" onClick={() => startAdding(TOP)}>
          <IconPlus size={13} aria-hidden />
          {t("mcProject.templateFolderAddTop")}
        </button>
      )}
    </section>
  );
}

/** Open Settings → Project templates, leaving the create dialog if it is up. */
export function openTemplateSettings(): void {
  const store = useAppStore.getState();
  if (store.createProjectDialogOpen) store.closeProjectDialog();
  store.setSettingsTab("projectTemplates");
  store.setPage("settings");
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
