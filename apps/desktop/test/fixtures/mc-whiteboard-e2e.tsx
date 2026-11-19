import { useState } from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import { catalogs, flattenCatalog } from "@pi-desktop/i18n";
import {
  applyWhiteboardOpsToScene,
  type Canvas,
  type CanvasChangeEvent,
  type CanvasWhiteboardBinaryFile,
  type CanvasWhiteboardScene,
} from "@pi-desktop/shared";
import { CanvasTab } from "../../src/features/canvas/CanvasTab";
import { CanvasContextBar } from "../../src/features/canvas/CanvasContextBar";
import { WorkPanelQuickTools } from "../../src/features/work-tools/WorkPanelQuickTools";
import {
  prepareCanvasSubmission,
  sentView,
  useCanvasSession,
} from "../../src/features/canvas/canvas-session";
import { api } from "../../src/lib/api";
import { useAppStore } from "../../src/stores/app-store";
import "tailwindcss/preflight.css";
import "../../src/styles/tokens.css";
import "../../src/styles/base.css";
import "../../src/styles/ui-kit.css";
import "../../src/features/canvas/canvas.css";

const settle = (ms = 40) => new Promise((resolve) => setTimeout(resolve, ms));
function check(ok: unknown, message: string): asserts ok {
  if (!ok) throw new Error(message);
}
async function until(predicate: () => unknown, label: string, maxSteps = 200) {
  for (let n = 0; n < maxSteps; n++) {
    if (predicate()) return;
    await settle(35);
  }
  throw new Error(`Timed out waiting for: ${label}`);
}

await i18n.use(initReactI18next).init({
  lng: "zh-CN",
  keySeparator: false,
  resources: { "zh-CN": { translation: flattenCatalog(catalogs["zh-CN"]) } },
  interpolation: { escapeValue: false },
});

(window as unknown as { piDesktop: Record<string, unknown> }).piDesktop = { platform: "darwin" };

// Create a real tiny PNG dataUrl via HTMLCanvasElement for `canvasCaptureRect`
const tinyCanvas = document.createElement("canvas");
tinyCanvas.width = 48;
tinyCanvas.height = 32;
const tinyCtx = tinyCanvas.getContext("2d")!;
tinyCtx.fillStyle = "#2563eb";
tinyCtx.fillRect(0, 0, 48, 32);
const capturedArtboardPngDataUrl = tinyCanvas.toDataURL("image/png");

// In-memory canvas store backing `api.canvas`
type StoredRecord = {
  canvas: Canvas;
  scene: CanvasWhiteboardScene;
  files: Record<string, CanvasWhiteboardBinaryFile>;
  previewPngBase64?: string;
  boardHtml?: Record<string, string>;
};

const store = new Map<string, StoredRecord>();
const changeListeners = new Set<(change: CanvasChangeEvent) => void>();
const emitCanvasChanged = (change: CanvasChangeEvent) => {
  for (const fn of changeListeners) fn(change);
};

const createCalls: Array<{ groupId: string; title: string; kind?: string }> = [];
const pastedUploads: Array<{ sessionId: string; name: string; mimeType: string; byteLength: number }> = [];
let nextIdSeq = 1;

