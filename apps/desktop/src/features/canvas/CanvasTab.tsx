import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { CanvasThread, ProjectGroupRecord } from "@pi-desktop/shared";
import { IconPencil, IconPlus, IconTrash } from "../../components/icons";
import { api } from "../../lib/api";
import { isRemoteSession } from "../../lib/remote-session-safety";
import { useAppStore } from "../../stores/app-store";
import { canvasTab } from "../work-tools/tool-tabs";
import { CanvasView } from "./CanvasView";
import { threadAttachment, type CanvasViewState } from "./canvas-model";
import { projectGroupForPath, sendToSession, useCanvasSession } from "./canvas-session";
import { useCanvasList } from "./use-canvas";

/*
  mc-agent prototype canvas (docs/mc-agent/prototype-canvas.md): the Canvas
  tab of a conversation's work panel. It shows one of the project's canvases
  (the tab's resource, else the latest), lets the user switch, add, rename or
  delete canvases, and hands what the user does on it to this conversation.
*/

type Naming = { mode: "new" | "rename"; value: string; error?: string };

export function CanvasTab({ canvasId }: { canvasId?: string }) {
  const { t } = useTranslation();
  const sessionId = useAppStore((state) => state.activeSessionId);
  const session = useAppStore((state) => state.sessions.find((candidate) => candidate.id === state.activeSessionId));
  const openWorkPanelTab = useAppStore((state) => state.openWorkPanelTab);
  const projectPath = session && !isRemoteSession(session) ? session.projectPath : undefined;
  const [group, setGroup] = useState<ProjectGroupRecord | null | undefined>(undefined);
  const { canvases, reload } = useCanvasList(group?.id ?? null);
  const [naming, setNaming] = useState<Naming | null>(null);

  useEffect(() => {
    let live = true;
    setGroup(undefined);
    void projectGroupForPath(projectPath)
      .then((found) => live && setGroup(found))
      .catch(() => live && setGroup(null));
    return () => {
      live = false;
    };
  }, [projectPath]);

  const shown =
    canvases.find((candidate) => candidate.id === canvasId) ??
    [...canvases].sort((a, b) => b.updatedAt - a.updatedAt)[0];
  const show = (id: string) => openWorkPanelTab(canvasTab(id));

  const setView = useCallback(
    (state: CanvasViewState | null) => {
      if (sessionId) useCanvasSession.getState().setView(sessionId, state);
    },
    [sessionId],
  );

  if (group === undefined) return <div className="mc-canvas-tab" />;
  if (!group || !sessionId) {
    return (
      <div className="mc-canvas-tab">
        <p className="mc-canvas-tab-empty">{t("mcProject.canvasNoProject")}</p>
      </div>
    );
  }
  const groupId = group.id;

  const submitName = async () => {
    if (!naming) return;
    const title = naming.value.trim();
    if (!title) {
      setNaming(null);
      return;
    }
    try {
      if (naming.mode === "new") {
        const { canvas } = await api.canvas.call("canvas.create", { groupId, title });
        await reload();
        show(canvas.id);
      } else if (shown) {
        await api.canvas.call("canvas.rename", { groupId, canvasId: shown.id, title });
        await reload();
      }
      setNaming(null);
    } catch (failure) {
      setNaming({ ...naming, error: failure instanceof Error ? failure.message : String(failure) });
    }
  };

  const remove = async () => {
    if (!shown) return;
    if (!window.confirm(t("mcProject.canvasDeleteCanvasConfirm", { title: shown.title }))) return;
    await api.canvas.call("canvas.delete", { groupId, canvasId: shown.id });
    await reload();
  };

  /** Give a thread to this conversation: now, or with its next message. */
  const sendThread = async (thread: CanvasThread, queue: boolean) => {
    if (!shown) return;
    const { comments } = await api.canvas.call("canvas.comments.assign", {
      groupId,
      canvasId: shown.id,
      threadId: thread.id,
      sessionId,
    });
    const assigned = comments.threads.find((candidate) => candidate.id === thread.id) ?? thread;
    const attachment = threadAttachment(shown.id, assigned);
    if (queue) useCanvasSession.getState().attach(sessionId, attachment);
    else await sendToSession(sessionId, attachment, t("mcProject.canvasHandleThread"));
  };

  const head = (
    <div className="mc-canvas-tab-head">
      {naming ? (
        <input
          className="mc-canvas-tab-name"
          autoFocus
          value={naming.value}
          placeholder={t("mcProject.canvasTitleHint")}
          aria-invalid={naming.error ? true : undefined}
          title={naming.error}
          onChange={(event) => setNaming({ ...naming, value: event.target.value, error: undefined })}
          onBlur={() => void submitName()}
          onKeyDown={(event) => {
            if (event.key === "Enter") void submitName();
            if (event.key === "Escape") setNaming(null);
          }}
        />
      ) : canvases.length ? (
        <select
          className="mc-canvas-tab-select"
          aria-label={t("mcProject.canvasSection")}
          value={shown?.id ?? ""}
          onChange={(event) => show(event.target.value)}
        >
          {canvases.map((candidate) => (
            <option key={candidate.id} value={candidate.id}>
              {candidate.title}
            </option>
          ))}
        </select>
      ) : (
        <span className="mc-canvas-muted">{t("mcProject.canvasSection")}</span>
      )}
      {shown && !naming ? (
        <>
          <button
            type="button"
            className="mc-canvas-icon"
            title={t("mcProject.canvasRename")}
            aria-label={t("mcProject.canvasRename")}
            onClick={() => setNaming({ mode: "rename", value: shown.title })}
          >
            <IconPencil size={13} />
          </button>
          <button
            type="button"
            className="mc-canvas-icon"
            title={t("mcProject.canvasDeleteCanvas")}
            aria-label={t("mcProject.canvasDeleteCanvas")}
            onClick={() => void remove()}
          >
            <IconTrash size={13} />
          </button>
        </>
      ) : null}
      <button
        type="button"
        className="mc-canvas-icon"
        title={t("mcProject.canvasNew")}
        aria-label={t("mcProject.canvasNew")}
        onClick={() => setNaming({ mode: "new", value: "" })}
      >
        <IconPlus size={13} />
      </button>
    </div>
  );

  return (
    <div className="mc-canvas-tab">
      {shown ? (
        <CanvasView
          key={shown.id}
          groupId={groupId}
          canvasId={shown.id}
          head={head}
          onViewState={setView}
          onAttach={(attachment) => useCanvasSession.getState().attach(sessionId, attachment)}
          onSendThread={(thread, queue) => void sendThread(thread, queue)}
        />
      ) : (
        <>
          <div className="mc-canvas-toolbar is-static">{head}</div>
          <p className="mc-canvas-tab-empty">{t("mcProject.canvasNoCanvas")}</p>
        </>
      )}
    </div>
  );
}
