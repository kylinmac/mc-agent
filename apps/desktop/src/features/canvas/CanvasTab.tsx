import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { CanvasElement, CanvasKind, CanvasThread } from "@pi-desktop/shared";
import { Button } from "../../components/ui";
import { IconBrowser, IconDownload, IconPencil, IconPlus, IconTrash } from "../../components/icons";
import { api } from "../../lib/api";
import { isRemoteSession } from "../../lib/remote-session-safety";
import { useAppStore } from "../../stores/app-store";
import { canvasTab } from "../work-tools/tool-tabs";
import { CanvasView } from "./CanvasView";
import { threadAttachment, type CanvasAttachment, type CanvasViewState } from "./canvas-model";
import { canvasGroupIdForSession, sendToSession, useCanvasSession } from "./canvas-session";
import { useCanvasList } from "./use-canvas";

const WhiteboardView = lazy(() => import("./WhiteboardView"));

/*
  mc-agent prototype & whiteboard canvas (docs/mc-agent/prototype-canvas.md,
  MC-ADR-0030): the Canvas tab of a conversation's work panel. Works in all
  local conversations (project-scoped when in a project, session-scoped when
  standalone) and hosts both HTML prototype canvases (`prototype`) and offline
  Excalidraw sketch whiteboards (`whiteboard`).
*/

type Naming = { mode: "new" | "rename"; kind?: CanvasKind; value: string; error?: string };

