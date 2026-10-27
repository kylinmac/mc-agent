import { CANVAS_RENDERER_METHODS, ErrorCodes, IPC } from "@pi-desktop/shared";
import type { HostProcess } from "../host-process";
import type { IpcRegistrar } from "./types";
import { onCanvasChanged } from "../canvas/canvas-tools";

/**
 * mc-agent prototype canvas IPC (docs/mc-agent/prototype-canvas.md). Records
 * live in host-core (`canvas.*`); the renderer reaches only the methods that
 * act for the user, never the `agent…` ones.
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
}
