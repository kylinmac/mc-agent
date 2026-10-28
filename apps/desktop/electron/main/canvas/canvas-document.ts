import {
  CANVAS_ERROR_MESSAGE,
  CANVAS_KEY_MESSAGE,
  CANVAS_LEAVE_MESSAGE,
  CANVAS_MAX_ERROR_CHARS,
  CANVAS_MAX_ERRORS,
  CANVAS_PICK_MESSAGE,
  CANVAS_PICKED_MESSAGE,
  CANVAS_READY_MESSAGE,
  CANVAS_RECTS_MESSAGE,
  CANVAS_RECTS_REPLY_MESSAGE,
} from "@pi-desktop/shared";
import { GEN_UI_PERMISSIONS_POLICY } from "../gen-ui-document";

/**
 * mc-agent prototype canvas (docs/mc-agent/prototype-canvas.md): the shell
 * an artboard fragment is served in. Same isolation as gen-ui visualizations:
 * an opaque-origin sandbox, a CSP that blocks every network request, form,
 * frame and `<base>`, and no device permissions. Images are inline (`data:`)
 * or drawn (SVG, CSS).
 *
 * The runtime is the only host contact: it announces itself, reports script
 * and loading errors, reports Escape, drops its selection when the user leaves
 * it, and answers two questions from its parent — which numbered element is
 * at a point, and where some numbered elements are (both in the frame's
 * viewport pixels). It sends numbers and boxes, never text.
 */

export const CANVAS_CONTENT_SECURITY_POLICY = [
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  "img-src data: blob:",
  "font-src data:",
  "media-src data: blob:",
  "connect-src 'none'",
  "frame-src 'none'",
  "worker-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
  "webrtc 'block'",
].join("; ");

export function canvasResponseHeaders(contentType = "text/html; charset=utf-8"): Record<string, string> {
  return {
    "content-type": contentType,
    "content-security-policy": `${CANVAS_CONTENT_SECURITY_POLICY}; sandbox allow-scripts`,
    "permissions-policy": GEN_UI_PERMISSIONS_POLICY,
    "x-content-type-options": "nosniff",
    "cache-control": "no-store",
  };
}

const RUNTIME_SCRIPT = `(() => {
  const READY = ${JSON.stringify(CANVAS_READY_MESSAGE)};
  const PICK = ${JSON.stringify(CANVAS_PICK_MESSAGE)};
  const PICKED = ${JSON.stringify(CANVAS_PICKED_MESSAGE)};
  const RECTS = ${JSON.stringify(CANVAS_RECTS_MESSAGE)};
  const RECTS_REPLY = ${JSON.stringify(CANVAS_RECTS_REPLY_MESSAGE)};
  const ERROR = ${JSON.stringify(CANVAS_ERROR_MESSAGE)};
  const KEY = ${JSON.stringify(CANVAS_KEY_MESSAGE)};
  const LEAVE = ${JSON.stringify(CANVAS_LEAVE_MESSAGE)};
  const MAX_CHARS = ${CANVAS_MAX_ERROR_CHARS};
  const MAX_ERRORS = ${CANVAS_MAX_ERRORS};
  const post = (message) => parent.postMessage(message, "*");
  const box = (element) => {
    const rect = element.getBoundingClientRect();
    return { x: rect.left, y: rect.top, w: rect.width, h: rect.height };
  };
  const numbered = (element) => {
    const hit = element && element.closest ? element.closest("[data-mc-node]") : null;
    if (!hit) return null;
    const node = Number(hit.getAttribute("data-mc-node"));
    return Number.isInteger(node) ? { node, rect: box(hit) } : null;
  };
  addEventListener("message", (event) => {
    if (event.source !== parent) return;
    const data = event.data;
    if (!data || typeof data !== "object") return;
    if (data.type === LEAVE) {
      const selection = getSelection();
      if (selection) selection.removeAllRanges();
      if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
      return;
    }
    if (data.type === PICK) {
      const x = Number(data.x);
      const y = Number(data.y);
      if (!Number.isFinite(x) || !Number.isFinite(y)) return;
      post({ type: PICKED, seq: Number(data.seq) || 0, hit: numbered(document.elementFromPoint(x, y)) });
      return;
    }
    if (data.type === RECTS) {
      const nodes = Array.isArray(data.nodes) ? data.nodes.slice(0, 500) : [];
      const rects = {};
      for (const node of nodes) {
        if (!Number.isInteger(node)) continue;
        const element = document.querySelector('[data-mc-node="' + node + '"]');
        if (element) rects[node] = box(element);
      }
      post({ type: RECTS_REPLY, seq: Number(data.seq) || 0, rects });
    }
  });
  let errors = 0;
  const report = (message) => {
    if (errors >= MAX_ERRORS) return;
    errors += 1;
    post({ type: ERROR, message: String(message || "error").slice(0, MAX_CHARS) });
  };
  addEventListener("error", (event) => {
    const target = event.target;
    if (target && target !== window && target.tagName) {
      report("could not load <" + String(target.tagName).toLowerCase() + ">");
      return;
    }
    const where = event.lineno ? " (line " + event.lineno + ")" : "";
    report((event.message || "script error") + where);
  }, true);
  addEventListener("unhandledrejection", (event) => {
    const reason = event.reason;
    report("unhandled promise rejection: " + (reason && reason.message ? reason.message : String(reason)));
  });
  addEventListener("keydown", (event) => {
    if (event.key === "Escape") post({ type: KEY, key: "Escape" });
  });
  post({ type: READY });
})();`;

/** A white page by default, like a design tool's artboard. */
const SHELL_CSS = `:root { color-scheme: light; }
html, body { margin: 0; height: 100%; background: #fff; color: #111; }
body { font: 14px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }`;

export function escapeAttribute(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function shell(head: string, body: string, runtime = true): string {
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${escapeAttribute(CANVAS_CONTENT_SECURITY_POLICY)}">
<style>${SHELL_CSS}</style>
${runtime ? `<script>${RUNTIME_SCRIPT}</script>` : ""}
${head}
</head>
<body>
${body}
</body>
</html>
`;
}

/** Wrap an annotated artboard fragment (host-core numbered it). */
export function buildCanvasBoardDocument(fragment: string): string {
  return shell("", fragment);
}

/** An artboard's own source in the same shell, without the host runtime (for export). */
export function buildCanvasStandaloneBoard(fragment: string): string {
  return shell("", fragment, false);
}

/**
 * A fixed page for a board that cannot be shown. It embeds no caller text
 * and reports itself through the same error channel.
 */
export function buildCanvasErrorDocument(code: "not-found" | "unavailable"): string {
  const message = code === "not-found" ? "This artboard was not found." : "This artboard is not available right now.";
  return shell(
    `<script>parent.postMessage(${JSON.stringify({ type: CANVAS_ERROR_MESSAGE, message })}, "*");</script>`,
    `<p style="margin:16px;opacity:0.6">${message}</p>`,
  );
}
