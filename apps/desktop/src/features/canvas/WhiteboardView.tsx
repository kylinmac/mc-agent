import {
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import {
  Excalidraw,
  exportToBlob,
  getNonDeletedElements,
  restoreElements,
} from "@excalidraw/excalidraw";
import "../../../node_modules/@excalidraw/excalidraw/dist/prod/index.css";
import type {
  AppState as ExcalidrawAppState,
  BinaryFileData,
  BinaryFiles,
  ExcalidrawImperativeAPI,
} from "@excalidraw/excalidraw/types";
import type { ExcalidrawElement, OrderedExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import {
  summarizeWhiteboardScene,
  type CanvasWhiteboardBinaryFile,
  type CanvasWhiteboardScene,
} from "@pi-desktop/shared";
import { IconArrowUp, IconCamera, IconX } from "../../components/icons";
import { api } from "../../lib/api";
import type { ComposerDraftFileReference } from "../../lib/composer-smart-stop";
import {
  whiteboardAttachment,
  type CanvasAttachment,
  type CanvasViewState,
} from "./canvas-model";
import { useToolbarFocusGroup } from "./use-toolbar-focusgroup";

// Point Excalidraw at local bundled fonts (`electron.vite.config.ts`) before first mount.
if (typeof window !== "undefined") {
  const win = window as Window & { EXCALIDRAW_ASSET_PATH?: string };
  if (!win.EXCALIDRAW_ASSET_PATH) {
    try {
      win.EXCALIDRAW_ASSET_PATH = new URL("./excalidraw-assets/", window.location.href).href;
    } catch {
      win.EXCALIDRAW_ASSET_PATH = "./excalidraw-assets/";
    }
  }
}

function resolveExcalidrawLang(lang: string): string {
  const normalized = lang.trim();
  if (normalized.startsWith("zh-TW") || normalized.startsWith("zh-HK")) return "zh-TW";
  if (normalized.startsWith("zh")) return "zh-CN";
  if (normalized.startsWith("pt")) return "pt-BR";
  const prefix = normalized.split("-")[0] ?? "en";
  const map: Record<string, string> = {
    de: "de-DE",
    es: "es-ES",
    fr: "fr-FR",
    ko: "ko-KR",
    tr: "tr-TR",
  };
  return map[prefix] ?? "en";
}

function currentDocumentTheme(): "dark" | "light" {
  if (typeof document === "undefined") return "dark";
  return document.documentElement.dataset.theme === "light" ? "light" : "dark";
}

function sceneFingerprint(elements: readonly ExcalidrawElement[], bg?: string): string {
  const active = elements.filter((el) => !el.isDeleted);
  return `${bg ?? ""}|${active.map((el) => `${el.id}:${el.version}:${el.versionNonce}`).join(",")}`;
}

async function blobToBase64(blob: Blob): Promise<string> {
  const buf = await blob.arrayBuffer();
  const bytes = new Uint8Array(buf);
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function expandSelectedWithBoundText(
  allActive: readonly ExcalidrawElement[],
  selectedIds: ReadonlySet<string>,
): ExcalidrawElement[] {
  const picked = allActive.filter(
    (el) =>
      selectedIds.has(el.id) ||
      ("containerId" in el && typeof el.containerId === "string" && selectedIds.has(el.containerId)),
  );
  return picked;
}

export default function WhiteboardView({
  groupId,
  canvasId,
  sessionId,
  head,
  onViewState,
  onAttach,
  onSendWhiteboard,
}: {
  groupId: string;
  canvasId: string;
  sessionId: string;
  head?: ReactNode;
  onViewState: (state: CanvasViewState | null) => void;
  onAttach: (attachment: CanvasAttachment) => void;
  onSendWhiteboard: (attachment: CanvasAttachment) => Promise<void>;
}) {
  const { t, i18n } = useTranslation();
  const toolbarRef = useRef<HTMLDivElement | null>(null);
  useToolbarFocusGroup(toolbarRef);

  const [excalidrawApi, setExcalidrawApi] = useState<ExcalidrawImperativeAPI | null>(null);
  const [theme, setTheme] = useState<"dark" | "light">(currentDocumentTheme);
  const [loadedInitial, setLoadedInitial] = useState<{
    title: string;
    version: number;
    elements: ExcalidrawElement[];
    files: BinaryFiles;
    viewBackgroundColor?: string;
  } | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [liveAnnouncement, setLiveAnnouncement] = useState("");
  const [busyAction, setBusyAction] = useState(false);
  const [counts, setCounts] = useState<{ total: number; selectedIds: string[] }>({
    total: 0,
    selectedIds: [],
  });
  const [canvasVersion, setCanvasVersion] = useState<number>(1);

  const localVersionRef = useRef<number>(1);
  const titleRef = useRef<string>("");
  const savedFingerprintRef = useRef<string>("");
  const knownFileIdsRef = useRef<Set<string>>(new Set());
  const pendingSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latestSceneRef = useRef<{
    elements: readonly ExcalidrawElement[];
    viewBackgroundColor?: string;
    gridSize?: number | null;
    files: BinaryFiles;
  } | null>(null);
  const saveQueueRef = useRef<Promise<void>>(Promise.resolve());

  // Keep Excalidraw theme synced with `<html data-theme="...">`.
  useEffect(() => {
    if (typeof document === "undefined" || typeof MutationObserver === "undefined") return;
    const sync = () => setTheme(currentDocumentTheme());
    sync();
    const observer = new MutationObserver(sync);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });
    return () => observer.disconnect();
  }, []);

  const syncPreviewOnly = useCallback(
    async (
      expectedVersion: number,
      activeElements: readonly ExcalidrawElement[],
      files: BinaryFiles,
      isCancelled?: () => boolean,
    ) => {
      try {
        let previewPngBase64 = "";
        if (activeElements.length > 0) {
          const blob = await exportToBlob({
            elements: activeElements,
            appState: {
              exportBackground: true,
              exportWithDarkMode: false,
              viewBackgroundColor: "#ffffff",
            },
            files,
            mimeType: "image/png",
            maxWidthOrHeight: 1600,
            exportPadding: 24,
          });
          previewPngBase64 = await blobToBase64(blob);
        }
        if (isCancelled?.() || localVersionRef.current !== expectedVersion) return;
        await api.canvas.call("canvas.whiteboard.savePreview", {
          groupId,
          canvasId,
          baseVersion: expectedVersion,
          previewPngBase64,
        });
      } catch {
        // Best-effort preview refresh without bumping canvas version.
      }
    },
    [groupId, canvasId],
  );

  // Load initial scene + embedded image files from host-core.
  useEffect(() => {
    let active = true;
    setLoadedInitial(null);
    setLoadError(null);
    knownFileIdsRef.current = new Set();

    void api.canvas
      .call("canvas.whiteboard.get", { groupId, canvasId, includeFiles: true })
      .then((res) => {
        if (!active) return;
        localVersionRef.current = res.canvas.version;
        setCanvasVersion(res.canvas.version);
        titleRef.current = res.canvas.title;
        const restored = restoreElements(
          (res.scene.elements ?? []) as unknown as ExcalidrawElement[],
          null,
        );
        const binaryFiles: BinaryFiles = {};
        for (const [id, file] of Object.entries(res.files ?? {})) {
          knownFileIdsRef.current.add(id);
          binaryFiles[id] = {
            id: file.id as BinaryFileData["id"],
            mimeType: file.mimeType as BinaryFileData["mimeType"],
            dataURL: file.dataURL as BinaryFileData["dataURL"],
            created: file.created ?? Date.now(),
          };
        }
        const bg = res.scene.appState?.viewBackgroundColor;
        savedFingerprintRef.current = sceneFingerprint(restored, bg);
        const nonDeleted = getNonDeletedElements(restored);
        setCounts({ total: nonDeleted.length, selectedIds: [] });
        setLoadedInitial({
          title: res.canvas.title,
          version: res.canvas.version,
          elements: restored,
          files: binaryFiles,
          viewBackgroundColor: bg,
        });
        if (!res.hasPreview && nonDeleted.length > 0) {
          void syncPreviewOnly(res.canvas.version, nonDeleted, binaryFiles, () => !active);
        }
      })
      .catch((err) => {
        if (!active) return;
        setLoadError(err instanceof Error ? err.message : String(err));
      });

    return () => {
      active = false;
    };
  }, [groupId, canvasId, syncPreviewOnly]);

  const persistNow = useCallback(
    (withPreview: boolean): Promise<void> => {
      const snapshot = latestSceneRef.current;
      if (!snapshot) return saveQueueRef.current;
      const activeElements = getNonDeletedElements(snapshot.elements);
      const fp = sceneFingerprint(activeElements, snapshot.viewBackgroundColor);
      if (fp === savedFingerprintRef.current) return saveQueueRef.current;

      const referencedIds = new Set<string>();
      for (const el of activeElements) {
        if (el.type === "image" && "fileId" in el && typeof el.fileId === "string") {
          referencedIds.add(el.fileId);
        }
      }
      const upsertedFiles: Record<string, CanvasWhiteboardBinaryFile> = {};
      for (const fileId of referencedIds) {
        if (knownFileIdsRef.current.has(fileId)) continue;
        const fileData = snapshot.files[fileId];
        if (fileData?.dataURL && fileData.mimeType) {
          upsertedFiles[fileId] = {
            id: fileId,
            mimeType: fileData.mimeType,
            dataURL: fileData.dataURL,
            created: fileData.created,
          };
        }
      }

      const task = async () => {
        let previewPngBase64: string | undefined;
        if (withPreview) {
          if (activeElements.length === 0) {
            previewPngBase64 = "";
          } else {
            try {
              const blob = await exportToBlob({
                elements: activeElements,
                appState: {
                  exportBackground: true,
                  exportWithDarkMode: false,
                  viewBackgroundColor: "#ffffff",
                },
                files: snapshot.files,
                mimeType: "image/png",
                maxWidthOrHeight: 1600,
                exportPadding: 24,
              });
              previewPngBase64 = await blobToBase64(blob);
            } catch {
              previewPngBase64 = undefined;
            }
          }
        }

        const scenePayload: CanvasWhiteboardScene = {
          elements: activeElements as unknown as Record<string, unknown>[],
          appState: {
            viewBackgroundColor: snapshot.viewBackgroundColor ?? "#ffffff",
            gridSize: snapshot.gridSize ?? null,
          },
        };
        const saved = await api.canvas.call("canvas.whiteboard.save", {
          groupId,
          canvasId,
          scene: scenePayload,
          ...(Object.keys(upsertedFiles).length ? { upsertedFiles } : {}),
          ...(previewPngBase64 !== undefined ? { previewPngBase64 } : {}),
        });
        localVersionRef.current = saved.canvas.version;
        setCanvasVersion(saved.canvas.version);
        titleRef.current = saved.canvas.title;
        savedFingerprintRef.current = fp;
        // Keep knownFileIds strictly synced to active referenced files so if an
        // image was deleted (GC'd on disk) and later restored via Undo, the next
        // save re-uploads `upsertedFiles[fileId]` instead of losing the image.
        knownFileIdsRef.current = new Set(referencedIds);
      };

      saveQueueRef.current = saveQueueRef.current.then(task, task).catch((err) => {
        setNotice(err instanceof Error ? err.message : String(err));
      });
      return saveQueueRef.current;
    },
    [groupId, canvasId],
  );

  // Flush any pending unsaved strokes when switching tabs or closing.
  useEffect(() => {
    return () => {
      if (pendingSaveTimerRef.current) {
        clearTimeout(pendingSaveTimerRef.current);
        pendingSaveTimerRef.current = null;
        persistNow(false);
      }
      onViewState(null);
    };
  }, [persistNow, onViewState]);

  // Reload live when the Agent writes to this whiteboard (`CanvasWrite` -> `canvasChanged`).
  useEffect(() => {
    let disposed = false;
    const unsubscribe = api.canvas.onChanged((change) => {
      if (disposed || change.groupId !== groupId || change.canvasId !== canvasId) return;
      void api.canvas
        .call("canvas.whiteboard.get", { groupId, canvasId, includeFiles: true })
        .then(async (res) => {
          if (disposed || res.canvas.version === localVersionRef.current) return;
          if (pendingSaveTimerRef.current) {
            clearTimeout(pendingSaveTimerRef.current);
            pendingSaveTimerRef.current = null;
          }
          localVersionRef.current = res.canvas.version;
          setCanvasVersion(res.canvas.version);
          titleRef.current = res.canvas.title;
          const restored = restoreElements(
            (res.scene.elements ?? []) as unknown as ExcalidrawElement[],
            null,
          );
          const addedFiles: BinaryFileData[] = [];
          const mergedFiles: BinaryFiles = { ...(excalidrawApi?.getFiles() ?? {}) };
          const nextKnown = new Set<string>();
          for (const [id, file] of Object.entries(res.files ?? {})) {
            nextKnown.add(id);
            const bf: BinaryFileData = {
              id: file.id as BinaryFileData["id"],
              mimeType: file.mimeType as BinaryFileData["mimeType"],
              dataURL: file.dataURL as BinaryFileData["dataURL"],
              created: file.created ?? Date.now(),
            };
            mergedFiles[id] = bf;
            addedFiles.push(bf);
          }
          knownFileIdsRef.current = nextKnown;
          savedFingerprintRef.current = sceneFingerprint(
            restored,
            res.scene.appState?.viewBackgroundColor,
          );
          const nonDeleted = getNonDeletedElements(restored);
          setCounts((prev) => ({ ...prev, total: nonDeleted.length }));
          if (excalidrawApi) {
            if (addedFiles.length) excalidrawApi.addFiles(addedFiles);
            excalidrawApi.updateScene({ elements: restored });
            if (nonDeleted.length > 0) {
              excalidrawApi.scrollToContent(nonDeleted, { fitToViewport: true });
            }
            // Refresh preview.png via `savePreview` (NEVER bumps `canvas.version`,
            // preventing CONFLICT on back-to-back Agent `CanvasWrite` calls).
            await syncPreviewOnly(res.canvas.version, nonDeleted, mergedFiles, () => disposed);
          }
        })
        .catch(() => {
          // Next change or manual reload resyncs.
        });
    });
    return () => {
      disposed = true;
      unsubscribe();
    };
  }, [groupId, canvasId, excalidrawApi, syncPreviewOnly]);

  // Keep lightweight view state synced for `CanvasContextBar` (zero image payload).
  useEffect(() => {
    if (!loadedInitial) return;
    onViewState({
      canvasId,
      title: titleRef.current || loadedInitial.title,
      kind: "whiteboard",
      version: canvasVersion,
      visibleBoards: [],
      selectedBoards: [],
      selected: [],
      errored: [],
      dirty: false,
      whiteboardElementCount: counts.total,
      whiteboardSelectedIds: counts.selectedIds,
    });
  }, [canvasId, canvasVersion, counts.selectedIds, counts.total, loadedInitial, onViewState]);

  const handleSceneChange = useCallback(
    (
      elements: readonly OrderedExcalidrawElement[],
      appState: ExcalidrawAppState,
      files: BinaryFiles,
    ) => {
      const active = getNonDeletedElements(elements);
      const selectedIds = Object.entries(appState.selectedElementIds ?? {})
        .filter(([, on]) => Boolean(on))
        .map(([id]) => id)
        .filter((id) => active.some((el) => el.id === id && !("containerId" in el && el.containerId)));

      setCounts((prev) =>
        prev.total === active.length &&
        prev.selectedIds.length === selectedIds.length &&
        prev.selectedIds.every((id, idx) => id === selectedIds[idx])
          ? prev
          : { total: active.length, selectedIds },
      );

      latestSceneRef.current = {
        elements,
        viewBackgroundColor: appState.viewBackgroundColor,
        gridSize: appState.gridSize ?? null,
        files,
      };

      const fp = sceneFingerprint(active, appState.viewBackgroundColor);
      if (fp === savedFingerprintRef.current) return;

      if (pendingSaveTimerRef.current) clearTimeout(pendingSaveTimerRef.current);
      pendingSaveTimerRef.current = setTimeout(() => {
        pendingSaveTimerRef.current = null;
        persistNow(true);
      }, 650);
    },
    [persistNow],
  );

  const shareSnapshot = async (queueToChat: boolean) => {
    if (busyAction || !excalidrawApi) return;
    const allActive = getNonDeletedElements(excalidrawApi.getSceneElements());
    if (allActive.length === 0) {
      const msg = t("mcProject.canvasWhiteboardEmptyNotice");
      setNotice(msg);
      setLiveAnnouncement(msg);
      return;
    }

    const appState = excalidrawApi.getAppState();
    const files = excalidrawApi.getFiles();
    const rawSelectedIds = new Set(
      Object.entries(appState.selectedElementIds ?? {})
        .filter(([, on]) => Boolean(on))
        .map(([id]) => id),
    );
    const selectedElements =
      rawSelectedIds.size > 0 ? expandSelectedWithBoundText(allActive, rawSelectedIds) : [];
    const scope: "selection" | "all" = selectedElements.length > 0 ? "selection" : "all";
    const targetElements = scope === "selection" ? selectedElements : allActive;

    setBusyAction(true);
    try {
      // Flush latest scene first so disk state matches what we hand to the Agent.
      if (pendingSaveTimerRef.current) {
        clearTimeout(pendingSaveTimerRef.current);
        pendingSaveTimerRef.current = null;
      }
      await persistNow(true);

      const blob = await exportToBlob({
        elements: targetElements,
        appState: {
          exportBackground: true,
          exportWithDarkMode: false,
          viewBackgroundColor: "#ffffff",
        },
        files,
        mimeType: "image/png",
        maxWidthOrHeight: 1920,
        exportPadding: 24,
      });
      const arrayBuffer = await blob.arrayBuffer();
      const fileName = `whiteboard-${canvasId}-${scope}.png`;
      const pasted = await api.pasteFiles(sessionId, [
        {
          name: fileName,
          mimeType: "image/png",
          data: arrayBuffer,
        },
      ]);
      const staged = pasted.files[0];
      const imageFile: ComposerDraftFileReference | undefined = staged
        ? {
            path: staged.path,
            name: staged.name,
            kind: "image",
            mimeType: staged.mimeType ?? "image/png",
          }
        : undefined;

      const summary = summarizeWhiteboardScene(
        { elements: allActive as unknown as Record<string, unknown>[] },
        scope === "selection" ? { onlyIds: rawSelectedIds } : undefined,
      );
      const attachment = whiteboardAttachment({
        canvasId,
        title: titleRef.current || loadedInitial?.title || canvasId,
        scope,
        summary,
        imageFile,
      });

      if (queueToChat) {
        onAttach(attachment);
        const msg = t("mcProject.canvasWhiteboardAttachedNotice");
        setLiveAnnouncement(msg);
      } else {
        await onSendWhiteboard(attachment);
        setLiveAnnouncement(t("mcProject.canvasSentToAgent"));
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setNotice(msg);
      setLiveAnnouncement(msg);
    } finally {
      setBusyAction(false);
    }
  };

  const langCode = useMemo(() => resolveExcalidrawLang(i18n.language || "en"), [i18n.language]);
  const uiOptions = useMemo(
    () => ({
      tools: { image: true },
      canvasActions: {
        changeViewBackgroundColor: true,
        clearCanvas: true,
        loadScene: true,
        saveToActiveFile: false,
        saveAsImage: true,
        toggleTheme: null,
      },
    }),
    [],
  );

  const selectedCount = counts.selectedIds.length;

  return (
    <div className="mc-canvas mc-whiteboard-root">
      <div
        ref={toolbarRef}
        className="mc-canvas-toolbar"
        role="toolbar"
        aria-label={t("mcProject.canvasSection")}
        {...({ focusgroup: "toolbar wrap" } as Record<string, string>)}
      >
        <div className="mc-canvas-toolbar-group" role="group" aria-label={t("mcProject.canvasSection")}>
          {head}
        </div>
        <span className="mc-canvas-toolbar-spacer" />
        <span className="mc-whiteboard-meta" aria-hidden="true">
          {selectedCount > 0
            ? t("mcProject.canvasWhiteboardSelected", { count: selectedCount })
            : t("mcProject.canvasWhiteboardElements", { count: counts.total })}
        </span>
        <span className="mc-canvas-toolbar-sep" role="separator" aria-orientation="vertical" />
        <div className="mc-canvas-toolbar-group" role="group" aria-label={t("mcProject.canvasSendToAgent")}>
          <button
            type="button"
            className="mc-canvas-tool mc-canvas-tool-wide"
            aria-disabled={busyAction || counts.total === 0 ? "true" : undefined}
            title={
              selectedCount > 0
                ? t("mcProject.canvasAttachSelection", { count: selectedCount })
                : t("mcProject.canvasAttachWhiteboard")
            }
            onClick={() => {
              if (busyAction || counts.total === 0) return;
              void shareSnapshot(true);
            }}
          >
            <IconCamera size={13} />
            <span>
              {selectedCount > 0
                ? t("mcProject.canvasAttachSelection", { count: selectedCount })
                : t("mcProject.canvasAttachWhiteboard")}
            </span>
          </button>
          <button
            type="button"
            className="mc-canvas-tool mc-canvas-tool-wide mc-whiteboard-send-btn"
            aria-disabled={busyAction || counts.total === 0 ? "true" : undefined}
            title={
              selectedCount > 0
                ? t("mcProject.canvasSendSelectionToAgent")
                : t("mcProject.canvasSendToAgent")
            }
            onClick={() => {
              if (busyAction || counts.total === 0) return;
              void shareSnapshot(false);
            }}
          >
            <IconArrowUp size={13} />
            <span>
              {selectedCount > 0
                ? t("mcProject.canvasSendSelectionToAgent")
                : t("mcProject.canvasSendToAgent")}
            </span>
          </button>
        </div>
      </div>

      <p role="status" className="sr-only">
        {liveAnnouncement}
      </p>

      <div className="mc-whiteboard-stage">
        {loadError ? (
          <p className="mc-canvas-error mc-canvas-hint">{loadError}</p>
        ) : loadedInitial ? (
          <Excalidraw
            excalidrawAPI={setExcalidrawApi}
            initialData={{
              elements: loadedInitial.elements,
              files: loadedInitial.files,
              appState: {
                viewBackgroundColor: loadedInitial.viewBackgroundColor ?? "#ffffff",
              },
              scrollToContent: loadedInitial.elements.length > 0,
            }}
            onChange={handleSceneChange}
            theme={theme}
            langCode={langCode}
            UIOptions={uiOptions}
            handleKeyboardGlobally={false}
            aiEnabled={false}
          />
        ) : null}
      </div>

      {notice ? (
        <div className="mc-canvas-notice" role="status">
          <span>{notice}</span>
          <button type="button" aria-label={t("mcProject.canvasClose")} onClick={() => setNotice(null)}>
            <IconX size={12} />
          </button>
        </div>
      ) : null}
    </div>
  );
}
