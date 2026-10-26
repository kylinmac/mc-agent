import { protocol, type CustomScheme } from "electron";
import { readFile, stat } from "node:fs/promises";
import { CANVAS_SCHEME, canvasAssetUrlPrefix, canvasLocationFromUrl, type CanvasLocation } from "@pi-desktop/shared";
import {
  buildCanvasBoardDocument,
  buildCanvasErrorDocument,
  canvasImageType,
  canvasResponseHeaders,
} from "./canvas-document";

/**
 * mc-agent creative canvas: serve artboards and the library images they name
 * (docs/mc-agent/creative-canvas.md). Like `pi-genui:`, the scheme is
 * `standard` + `secure` only — no fetch, no CORS — so nothing but a frame
 * navigation or an image load inside a frame can read it. Every request is
 * resolved through host-core against the project's current storage.
 */
export const CANVAS_SCHEME_PRIVILEGES: CustomScheme = {
  scheme: CANVAS_SCHEME,
  privileges: { standard: true, secure: true },
};

export type CanvasProtocolHost = {
  call<T>(method: string, params?: unknown, timeoutMs?: number): Promise<T>;
};

const MAX_IMAGE_BYTES = 40 * 1024 * 1024;

function html(document: string, status = 200): Response {
  return new Response(document, { status, headers: canvasResponseHeaders() });
}

/** Resolve one request; separated from Electron so it can be tested. */
export async function resolveCanvasRequest(input: {
  method: string;
  url: string;
  getHost: () => CanvasProtocolHost | null;
  readImage?: (path: string) => Promise<Uint8Array>;
}): Promise<Response> {
  if (input.method !== "GET") return html(buildCanvasErrorDocument("not-found"), 405);
  const location = canvasLocationFromUrl(input.url);
  if (!location) return html(buildCanvasErrorDocument("not-found"), 404);
  const host = input.getHost();
  if (!host) return html(buildCanvasErrorDocument("unavailable"), 503);
  return location.kind === "board"
    ? board(host, location)
    : asset(host, location, input.readImage ?? defaultReadImage);
}

async function board(host: CanvasProtocolHost, location: Extract<CanvasLocation, { kind: "board" }>) {
  try {
    const { html: fragment } = await host.call<{ html: string; rev: number }>(
      "creative.canvas.boardDocument",
      {
        groupId: location.groupId,
        canvasId: location.canvasId,
        boardId: location.boardId,
        assetUrlPrefix: canvasAssetUrlPrefix(location.groupId),
      },
      5_000,
    );
    return html(buildCanvasBoardDocument(fragment));
  } catch {
    // Never echo a path or host message into the frame.
    return html(buildCanvasErrorDocument("not-found"), 404);
  }
}

async function defaultReadImage(path: string): Promise<Uint8Array> {
  const info = await stat(path);
  if (!info.isFile() || info.size > MAX_IMAGE_BYTES) throw new Error("not an image file");
  return readFile(path);
}

async function asset(
  host: CanvasProtocolHost,
  location: Extract<CanvasLocation, { kind: "asset" }>,
  readImage: (path: string) => Promise<Uint8Array>,
) {
  const missing = () => new Response(null, { status: 404, headers: canvasResponseHeaders("text/plain") });
  try {
    // Only an asset of the project in the URL, still in its library.
    const { asset: found } = await host.call<{
      asset: { groupId: string; path: string; fileExists: boolean; removedAt?: number | null };
    }>("creative.assets.get", { groupId: location.groupId, assetId: location.assetId }, 5_000);
    if (found.groupId !== location.groupId || !found.fileExists || found.removedAt) return missing();
    const type = canvasImageType(found.path);
    if (!type) return missing();
    const bytes = await readImage(found.path);
    return new Response(Buffer.from(bytes), { status: 200, headers: canvasResponseHeaders(type) });
  } catch {
    return missing();
  }
}

/** Install once after ready; the host is looked up per request. */
export function installCanvasProtocol(input: { getHost: () => CanvasProtocolHost | null }): void {
  protocol.handle(CANVAS_SCHEME, (request) =>
    resolveCanvasRequest({ method: request.method, url: request.url, getHost: input.getHost }),
  );
}
