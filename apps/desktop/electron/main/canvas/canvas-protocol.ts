import { protocol, type CustomScheme } from "electron";
import { CANVAS_SCHEME, canvasLocationFromUrl } from "@pi-desktop/shared";
import { buildCanvasBoardDocument, buildCanvasErrorDocument, canvasResponseHeaders } from "./canvas-document";

/**
 * mc-agent prototype canvas: serve artboards (docs/mc-agent/prototype-canvas.md).
 * Like `pi-genui:`, the scheme is `standard` + `secure` only — no fetch, no
 * CORS — so nothing but a frame navigation can read it. Every request is
 * resolved through host-core against the project in the URL.
 */
export const CANVAS_SCHEME_PRIVILEGES: CustomScheme = {
  scheme: CANVAS_SCHEME,
  privileges: { standard: true, secure: true },
};

export type CanvasProtocolHost = {
  call<T>(method: string, params?: unknown, timeoutMs?: number): Promise<T>;
};

function html(document: string, status = 200): Response {
  return new Response(document, { status, headers: canvasResponseHeaders() });
}

/** Resolve one request; separated from Electron so it can be tested. */
export async function resolveCanvasRequest(input: {
  method: string;
  url: string;
  getHost: () => CanvasProtocolHost | null;
}): Promise<Response> {
  if (input.method !== "GET") return html(buildCanvasErrorDocument("not-found"), 405);
  const location = canvasLocationFromUrl(input.url);
  if (!location) return html(buildCanvasErrorDocument("not-found"), 404);
  const host = input.getHost();
  if (!host) return html(buildCanvasErrorDocument("unavailable"), 503);
  try {
    const { html: fragment } = await host.call<{ html: string; rev: number }>(
      "canvas.boardDocument",
      { groupId: location.groupId, canvasId: location.canvasId, boardId: location.boardId },
      5_000,
    );
    return html(buildCanvasBoardDocument(fragment));
  } catch {
    // Never echo a path or host message into the frame.
    return html(buildCanvasErrorDocument("not-found"), 404);
  }
}

/** Install once after ready; the host is looked up per request. */
export function installCanvasProtocol(input: { getHost: () => CanvasProtocolHost | null }): void {
  protocol.handle(CANVAS_SCHEME, (request) =>
    resolveCanvasRequest({ method: request.method, url: request.url, getHost: input.getHost }),
  );
}
