import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { app, BrowserWindow, dialog, shell } from "electron";
import { type Canvas, CANVAS_RENDERER_METHODS, ErrorCodes, IPC } from "@pi-desktop/shared";
import type { HostProcess } from "../host-process";
import type { IpcRegistrar } from "./types";
import { buildCanvasExport, canvasExportFileName } from "../canvas/canvas-export";
import { onCanvasChanged } from "../canvas/canvas-tools";

/**
 * mc-agent prototype canvas IPC (docs/mc-agent/prototype-canvas.md). Records
 * live in host-core (`canvas.*`); the renderer reaches only the methods that
 * act for the user, never the `agent…` ones. Export saves a canvas as one
 * HTML file where the user picks, then shows it in the file manager.
 */
export type McCanvasIpcDependencies = {
  registrar: IpcRegistrar;
  getHost: () => HostProcess | null;
  sendToRenderer: (channel: string, payload: unknown) => void;
};

const PASSTHROUGH: ReadonlySet<string> = new Set(CANVAS_RENDERER_METHODS);

function invalid(message: string): Error {
  return Object.assign(new Error(message), { errorCode: ErrorCodes.INVALID_ARGUMENT });
}

export function registerMcCanvasIpc({ registrar, getHost, sendToRenderer }: McCanvasIpcDependencies): void {
  // The agent changed a canvas or its comments: an open canvas reloads.
  onCanvasChanged((change) => sendToRenderer(IPC.event.canvasChanged, change));

  registrar.handle(IPC.invoke.canvasCall, async (input: { method?: unknown; params?: unknown } = {}) => {
    const method = typeof input?.method === "string" ? input.method : "";
    if (!PASSTHROUGH.has(method)) throw invalid(`not allowed: ${method || "(none)"}`);
    const params = input?.params && typeof input.params === "object" ? input.params : {};
    const host = getHost();
    if (!host) throw new Error("host unavailable");
    return host.call(method, params);
  });

  registrar.handleWithEvent(IPC.invoke.canvasExport, async (event, input: { groupId?: unknown; canvasId?: unknown } = {}) => {
    registrar.assertMainWindowSender(event);
    const groupId = typeof input?.groupId === "string" ? input.groupId : "";
    const canvasId = typeof input?.canvasId === "string" ? input.canvasId : "";
    if (!groupId || !canvasId) throw invalid("groupId and canvasId are required");
    const host = getHost();
    if (!host) throw new Error("host unavailable");
    const { canvas, html } = await host.call<{ canvas: Canvas; html: Record<string, string> | null }>("canvas.get", {
      groupId,
      canvasId,
      ...( { html: true } ),
    });
    const isWhiteboard = canvas.kind === "whiteboard";
    let previewBase64: string | null = null;
    if (isWhiteboard) {
      const preview = await host.call<{ dataBase64: string | null }>("canvas.whiteboard.preview", {
        groupId,
        canvasId,
      });
      previewBase64 = preview.dataBase64;
    }
    const baseName = canvasExportFileName(canvas.title).replace(/\.html$/i, "");
    const window = BrowserWindow.fromWebContents(event.sender);
    const options = isWhiteboard
      ? {
          defaultPath: join(app.getPath("downloads"), `${baseName}.${previewBase64 ? "png" : "excalidraw"}`),
          filters: [
            ...(previewBase64 ? [{ name: "PNG Image", extensions: ["png"] }] : []),
            { name: "Excalidraw JSON", extensions: ["excalidraw", "json"] },
            { name: "HTML", extensions: ["html"] },
          ],
        }
      : {
          defaultPath: join(app.getPath("downloads"), `${baseName}.html`),
          filters: [{ name: "HTML", extensions: ["html"] }],
        };
    const { canceled, filePath } = window
      ? await dialog.showSaveDialog(window, options)
      : await dialog.showSaveDialog(options);
    if (canceled || !filePath) return { canceled: true };
    if (isWhiteboard && filePath.toLowerCase().endsWith(".png") && previewBase64) {
      await writeFile(filePath, Buffer.from(previewBase64, "base64"));
    } else if (isWhiteboard && /\.(?:excalidraw|json)$/i.test(filePath)) {
      const loaded = await host.call<{
        scene: { elements: unknown[]; appState?: Record<string, unknown> };
        files: Record<string, unknown> | null;
      }>("canvas.whiteboard.get", { groupId, canvasId, includeFiles: true });
      const doc = {
        type: "excalidraw",
        version: 2,
        source: "mc-agent",
        elements: loaded.scene.elements,
        appState: loaded.scene.appState ?? { viewBackgroundColor: "#ffffff" },
        files: loaded.files ?? {},
      };
      await writeFile(filePath, JSON.stringify(doc, null, 2), "utf8");
    } else {
      await writeFile(filePath, buildCanvasExport(canvas, html ?? {}, previewBase64), "utf8");
    }
    shell.showItemInFolder(filePath);
    return { path: filePath };
  });

  registrar.handleWithEvent(
    IPC.invoke.canvasCaptureRect,
    async (event, input: { x?: unknown; y?: unknown; width?: unknown; height?: unknown } = {}) => {
      registrar.assertMainWindowSender(event);
      const rawX = typeof input?.x === "number" && Number.isFinite(input.x) ? input.x : 0;
      const rawY = typeof input?.y === "number" && Number.isFinite(input.y) ? input.y : 0;
      const rawW = typeof input?.width === "number" && Number.isFinite(input.width) ? input.width : 0;
      const rawH = typeof input?.height === "number" && Number.isFinite(input.height) ? input.height : 0;
      const x = Math.max(0, Math.round(rawX));
      const y = Math.max(0, Math.round(rawY));
      const right = Math.round(rawX + rawW);
      const bottom = Math.round(rawY + rawH);
      const width = right > x ? Math.min(4096, right - x) : 0;
      const height = bottom > y ? Math.min(4096, bottom - y) : 0;
      if (!width || !height) throw invalid("valid capture bounds required");
      const image = await event.sender.capturePage({ x, y, width, height });
      if (image.isEmpty()) return { dataUrl: null, width: 0, height: 0 };
      const size = image.getSize();
      return { dataUrl: image.toDataURL(), width: size.width, height: size.height };
    },
  );
}
