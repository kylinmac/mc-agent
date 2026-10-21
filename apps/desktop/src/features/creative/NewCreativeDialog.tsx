import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { ProjectGroupRecord } from "@pi-desktop/shared";
import { Button, cx, portalOverlay } from "../../components/ui";
import { IconFolderOpen, IconX } from "../../components/icons";
import { api } from "../../lib/api";

/*
  mc-agent creative studio: creative work always happens in a real folder of a
  project, so the images can be used where they are. Three ways in:
  - a folder → a new project with it as the workspace;
  - an existing project + a new folder added to it as a workspace;
  - an existing project + one of its folders.
  Files go to `<folder>/creative/`.
*/

const ADD_FOLDER = "\u0000add";

function folderName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}

export function NewCreativeDialog({
  groups,
  onClose,
  onCreated,
}: {
  groups: readonly ProjectGroupRecord[];
  onClose: () => void;
  onCreated: (groupId: string) => void;
}) {
  const { t } = useTranslation();
  const [mode, setMode] = useState<"folder" | "project">("folder");
  const [folder, setFolder] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [groupId, setGroupId] = useState<string>(groups[0]?.id ?? "");
  const [workspace, setWorkspace] = useState<string>("");
  const [added, setAdded] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const group = groups.find((candidate) => candidate.id === groupId) ?? null;

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  useEffect(() => {
    // Default to the project's first workspace.
    const first = group?.roots.find((root) => root.kind !== "resources") ?? group?.roots[0];
    setWorkspace(first?.path ?? "");
    setAdded(null);
  }, [group]);

  const pick = async (): Promise<string | null> => {
    const { folders } = await api.pickProjectFolders();
    return folders[0] ?? null;
  };

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      if (mode === "folder") {
        if (!folder) return;
        const { group: created } = await api.creative.call<{ group: { id: string } }>("creative.createProject", {
          folder,
          name: name.trim(),
        });
        onCreated(created.id);
      } else {
        if (!group) return;
        const target = workspace === ADD_FOLDER ? added : workspace;
        if (!target) return;
        await api.creative.call("creative.useWorkspace", {
          groupId: group.id,
          folder: target,
          add: workspace === ADD_FOLDER,
        });
        onCreated(group.id);
      }
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setBusy(false);
    }
  };

  const ready =
    mode === "folder" ? !!folder : !!group && (workspace === ADD_FOLDER ? !!added : !!workspace);
  const target = mode === "folder" ? folder : workspace === ADD_FOLDER ? added : workspace;

  return portalOverlay(
    <div className="mc-creative-detail-layer" role="dialog" aria-modal="true" aria-label={t("mcProject.creativeNewProject")}>
      <button type="button" className="mc-creative-detail-scrim" aria-label={t("mcProject.creativeClose")} onClick={onClose} />
      <div className="mc-creative-dialog">
        <div className="mc-creative-detail-head">
          <h2>{t("mcProject.creativeNewProject")}</h2>
          <button type="button" className="mc-creative-icon-button" aria-label={t("mcProject.creativeClose")} onClick={onClose}>
            <IconX size={15} />
          </button>
        </div>
        <p className="mc-creative-muted">{t("mcProject.creativeNewIntro")}</p>

        <label className={cx("mc-creative-choice", mode === "folder" && "is-on")}>
          <input type="radio" checked={mode === "folder"} onChange={() => setMode("folder")} />
          <span>
            <strong>{t("mcProject.creativeNewFromFolder")}</strong>
            <span className="mc-creative-muted">{t("mcProject.creativeNewFromFolderHint")}</span>
          </span>
        </label>
        {mode === "folder" ? (
          <div className="mc-creative-choice-body">
            <Button
              size="sm"
              variant="secondary"
              onClick={() =>
                void pick().then((picked) => {
                  if (picked) setFolder(picked);
                })
              }
            >
              <IconFolderOpen size={13} />
              {folder ? folderName(folder) : t("mcProject.creativePickFolder")}
            </Button>
            <input
              className="mc-creative-input"
              value={name}
              placeholder={folder ? folderName(folder) : t("mcProject.creativeNewProjectName")}
              onChange={(event) => setName(event.target.value)}
              aria-label={t("mcProject.creativeNewProjectName")}
            />
          </div>
        ) : null}

        <label className={cx("mc-creative-choice", mode === "project" && "is-on")}>
          <input type="radio" checked={mode === "project"} disabled={!groups.length} onChange={() => setMode("project")} />
          <span>
            <strong>{t("mcProject.creativeUseProject")}</strong>
            <span className="mc-creative-muted">{t("mcProject.creativeUseProjectHint")}</span>
          </span>
        </label>
        {mode === "project" ? (
          <div className="mc-creative-choice-body">
            <select
              className="mc-creative-select"
              value={groupId}
              aria-label={t("mcProject.creativeProject")}
              onChange={(event) => setGroupId(event.target.value)}
            >
              {groups.map((candidate) => (
                <option key={candidate.id} value={candidate.id}>
                  {candidate.name}
                </option>
              ))}
            </select>
            <select
              className="mc-creative-select"
              value={workspace}
              aria-label={t("mcProject.creativeWorkspace")}
              onChange={(event) => {
                const value = event.target.value;
                setWorkspace(value);
                if (value === ADD_FOLDER && !added) {
                  void pick().then((picked) => {
                    if (picked) setAdded(picked);
                    else setWorkspace(group?.roots[0]?.path ?? "");
                  });
                }
              }}
            >
              {group?.roots.map((root) => (
                <option key={root.path} value={root.path}>
                  {root.kind === "resources" ? t("mcProject.creativeStorageResources") : folderName(root.path)}
                </option>
              ))}
              <option value={ADD_FOLDER}>
                {added ? t("mcProject.creativeAddedFolder", { name: folderName(added) }) : t("mcProject.creativeAddFolder")}
              </option>
            </select>
          </div>
        ) : null}

        {target ? (
          <p className="mc-creative-muted mc-creative-mono">
            {t("mcProject.creativeWillStore", {
              path: workspace !== ADD_FOLDER && group?.roots.find((root) => root.path === target)?.kind === "resources" && mode === "project"
                ? `${target}/assets`
                : `${target}/creative`,
            })}
          </p>
        ) : null}
        {error ? <p className="mc-creative-error">{error}</p> : null}
        <div className="mc-creative-dialog-actions">
          <Button variant="ghost" onClick={onClose}>
            {t("mcProject.creativeCancel")}
          </Button>
          <Button variant="primary" disabled={!ready || busy} onClick={() => void submit()}>
            {t("mcProject.creativeCreate")}
          </Button>
        </div>
      </div>
    </div>,
  );
}
