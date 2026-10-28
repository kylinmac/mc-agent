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
      html: true,
    });
    const window = BrowserWindow.fromWebContents(event.sender);
    const options = {
      defaultPath: join(app.getPath("downloads"), canvasExportFileName(canvas.title)),
      filters: [{ name: "HTML", extensions: ["html"] }],
    };
    const { canceled, filePath } = window
      ? await dialog.showSaveDialog(window, options)
      : await dialog.showSaveDialog(options);
    if (canceled || !filePath) return { canceled: true };
    await writeFile(filePath, buildCanvasExport(canvas, html ?? {}), "utf8");
    shell.showItemInFolder(filePath);
    return { path: filePath };
  });
}
