import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { ProjectTask, ResourceItem, ResourceListing, WorkspaceNote } from "@pi-desktop/shared";
import { api } from "../../lib/api";
import { Button } from "../../components/ui";
import { IconFolder, IconPlus } from "../../components/icons";
import { shortenPath, type ProjectIndexItem } from "../../lib/project-archive";
import { chooseStartFolder, rememberedStartFolder, rememberStartFolder } from "./start-folder";
import { ProjectOverview } from "./ProjectOverview";
import { ResourceCatalog } from "./ResourceCatalog";
import { ConvertToManaged } from "./ConvertToManaged";
import { openTemplateSettings } from "./TemplateEditor";
import { TemplateMigration } from "./TemplateMigration";
import { TaskBoard } from "./TaskBoard";

/*
  mc-agent project workbench (R1, R10): the project's resource folder, its
  equal workspaces with their descriptions from workspaces.md, and the folder
  a new session starts in. Mounted inside the upstream project detail panel.
  A project without a resource folder gets one from the blank template the
  first time this panel opens it (MC-ADR-0003, decision 9).
*/
export function ProjectWorkbench({
  project,
  onProjectChanged,
  onStartSession,
  onError,
}: {
  project: ProjectIndexItem;
  /**
   * The group record changed on the host. A backfill moves the primary path
   * to the new resource folder, which callers keying rows by path must follow.
   */
  onProjectChanged: (primaryPath: string) => void;
  onStartSession: (path: string) => void;
  onError: (message: string) => void;
}) {
  const { t } = useTranslation();
  const resources = project.roots.find((root) => root.kind === "resources");
  const workspaces = useMemo(
    () => project.roots.filter((root) => root.kind !== "resources"),
    [project.roots],
  );
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [listing, setListing] = useState<ResourceListing | null>(null);
  // Bumped by the template editor so the organize panel reloads templates.
  const [tasks, setTasks] = useState<ProjectTask[]>([]);
  // Creative use is its own mark, independent of having a resource folder.
  const [creative, setCreative] = useState(false);
  useEffect(() => {
    let canceled = false;
    void api.creative.call("creative.purposes").then(
      ({ purposes }) => {
        if (!canceled) setCreative(purposes[project.groupId] === "creative");
      },
      () => undefined,
    );
    return () => {
      canceled = true;
    };
  }, [project.groupId]);
  const [startFolder, setStartFolder] = useState(() =>
    chooseStartFolder(project.roots, project.path, rememberedStartFolder(project.groupId)),
  );
  const remote = project.path.startsWith("remote-project:");
  // Callers pass inline handlers; refs keep async results from calling a
  // stale handler.
  const onProjectChangedRef = useRef(onProjectChanged);
  const onErrorRef = useRef(onError);
  onProjectChangedRef.current = onProjectChanged;
  onErrorRef.current = onError;

  // A project without a resource folder is a simple project; it becomes a
  // managed one only through ConvertToManaged (MC-ADR-0003 decision 12).
  const detach = async () => {
    if (!window.confirm(t("mcProject.detachConfirm"))) return;
    try {
      const { group } = await api.detachProjectResources(project.groupId);
      onProjectChangedRef.current(group.primaryPath);
    } catch (error) {
      onError(messageOf(error));
    }
  };

  const loadNotes = useCallback(() => {
    if (!resources) return () => {};
    let canceled = false;
    void api
      .listWorkspaceNotes(project.groupId)
      .then(({ notes: loaded }) => {
        if (canceled) return;
        const byPath = Object.fromEntries(loaded.map((note: WorkspaceNote) => [note.path, note.description]));
        setNotes(byPath);
        setDrafts(byPath);
      })
      .catch(() => {
        // Descriptions are optional; an unreadable file shows empty fields.
      });
    return () => {
      canceled = true;
    };
  }, [resources, project.groupId]);
  useEffect(() => loadNotes(), [loadNotes]);

  const loadListing = useCallback(() => {
    if (!resources) return () => {};
    let canceled = false;
    void api
      .listProjectResources(project.groupId)
      .then((loaded) => {
        if (!canceled) setListing(loaded);
      })
      .catch((error: unknown) => {
        if (!canceled) onErrorRef.current(t("mcProject.resourceActionError", { message: messageOf(error) }));
      });
    return () => {
      canceled = true;
    };
  }, [resources, project.groupId, t]);
  useEffect(() => loadListing(), [loadListing]);

  const resourceAction = async (action: () => Promise<unknown>) => {
    try {
      await action();
    } catch (error) {
      onError(t("mcProject.resourceActionError", { message: messageOf(error) }));
    }
    loadListing();
  };
  const openResource = (item: ResourceItem) =>
    void api
      .openProjectResource(project.groupId, item.key)
      .catch((error: unknown) => onError(t("mcProject.resourceActionError", { message: messageOf(error) })));

  useEffect(() => {
    setStartFolder(chooseStartFolder(project.roots, project.path, rememberedStartFolder(project.groupId)));
  }, [project.roots, project.path, project.groupId]);

  const saveNote = async (path: string) => {
    const draft = drafts[path] ?? "";
    if (draft.trim() === (notes[path] ?? "").trim()) return;
    try {
      const { note } = await api.setWorkspaceNote(project.groupId, path, draft);
      setNotes((prev) => ({ ...prev, [path]: note.description }));
      setDrafts((prev) => ({ ...prev, [path]: note.description }));
    } catch (error) {
      onError(t("mcProject.workspaceDescriptionError", { message: messageOf(error) }));
      setDrafts((prev) => ({ ...prev, [path]: notes[path] ?? "" }));
    }
  };

  const start = () => {
    rememberStartFolder(project.groupId, startFolder);
    onStartSession(startFolder);
  };

  if (remote) return null;

  return (
    <section className="mc-workbench" aria-label={t("mcProject.resourcesTitle")}>
      {resources ? (
        <ProjectOverview
          groupId={project.groupId}
          listing={listing}
          tasks={tasks}
          onOpenResource={openResource}
          onError={onError}
        />
      ) : null}
      {creative ? (
        <div className="mc-workbench-row">
          <span className="mc-workbench-label">{t("mcProject.purposeLabel")}</span>
          <span className="mc-workbench-tag is-creative" title={t("mcProject.purposeCreativeHint")}>
            {t("mcProject.purposeCreative")}
          </span>
        </div>
      ) : null}
      <div className="mc-workbench-row">
        <span className="mc-workbench-label">{t("mcProject.resourcesTitle")}</span>
        {resources ? (
          <>
            <span className="mc-workbench-path" title={resources.path}>
              <IconFolder size={12} aria-hidden />
              <span>{shortenPath(resources.path)}</span>
            </span>
            <Button
              size="sm"
              variant="ghost"
              onClick={() =>
                void api
                  .revealProjectResources(project.groupId)
                  .catch((error: unknown) => onError(messageOf(error)))
              }
            >
              {t("mcProject.reveal")}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => void detach()}>
              {t("mcProject.detachResources")}
            </Button>
          </>
        ) : (
          <ConvertToManaged
            groupId={project.groupId}
            onConverted={(primaryPath) => onProjectChangedRef.current(primaryPath)}
            onError={onError}
          />
        )}
      </div>

      <div className="mc-workbench-label">{t("mcProject.workspacesTitle")}</div>
      <ul className="mc-workbench-workspaces">
        {workspaces.map((root) => {
          const name = root.name || root.path.split(/[\\/]/).filter(Boolean).at(-1) || root.path;
          return (
            <li key={root.path} className="mc-workbench-workspace">
              <span className="mc-workbench-path" title={root.path}>
                <IconFolder size={12} aria-hidden />
                <span>{name}</span>
                {resources ? (<>
                <span
                  className={`mc-workbench-tag is-${root.kind ?? "workspace"}`}
                  title={root.kind === "reference" ? t("mcProject.kindReferenceHint") : undefined}
                >
                  {root.kind === "reference" ? t("mcProject.kindReference") : t("mcProject.kindWorkspace")}
                </span>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() =>
                    void api
                      .setProjectRootKind(
                        project.groupId,
                        root.path,
                        root.kind === "reference" ? "workspace" : "reference",
                      )
                      .then(() => onProjectChangedRef.current(project.path))
                      .catch((error: unknown) =>
                        onError(t("mcProject.kindError", { message: messageOf(error) })),
                      )
                  }
                >
                  {root.kind === "reference" ? t("mcProject.setAsWorkspace") : t("mcProject.setAsReference")}
                </Button>
                </>) : null}
              </span>
              {resources ? (
              <input
                className="mc-workbench-description"
                aria-label={t("mcProject.workspaceDescriptionLabel", { name })}
                placeholder={t("mcProject.workspaceDescriptionPlaceholder")}
                disabled={!resources}
                value={drafts[root.path] ?? ""}
                onChange={(event) => {
                  const value = event.target.value;
                  setDrafts((prev) => ({ ...prev, [root.path]: value }));
                }}
                onBlur={() => void saveNote(root.path)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") event.currentTarget.blur();
                }}
              />
              ) : null}
            </li>
          );
        })}
      </ul>

      {resources ? (
        <ResourceCatalog
          listing={listing}
          onOpen={openResource}
          onSetStatus={(item, status) =>
            void resourceAction(() => api.setProjectResourceStatus(project.groupId, item.key, status))
          }
          onRemove={(item) =>
            void resourceAction(() => api.unregisterProjectResource(project.groupId, item.key))
          }
          onRegisterFile={(category) =>
            void resourceAction(() =>
              api.registerProjectResourceFile(project.groupId, category, workspaces[0]?.path),
            )
          }
          onAddLink={(url, category) =>
            void resourceAction(() => api.registerProjectResourceUrl(project.groupId, url, category))
          }
          onRefresh={() => loadListing()}
        />
      ) : null}
      {resources ? (
        <TaskBoard
          groupId={project.groupId}
          listing={listing}
          startFolder={startFolder}
          onTasksChanged={setTasks}
          onError={onError}
        />
      ) : null}
      {resources ? (
        <TemplateMigration
          groupId={project.groupId}
          resourceFolder={resources.path}
          currentCategories={listing?.categories ?? []}
          workspaces={workspaces.map((root) => ({
            path: root.path,
            description: notes[root.path],
            kind: root.kind === "reference" ? ("reference" as const) : ("workspace" as const),
          }))}
          onError={onError}
        />
      ) : null}
      {resources ? (
        <div className="mc-workbench-row">
          <span className="mc-workbench-label">{t("mcProject.templateEditorTitle")}</span>
          <Button size="sm" variant="ghost" onClick={openTemplateSettings}>
            {t("mcProject.templateEditorOpen")}
          </Button>
        </div>
      ) : null}

      <div className="mc-workbench-row">
        <label className="mc-workbench-label" htmlFor={`mc-start-${project.groupId}`}>
          {t("mcProject.startFolderLabel")}
        </label>
        <select
          id={`mc-start-${project.groupId}`}
          className="mc-workbench-select"
          value={startFolder}
          onChange={(event) => setStartFolder(event.target.value)}
        >
          {project.roots.map((root) => (
            <option key={root.path} value={root.path}>
              {root.kind === "resources"
                ? t("mcProject.startFolderResources")
                : root.name || root.path.split(/[\\/]/).filter(Boolean).at(-1) || root.path}
            </option>
          ))}
        </select>
        <Button size="sm" variant="ghost" onClick={start}>
          <IconPlus size={13} />
          {t("mcProject.newSessionIn")}
        </Button>
      </div>
    </section>
  );
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
