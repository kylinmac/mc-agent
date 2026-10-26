import { useState } from "react";
import { useTranslation } from "react-i18next";
import { CREATE_PROJECT_TOOL_NAME, type UiMessage } from "@pi-desktop/shared";
import { toolResultPayload } from "../../lib/tool-presentation";
import { useAppStore } from "../../stores/app-store";
import { Button } from "../../components/ui";

type Created = { name: string; path: string; primaryPath: string };

function createdProject(message: UiMessage): Created | null {
  if (message.toolName !== CREATE_PROJECT_TOOL_NAME) return null;
  const payload = toolResultPayload(message);
  if (!payload || typeof payload !== "object") return null;
  const record = payload as Record<string, unknown>;
  if (record.kind !== "create-project" || record.outcome !== "created") return null;
  const path = typeof record.path === "string" ? record.path : "";
  const primaryPath = typeof record.primaryPath === "string" && record.primaryPath ? record.primaryPath : path;
  if (!primaryPath) return null;
  return { name: typeof record.name === "string" ? record.name : primaryPath, path, primaryPath };
}

/**
 * mc-agent (MC-ADR-0023): the project a `CreateProject` call made, with the
 * way into it. "Continue in the project" moves this conversation there, which
 * the host allows only once the turn has ended.
 */
export function CreatedProjectCard({ message }: { message: UiMessage }) {
  const { t } = useTranslation();
  const activeSessionId = useAppStore((state) => state.activeSessionId);
  const running = useAppStore((state) => (state.activeSessionId ? Boolean(state.runningSessions[state.activeSessionId]) : false));
  const sessionProject = useAppStore(
    (state) => state.sessions.find((session) => session.id === state.activeSessionId)?.projectPath ?? null,
  );
  const activateProject = useAppStore((state) => state.activateProject);
  const moveSessionProject = useAppStore((state) => state.moveSessionProject);
  const showProjectInSidebar = useAppStore((state) => state.showProjectInSidebar);
  const showToast = useAppStore((state) => state.showToast);
  const [busy, setBusy] = useState(false);
  const project = createdProject(message);
  if (!project) return null;
  const alreadyHere = sessionProject === project.primaryPath;

  const continueHere = async () => {
    if (!activeSessionId) return;
    setBusy(true);
    try {
      showProjectInSidebar({ path: project.primaryPath, name: project.name });
      const moved = await moveSessionProject(activeSessionId, project.primaryPath);
      if (!moved) throw new Error(t("mcProject.npMoveFailed"));
      showToast(t("nav.sessionMoved", { name: project.name, defaultValue: `Moved to ${project.name}` }), {
        variant: "success",
      });
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), { variant: "error" });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mc-np-done" role="status">
      <div className="mc-np-done-copy">
        <span className="mc-np-done-title">{t("mcProject.npDoneTitle", { name: project.name })}</span>
        <span className="mc-np-done-path">{project.path}</span>
      </div>
      <div className="mc-np-actions">
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => void activateProject(project.primaryPath)}>
          {t("mcProject.npOpenProject")}
        </Button>
        {alreadyHere ? null : (
          <Button
            size="sm"
            variant="primary"
            disabled={busy || running || !activeSessionId}
            title={running ? t("mcProject.npContinueAfterTurn") : undefined}
            onClick={() => void continueHere()}
          >
            {t("mcProject.npContinueHere")}
          </Button>
        )}
      </div>
    </div>
  );
}