api.canvas = {
  call: (async (method: string, params: Record<string, unknown>) => {
    const groupId = String(params.groupId ?? "");
    const canvasId = String(params.canvasId ?? "");
    const key = `${groupId}::${canvasId}`;

    if (method === "canvas.list") {
      const canvases = [...store.entries()]
        .filter(([k]) => k.startsWith(`${groupId}::`))
        .map(([, rec]) => ({
          id: rec.canvas.id,
          title: rec.canvas.title,
          kind: rec.canvas.kind ?? "prototype",
          version: rec.canvas.version,
          updatedAt: rec.canvas.updatedAt,
          boards: rec.canvas.elements.filter((e) => e.type === "frame").length,
          path: `/mock/${groupId}/${rec.canvas.id}`,
        }))
        .sort((a, b) => b.updatedAt - a.updatedAt);
      return { canvases };
    }

    if (method === "canvas.create") {
      const kind = params.kind === "whiteboard" ? "whiteboard" : "prototype";
      const id = `${kind === "whiteboard" ? "w" : "c"}_${nextIdSeq++}`;
      const title = String(params.title ?? "Untitled");
      createCalls.push({ groupId, title, kind: params.kind as string | undefined });
      const now = Date.now();
      const created: Canvas = {
        format: 1,
        id,
        title,
        kind,
        version: 1,
        createdAt: now,
        updatedAt: now,
        elements: [],
      };
      store.set(`${groupId}::${id}`, {
        canvas: created,
        scene: { elements: [], appState: { viewBackgroundColor: "#ffffff" } },
        files: {},
      });
      return { canvas: created };
    }

    if (method === "canvas.get") {
      const rec = store.get(key);
      if (!rec) throw new Error(`Canvas not found: ${key}`);
      return { canvas: rec.canvas };
    }

    if (method === "canvas.comments.list") {
      return { comments: { format: 1, threads: [] } };
    }

    if (method === "canvas.boardDocument") {
      const rec = store.get(key);
      const boardId = String(params.boardId ?? "");
      const html =
        rec?.boardHtml?.[boardId] ??
        '<!doctype html><html><body style="margin:0;padding:24px;font-family:sans-serif"><h1 data-mc-tid="1">Login Prototype</h1></body></html>';
      return { html, rev: 1 };
    }

    if (method === "canvas.whiteboard.get") {
      const rec = store.get(key);
      if (!rec) throw new Error(`Whiteboard not found: ${key}`);
      return {
        canvas: rec.canvas,
        scene: rec.scene,
        ...(params.includeFiles ? { files: rec.files } : {}),
        hasPreview: Boolean(rec.previewPngBase64),
      };
    }

    if (method === "canvas.whiteboard.save") {
      const rec = store.get(key);
      if (!rec) throw new Error(`Whiteboard not found: ${key}`);
      rec.scene = (params.scene as CanvasWhiteboardScene) ?? rec.scene;
      const upserted = (params.upsertedFiles as Record<string, CanvasWhiteboardBinaryFile> | undefined) ?? {};
      for (const [fid, fval] of Object.entries(upserted)) {
        rec.files[fid] = fval;
      }
      if (typeof params.previewPngBase64 === "string") {
        rec.previewPngBase64 = params.previewPngBase64 || undefined;
      } else {
        rec.previewPngBase64 = undefined;
      }
      rec.canvas = {
        ...rec.canvas,
        version: rec.canvas.version + 1,
        updatedAt: Date.now(),
      };
      return { canvas: rec.canvas };
    }

    if (method === "canvas.whiteboard.savePreview") {
      const rec = store.get(key);
      if (!rec) throw new Error(`Whiteboard not found: ${key}`);
      if (rec.canvas.version !== params.baseVersion) return { updated: false };
      const raw = String(params.previewPngBase64 ?? "");
      rec.previewPngBase64 = raw ? raw : undefined;
      return { updated: true };
    }

    throw new Error(`Unhandled mock canvas method: ${method}`);
  }) as typeof api.canvas.call,
  export: async () => ({ canceled: true }),
  captureRect: async () => ({ dataUrl: capturedArtboardPngDataUrl }),
  onChanged: (listener) => {
    changeListeners.add(listener);
    return () => {
      changeListeners.delete(listener);
    };
  },
};

api.pasteFiles = async (sessionId, files) => {
  const first = files[0];
  check(first, "pasteFiles receives exported file");
  pastedUploads.push({
    sessionId,
    name: first.name,
    mimeType: first.mimeType,
    byteLength: first.data.byteLength,
  });
  return {
    files: [
      {
        path: `/tmp/${first.name}`,
        name: first.name,
        mimeType: first.mimeType,
        size: first.data.byteLength,
      },
    ],
  };
};

