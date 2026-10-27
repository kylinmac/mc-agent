import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { IconBrowser, IconX } from "../../components/icons";
import { api } from "../../lib/api";
import { useAppStore } from "../../stores/app-store";
import { canvasTab } from "../work-tools/tool-tabs";
import { expandPane } from "../work-tools/pane-layout";
import type { CanvasAttachment } from "./canvas-model";
import { sentView, useCanvasSession } from "./canvas-session";
import "./canvas.css";

/*
  mc-agent prototype canvas (docs/mc-agent/prototype-canvas.md), above the
  composer: what the next message carries from the Canvas tab — the view the
  user is looking at (dismissable until the selection changes) and queued
  comments, notes and errors. It also brings the Canvas tab up when the agent
  draws, so its work is in view.
*/

function attachmentLabel(item: CanvasAttachment, t: (key: string, options?: Record<string, unknown>) => string): string {
  const short = (text: string) => (text.length > 24 ? `${text.slice(0, 24)}…` : text);
  switch (item.kind) {
    case "thread":
      return t("mcProject.canvasChipThread", { text: short(item.messages[0]?.text ?? "") });
    case "note":
      return t("mcProject.canvasChipNote", { text: short(item.text) });
    case "errors":
      return t("mcProject.canvasChipErrors", { board: item.boardId });
  }
}

export function CanvasContextBar({ sessionId }: { sessionId: string | null | undefined }) {
  const { t } = useTranslation();
  const entry = useCanvasSession((state) => (sessionId ? state.sessions[sessionId] : undefined));
  const view = sentView(entry);
  const attachments = entry?.attachments ?? [];

  // The agent changed a canvas: show it in that conversation's Canvas tab.
  useEffect(
    () =>
      api.canvas.onChanged((change) => {
        if (!change.sessionId) return;
        const store = useAppStore.getState();
        store.openWorkPanelTabForSession(change.sessionId, canvasTab(change.canvasId));
        if (change.sessionId === store.activeSessionId) expandPane("canvas");
      }),
    [],
  );

  if (!sessionId || (!view && !attachments.length)) return null;
  return (
    <div className="mc-canvas-chips" role="group" aria-label={t("mcProject.paneCanvas")}>
      {view ? (
        <span className="mc-canvas-chip">
          <IconBrowser size={12} />
          <span>
            {view.selected.length
              ? t("mcProject.canvasChatSelected", { count: view.selected.length })
              : t("mcProject.canvasChatVisible", { count: view.visibleBoards.length })}
          </span>
          <button
            type="button"
            aria-label={t("mcProject.canvasRemoveAttachment")}
            title={t("mcProject.canvasRemoveAttachment")}
            onClick={() => useCanvasSession.getState().dismissView(sessionId)}
          >
            <IconX size={10} />
          </button>
        </span>
      ) : null}
      {attachments.map((item) => (
        <span key={item.key} className="mc-canvas-chip">
          <span>{attachmentLabel(item, t)}</span>
          <button
            type="button"
            aria-label={t("mcProject.canvasRemoveAttachment")}
            title={t("mcProject.canvasRemoveAttachment")}
            onClick={() => useCanvasSession.getState().detach(sessionId, item.key)}
          >
            <IconX size={10} />
          </button>
        </span>
      ))}
    </div>
  );
}