function fallbackArtboardDataUrl(title: string, width: number, height: number): string {
  const safeTitle = title.replace(/[<>&"]/g, "");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
    <rect width="100%" height="100%" fill="#f8f9fa" stroke="#ced4da" stroke-width="2"/>
    <text x="50%" y="50%" dominant-baseline="middle" text-anchor="middle" font-family="system-ui,sans-serif" font-size="20" fill="#495057">${safeTitle} (${width}×${height})</text>
  </svg>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

export function CanvasTab({ canvasId }: { canvasId?: string }) {
  const { t } = useTranslation();
  const sessionId = useAppStore((state) => state.activeSessionId);
  const session = useAppStore((state) => state.sessions.find((candidate) => candidate.id === state.activeSessionId));
  const openWorkPanelTab = useAppStore((state) => state.openWorkPanelTab);
  const remote = Boolean(session && isRemoteSession(session));
  const projectPath = session && !remote ? session.projectPath : undefined;
  const [groupId, setGroupId] = useState<string | null | undefined>(undefined);
  const { canvases, reload } = useCanvasList(groupId ?? null);
  const [naming, setNaming] = useState<Naming | null>(null);
  const submittingNameRef = useRef(false);

  useEffect(() => {
    let live = true;
    if (!sessionId || remote) {
      setGroupId(null);
      return;
    }
    setGroupId(undefined);
    void canvasGroupIdForSession(sessionId, projectPath)
      .then((resolved) => live && setGroupId(resolved))
      .catch(() => live && setGroupId(null));
    return () => {
      live = false;
    };
  }, [sessionId, projectPath, remote]);

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

  if (groupId === undefined) return <div className="mc-canvas-tab" />;
  if (!groupId || !sessionId) {
    return (
      <div className="mc-canvas-tab">
        <p className="mc-canvas-tab-empty">{t("mcProject.canvasNoSession")}</p>
      </div>
    );
  }

  const createQuickCanvas = async (kind: CanvasKind, explicitTitle?: string) => {
    const title = (
      explicitTitle?.trim() ||
      (kind === "whiteboard" ? t("mcProject.canvasDefaultWhiteboardTitle") : t("mcProject.canvasSection"))
    ).trim();
    const { canvas } = await api.canvas.call("canvas.create", {
      groupId,
      title,
      ...(kind === "whiteboard" ? { kind: "whiteboard" } : {}),
    });
    await reload();
    show(canvas.id);
    return canvas;
  };

  const reportActionError = (failure: unknown) => {
    const msg = failure instanceof Error ? failure.message : String(failure);
    useAppStore.getState().showToast?.(msg, { variant: "error" });
  };

  const submitName = async () => {
    if (!naming || submittingNameRef.current) return;
    const title = naming.value.trim();
    if (!title) {
      setNaming(null);
      return;
    }
    submittingNameRef.current = true;
    try {
      if (naming.mode === "new") {
        await createQuickCanvas(naming.kind ?? "whiteboard", title);
      } else if (shown) {
        await api.canvas.call("canvas.rename", { groupId, canvasId: shown.id, title });
        await reload();
      }
      setNaming(null);
    } catch (failure) {
      setNaming({ ...naming, error: failure instanceof Error ? failure.message : String(failure) });
    } finally {
      submittingNameRef.current = false;
    }
  };

  const remove = async () => {
    if (!shown) return;
    if (!window.confirm(t("mcProject.canvasDeleteCanvasConfirm", { title: shown.title }))) return;
    try {
      await api.canvas.call("canvas.delete", { groupId, canvasId: shown.id });
      await reload();
    } catch (failure) {
      reportActionError(failure);
    }
  };

  const exportCanvas = async () => {
    if (!shown) return;
    try {
      await api.canvas.export(groupId, shown.id);
    } catch (failure) {
      window.alert(
        t("mcProject.canvasExportFailed", { message: failure instanceof Error ? failure.message : String(failure) }),
      );
    }
  };

  /** Give a thread to this conversation: now, or with its next message. */
  const sendThread = async (thread: CanvasThread, queue: boolean) => {
    if (!shown) return;
    try {
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
    } catch (failure) {
      reportActionError(failure);
    }
  };

  const sendWhiteboard = async (attachment: CanvasAttachment) => {
    await sendToSession(sessionId, attachment, t("mcProject.canvasHandleWhiteboard"));
  };

  /** Capture an HTML artboard's rendered pixels (clipped strictly to the canvas stage) and place onto a whiteboard. */
  const sendBoardToWhiteboard = async (element: CanvasElement) => {
    if (!shown) return;
    try {
      let dataUrl: string | null = null;
      if (typeof document !== "undefined" && typeof window !== "undefined") {
        // Wait 2 animation frames so any context menu that triggered this action closes before `capturePage`.
        if (typeof requestAnimationFrame === "function") {
          await new Promise<void>((resolveFrame) =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolveFrame())),
          );
        }
        const domNode = document.querySelector<HTMLElement>(`[data-board="${CSS.escape(element.id)}"]`);
        const rect = domNode?.getBoundingClientRect();
        const stageRect = domNode?.closest(".mc-canvas-stage")?.getBoundingClientRect();
        if (rect && rect.width >= 8 && rect.height >= 8) {
          const left = Math.max(0, rect.left, stageRect ? stageRect.left : 0);
          const top = Math.max(0, rect.top, stageRect ? stageRect.top : 0);
          const right = Math.min(window.innerWidth || rect.right, rect.right, stageRect ? stageRect.right : rect.right);
          const bottom = Math.min(
            window.innerHeight || rect.bottom,
            rect.bottom,
            stageRect ? stageRect.bottom : rect.bottom,
          );
          const width = right - left;
          const height = bottom - top;
          if (width >= 8 && height >= 8) {
            try {
              const captured = await api.canvas.captureRect({ x: left, y: top, width, height });
              dataUrl = captured.dataUrl;
            } catch {
              dataUrl = null;
            }
          }
        }
      }
      const finalDataUrl = dataUrl || fallbackArtboardDataUrl(element.title || element.id, element.w, element.h);
      const mimeType = finalDataUrl.startsWith("data:image/svg+xml") ? "image/svg+xml" : "image/png";

      let targetBoard = canvases.find((c) => c.kind === "whiteboard");
      if (!targetBoard) {
        const created = await api.canvas.call("canvas.create", {
          groupId,
          title: `${shown.title} · ${t("mcProject.canvasKindWhiteboard")}`,
          kind: "whiteboard",
        });
        await reload();
        targetBoard = {
          id: created.canvas.id,
          title: created.canvas.title,
          kind: "whiteboard",
          version: created.canvas.version,
          updatedAt: created.canvas.updatedAt,
          boards: 0,
          path: "",
        };
      }

      const loaded = await api.canvas.call("canvas.whiteboard.get", {
        groupId,
        canvasId: targetBoard.id,
        includeFiles: false,
      });
      const existing = loaded.scene.elements ?? [];
      const maxRight = existing.reduce((acc, el) => {
        const x = typeof el.x === "number" ? el.x : 0;
        const w = typeof el.width === "number" ? el.width : 0;
        return Math.max(acc, x + w);
      }, 0);
      const scale = Math.min(1, 720 / Math.max(1, element.w));
      const displayW = Math.round(element.w * scale);
      const displayH = Math.round(element.h * scale);
      const nextX = existing.length > 0 ? Math.round(maxRight + 80) : 60;
      const fileId = `board_${element.id}_${Date.now().toString(36)}`.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64);
      const imgElementId = `img_${fileId}`.slice(0, 60);
      const now = Date.now();

      const imageElement: Record<string, unknown> = {
        id: imgElementId,
        type: "image",
        x: nextX,
        y: 60,
        width: displayW,
        height: displayH,
        angle: 0,
        strokeColor: "transparent",
        backgroundColor: "transparent",
        fillStyle: "solid",
        strokeWidth: 1,
        strokeStyle: "solid",
        roughness: 0,
        opacity: 100,
        groupIds: [],
        frameId: null,
        roundness: null,
        seed: Math.floor(Math.random() * 1_000_000) + 1,
        version: 1,
        versionNonce: Math.floor(Math.random() * 1_000_000) + 1,
        isDeleted: false,
        boundElements: null,
        updated: now,
        link: null,
        locked: false,
        status: "saved",
        fileId,
        scale: [1, 1],
      };

      await api.canvas.call("canvas.whiteboard.save", {
        groupId,
        canvasId: targetBoard.id,
        scene: {
          elements: [...existing, imageElement],
          appState: loaded.scene.appState ?? { viewBackgroundColor: "#ffffff" },
        },
        upsertedFiles: {
          [fileId]: {
            id: fileId,
            mimeType,
            dataURL: finalDataUrl,
            created: now,
          },
        },
      });
      await reload();
      show(targetBoard.id);
    } catch (failure) {
      reportActionError(failure);
    }
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
              {`${candidate.kind === "whiteboard" ? "✏️" : "🖥"} ${candidate.title}`}
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
            title={t("mcProject.canvasExport")}
            aria-label={t("mcProject.canvasExport")}
            onClick={() => void exportCanvas()}
          >
            <IconDownload size={13} />
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
        className="mc-canvas-icon mc-canvas-create-pill"
        title={t("mcProject.canvasNewWhiteboard")}
        aria-label={t("mcProject.canvasNewWhiteboard")}
        onClick={() =>
          setNaming({
            mode: "new",
            kind: "whiteboard",
            value: t("mcProject.canvasDefaultWhiteboardTitle"),
          })
        }
      >
        <IconPlus size={12} />
        <span>{t("mcProject.canvasKindWhiteboard")}</span>
      </button>
      <button
        type="button"
        className="mc-canvas-icon mc-canvas-create-pill"
        title={t("mcProject.canvasNewPrototype")}
        aria-label={t("mcProject.canvasNewPrototype")}
        onClick={() => setNaming({ mode: "new", kind: "prototype", value: "" })}
      >
        <IconBrowser size={12} />
        <span>{t("mcProject.canvasKindPrototype")}</span>
      </button>
    </div>
  );

  return (
    <div className="mc-canvas-tab">
      {shown ? (
        shown.kind === "whiteboard" ? (
          <Suspense fallback={<div className="mc-canvas" />}>
            <WhiteboardView
              key={shown.id}
              groupId={groupId}
              canvasId={shown.id}
              sessionId={sessionId}
              head={head}
              onViewState={setView}
              onAttach={(attachment) => useCanvasSession.getState().attach(sessionId, attachment)}
              onSendWhiteboard={sendWhiteboard}
            />
          </Suspense>
        ) : (
          <CanvasView
            key={shown.id}
            groupId={groupId}
            canvasId={shown.id}
            head={head}
            onViewState={setView}
            onAttach={(attachment) => useCanvasSession.getState().attach(sessionId, attachment)}
            onSendThread={(thread, queue) => void sendThread(thread, queue)}
            onSendBoardToWhiteboard={(element) => void sendBoardToWhiteboard(element)}
          />
        )
      ) : (
        <>
          <div className="mc-canvas-toolbar is-static">{head}</div>
          <div className="mc-canvas-empty-box">
            <p className="mc-canvas-tab-empty">{t("mcProject.canvasNoCanvas")}</p>
            <div className="mc-canvas-empty-actions">
              <Button
                size="sm"
                variant="primary"
                onClick={() => void createQuickCanvas("whiteboard")}
              >
                <IconPencil size={13} />
                {t("mcProject.canvasNewWhiteboard")}
              </Button>
              <Button
                size="sm"
                variant="secondary"
                onClick={() => setNaming({ mode: "new", kind: "prototype", value: "" })}
              >
                <IconBrowser size={13} />
                {t("mcProject.canvasNewPrototype")}
              </Button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