// Temporary conversation WITHOUT `projectPath`!
const SESSION_ID = "temp-sess-1";
let setActiveCanvasTabId: ((id: string | undefined) => void) | null = null;

useAppStore.setState({
  activeSessionId: SESSION_ID,
  page: "chat",
  workspace: null,
  workPanelTabs: [],
  pluginViews: [],
  sessions: [{ id: SESSION_ID, title: "临时脑暴会话", source: "local" }] as never,
  openWorkPanelTab: ((descriptor: { id: string; kind?: string; resource?: string }) => {
    useAppStore.setState({ workPanelTabs: [descriptor as never] });
    setActiveCanvasTabId?.(descriptor.resource);
  }) as never,
});

function Harness() {
  const [canvasOpen, setCanvasOpen] = useState(false);
  const [canvasId, setCanvasId] = useState<string | undefined>(undefined);
  setActiveCanvasTabId = (id) => {
    setCanvasOpen(true);
    setCanvasId(id);
  };
  return (
    <div style={{ width: "100vw", height: "100vh", display: "flex", flexDirection: "column" }}>
      <div data-testid="quick-tools-slot" style={{ padding: "6px 12px" }}>
        <WorkPanelQuickTools />
      </div>
      <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
        {canvasOpen ? <CanvasTab canvasId={canvasId} /> : null}
      </div>
      <div data-testid="context-bar-slot">
        <CanvasContextBar sessionId={SESSION_ID} />
      </div>
    </div>
  );
}

const root = createRoot(document.getElementById("root")!);
flushSync(() => root.render(<Harness />));

(window as unknown as { whiteboardProbe: () => Promise<Record<string, unknown>> }).whiteboardProbe = async () => {
  // 1. In a temporary conversation (no `projectPath`), the real `WorkPanelQuickTools` Canvas button is enabled!
  const quickCanvasBtn = [...document.querySelectorAll<HTMLButtonElement>('[data-testid="quick-tools-slot"] button')].find(
    (b) => b.getAttribute("aria-label") === "画布" || b.textContent?.includes("画布"),
  );
  check(quickCanvasBtn, "WorkPanelQuickTools renders Canvas button");
  check(!quickCanvasBtn.disabled, "Canvas quick-tool button is enabled in standalone temporary conversation");
  quickCanvasBtn.click();

  await until(
    () => document.querySelector(".mc-canvas-empty-actions button"),
    "temporary session empty-state creation buttons",
  );
  const emptyButtons = [...document.querySelectorAll<HTMLButtonElement>(".mc-canvas-empty-actions button")].map(
    (b) => b.textContent?.trim() ?? "",
  );
  check(emptyButtons.some((txt) => txt.includes("新建白板草图")), `missing whiteboard create button: ${emptyButtons.join(", ")}`);
  check(emptyButtons.some((txt) => txt.includes("新建 HTML 原型")), `missing prototype create button: ${emptyButtons.join(", ")}`);

  // 2. Click "新建白板草图" -> creates session-scoped whiteboard & lazy-mounts real Excalidraw!
  const newWbBtn = [...document.querySelectorAll<HTMLButtonElement>(".mc-canvas-empty-actions button")].find((b) =>
    b.textContent?.includes("新建白板草图"),
  )!;
  newWbBtn.click();

  await until(
    () => document.querySelector(".mc-whiteboard-stage .excalidraw canvas"),
    "Excalidraw interactive canvas mounted inside WhiteboardView",
  );
  check(createCalls.length === 1, "expected 1 canvas.create call");
  check(createCalls[0].groupId === `session:${SESSION_ID}`, `unexpected groupId: ${createCalls[0].groupId}`);
  check(createCalls[0].kind === "whiteboard", "expected kind=whiteboard");

  // Verify accessible toolbar (`role="toolbar"` + `focusgroup="toolbar wrap"` + `aria-disabled="true"` when empty)
  const toolbar = document.querySelector<HTMLElement>('.mc-whiteboard-root [role="toolbar"]');
  check(toolbar, "whiteboard role=toolbar exists");
  check(toolbar.getAttribute("focusgroup") === "toolbar wrap", "toolbar has focusgroup='toolbar wrap'");
  const attachBtn = [...toolbar.querySelectorAll<HTMLButtonElement>("button")].find((b) =>
    b.textContent?.includes("附带到对话"),
  );
  check(attachBtn, "attach-to-chat button exists");
  check(attachBtn.getAttribute("aria-disabled") === "true", "empty whiteboard marks attach button aria-disabled=true");

  // Verify focusgroup / roving tabindex keyboard accessibility
  const nativeFocusGroup = "focusGroup" in HTMLElement.prototype;
  if (!nativeFocusGroup) {
    const firstStop = toolbar.querySelector<HTMLElement>('[tabindex="0"]');
    check(firstStop, "toolbar fallback initializes single roving tabindex=0 stop");
    const nonStops = toolbar.querySelectorAll<HTMLElement>('[tabindex="-1"]');
    check(nonStops.length >= 2, "other toolbar controls receive tabindex=-1");
    firstStop.focus();
    firstStop.dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true }));
    await settle();
    check(toolbar.contains(document.activeElement) && document.activeElement !== firstStop, "End key moves focus to last toolbar item");
  } else {
    attachBtn.focus();
    check(document.activeElement === attachBtn, "aria-disabled attach button remains keyboard focusable under native focusgroup");
  }

  // 3. Simulate Agent co-creation (`CanvasWrite` -> `applyWhiteboardOpsToScene` + `canvasChanged`)
  const wbRec = store.get(`session:${SESSION_ID}::w_1`)!;
  const applied = applyWhiteboardOpsToScene(wbRec.scene, [
    { op: "add", id: "login_box", type: "rectangle", x: 80, y: 100, w: 180, h: 80, label: "登录表单" },
    { op: "add", id: "auth_api", type: "ellipse", x: 380, y: 100, w: 160, h: 80, label: "Auth 服务" },
    { op: "add", id: "req_arrow", type: "arrow", startId: "login_box", endId: "auth_api", label: "POST /login" },
  ]);
  wbRec.scene = applied.scene;
  wbRec.canvas = { ...wbRec.canvas, version: wbRec.canvas.version + 1, updatedAt: Date.now() };
  emitCanvasChanged({ groupId: `session:${SESSION_ID}`, canvasId: "w_1" });

  await until(
    () => attachBtn.getAttribute("aria-disabled") !== "true" && Boolean(wbRec.previewPngBase64),
    "live Agent reload enables attach-to-chat button and refreshes previewPng via savePreview",
  );
  check(
    wbRec.canvas.version === 2,
    `savePreview must NOT bump canvas.version (expected 2, got ${wbRec.canvas.version})`,
  );
  const liveCtx = sentView(useCanvasSession.getState().sessions[SESSION_ID]);
  check(liveCtx?.kind === "whiteboard", "sentView reports kind=whiteboard");
  check((liveCtx?.whiteboardElementCount ?? 0) >= 3, `expected >=3 elements in sentView, got ${liveCtx?.whiteboardElementCount}`);

  // 4. Click "附带到对话" -> exports real PNG via Excalidraw `<canvas>`, shows chip in CanvasContextBar,
  //    keeps chip if send fails (before `commit()`), and spends chip only on `commit()`!
  attachBtn.click();
  await until(
    () =>
      [...document.querySelectorAll('[data-testid="context-bar-slot"] .mc-canvas-chip')].some((el) =>
        el.textContent?.includes("草图截图"),
      ),
    "CanvasContextBar renders attached whiteboard chip",
  );
  check(pastedUploads.length === 1, "expected 1 PNG upload via api.pasteFiles");
  check(pastedUploads[0].mimeType === "image/png", "exported mimeType is image/png");
  check(pastedUploads[0].byteLength > 200, `exported PNG is non-trivial (${pastedUploads[0].byteLength} bytes)`);

  const submission = prepareCanvasSubmission(
    SESSION_ID,
    "请保留我写的这段说明，并按箭头补齐鉴权错误处理",
    {
      text: "请保留我写的这段说明，并按箭头补齐鉴权错误处理",
      fileReferences: [{ path: "/tmp/existing-spec.md", name: "existing-spec.md", kind: "file" }],
    },
  );
  check(submission.content.endsWith("请保留我写的这段说明，并按箭头补齐鉴权错误处理"), "existing Composer draft text preserved");
  check(submission.content.includes("POST /login"), "structured arrow label summary included in prompt");
  check(submission.draft?.fileReferences.length === 2, "existing file attachment + staged whiteboard PNG both preserved");
  check(submission.draft?.fileReferences[0].path === "/tmp/existing-spec.md", "existing attachment kept first");
  check(submission.draft?.fileReferences[1].path.endsWith(".png"), "staged PNG appended to fileReferences");
  // Before `commit()`, chip MUST remain in CanvasContextBar (so a failed send never loses the attachment!)
  await settle();
  check(
    [...document.querySelectorAll('[data-testid="context-bar-slot"] .mc-canvas-chip')].some((el) =>
      el.textContent?.includes("草图截图"),
    ),
    "whiteboard snapshot chip survives until sendPrompt succeeds and calls commit()",
  );
  submission.commit();
  await settle();
  check(
    ![...document.querySelectorAll('[data-testid="context-bar-slot"] .mc-canvas-chip')].some((el) =>
      el.textContent?.includes("草图截图"),
    ),
    "whiteboard snapshot chip cleared after commit()",
  );

  // 5. Dual-mode coexistence: seed an HTML prototype canvas with 1 artboard, switch to it,
  //    and click "送入白板批注" (`Annotate on whiteboard`)!
  const now = Date.now();
  store.set(`session:${SESSION_ID}::c_proto`, {
    canvas: {
      format: 1,
      id: "c_proto",
      title: "登录页 HTML",
      kind: "prototype",
      version: 1,
      createdAt: now,
      updatedAt: now + 10,
      elements: [
        { id: "hero", type: "frame", title: "登录首屏", x: 40, y: 60, w: 390, h: 320, file: "frames/hero.html", rev: 1 },
      ],
    },
    scene: { elements: [] },
    files: {},
  });
  emitCanvasChanged({ groupId: `session:${SESSION_ID}`, canvasId: "c_proto" });
  setActiveCanvasTabId?.("c_proto");

  await until(
    () =>
      [...document.querySelectorAll<HTMLButtonElement>(".mc-canvas-strip-action")].find((b) =>
        b.textContent?.includes("送入白板批注"),
      ),
    "prototype artboard renders '送入白板批注' button",
  );
  const sendBoardBtn = [...document.querySelectorAll<HTMLButtonElement>(".mc-canvas-strip-action")].find((b) =>
    b.textContent?.includes("送入白板批注"),
  )!;
  sendBoardBtn.click();

  await until(
    () =>
      Boolean(document.querySelector(".mc-whiteboard-stage .excalidraw canvas")) &&
      Boolean(store.get(`session:${SESSION_ID}::w_1`)?.previewPngBase64),
    "clicking '送入白板批注' switches back to whiteboard view and auto-generates preview.png",
  );
  const updatedWb = store.get(`session:${SESSION_ID}::w_1`)!;
  const hasImageElement = updatedWb.scene.elements.some((el) => el.type === "image");
  check(hasImageElement, "prototype artboard image element added onto whiteboard scene");
  check(Object.keys(updatedWb.files).length === 1, "captured artboard PNG persisted in whiteboard files map");

  // Reset shared zustand state cleanly
  useCanvasSession.setState({ sessions: {} });

  return {
    passed: true,
    pngBytes: pastedUploads[0].byteLength,
    whiteboardElementsAfterAnnotate: updatedWb.scene.elements.length,
  };
};
