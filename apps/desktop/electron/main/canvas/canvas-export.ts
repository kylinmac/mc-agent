import type { Canvas, CanvasElement, CanvasNoteColor } from "@pi-desktop/shared";
import { buildCanvasStandaloneBoard, CANVAS_CONTENT_SECURITY_POLICY, escapeAttribute } from "./canvas-document";

/**
 * mc-agent prototype canvas: a canvas exported as one self-contained HTML
 * file to open in a browser or pass on (docs/mc-agent/prototype-canvas.md).
 * Elements keep their canvas positions; each artboard is its own source in
 * a sandboxed `srcdoc` iframe with the canvas CSP, so the file loads nothing
 * from the network and artboard scripts cannot reach the page.
 */

const PAD = 64;
/** The name strip above an artboard. */
const STRIP = 28;
/** A title or note that grows with its text, as the canvas estimates it. */
const AUTO_HEIGHT = 56;

const NOTE_COLORS: Record<CanvasNoteColor, string> = {
  yellow: "#fff3b0",
  blue: "#d6e8ff",
  green: "#d4f5dd",
  pink: "#ffdcea",
  purple: "#e7dcff",
  orange: "#ffe2c6",
  gray: "#e6e8eb",
};

/** The page's own policy; artboard frames inherit it on top of theirs. */
const PAGE_CONTENT_SECURITY_POLICY = CANVAS_CONTENT_SECURITY_POLICY.replace("frame-src 'none'", "frame-src 'self'");

const PAGE_CSS = `:root { color-scheme: light; }
html, body { margin: 0; background: #f4f4f2; color: #1f2328; font: 14px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
body { background-image: radial-gradient(#d6d6d2 1px, transparent 1px); background-size: 24px 24px; }
.stage { position: relative; }
.el { position: absolute; box-sizing: border-box; }
.strip { position: absolute; left: 0; bottom: 100%; padding-bottom: 6px; white-space: nowrap; font-size: 13px; color: #57606a; }
.strip span { margin-left: 6px; opacity: 0.6; }
iframe { display: block; width: 100%; height: 100%; border: 0; background: #fff; box-shadow: 0 1px 3px rgb(0 0 0 / 18%); }
.title { color: #57606a; font-size: 40px; font-weight: 600; line-height: 1.15; }
.note { padding: 12px 14px; border-radius: 4px; box-shadow: 0 1px 2px rgb(0 0 0 / 15%); white-space: pre-wrap; line-height: 1.6; }`;

function escapeText(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function px(value: number): string {
  return `${Math.round(value)}px`;
}

function heightOf(element: CanvasElement): number {
  return element.h > 0 ? element.h : AUTO_HEIGHT;
}

/** Build the exported page. `html` holds each artboard's source by id; a missing one shows empty. */
export function buildCanvasExport(canvas: Canvas, html: Record<string, string>): string {
  const elements = canvas.elements;
  const top = (element: CanvasElement) => element.y - (element.type === "frame" ? STRIP : 0);
  const minX = elements.length ? Math.min(...elements.map((element) => element.x)) : 0;
  const minY = elements.length ? Math.min(...elements.map(top)) : 0;
  const maxX = elements.length ? Math.max(...elements.map((element) => element.x + element.w)) : 0;
  const maxY = elements.length ? Math.max(...elements.map((element) => element.y + heightOf(element))) : 0;
  const place = (element: CanvasElement, height: string) =>
    `left:${px(element.x - minX + PAD)};top:${px(element.y - minY + PAD)};width:${px(element.w)};height:${height}`;

  const parts = elements.map((element) => {
    if (element.type === "frame") {
      const name = element.title ? escapeText(element.title) : "";
      const document = buildCanvasStandaloneBoard(html[element.id] ?? "");
      return `<div class="el" style="${place(element, px(element.h))}">
<div class="strip">${name}<span>${element.w}×${element.h}</span></div>
<iframe sandbox="allow-scripts" title="${escapeAttribute(element.title ?? element.id)}" srcdoc="${escapeAttribute(document)}"></iframe>
</div>`;
    }
    const text = escapeText(element.text ?? "");
    if (element.type === "title") return `<div class="el title" style="${place(element, "auto")}">${text}</div>`;
    const color = NOTE_COLORS[element.color ?? "yellow"] ?? NOTE_COLORS.yellow;
    const height = element.h > 0 ? px(element.h) : "auto";
    return `<div class="el note" style="${place(element, height)};background:${color}">${text}</div>`;
  });

  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="${escapeAttribute(PAGE_CONTENT_SECURITY_POLICY)}">
<title>${escapeText(canvas.title)}</title>
<style>${PAGE_CSS}</style>
</head>
<body>
<div class="stage" style="width:${px(maxX - minX + PAD * 2)};height:${px(maxY - minY + PAD * 2)}">
${parts.join("\n")}
</div>
</body>
</html>
`;
}

/** A file name for the export, from the canvas title. */
export function canvasExportFileName(title: string): string {
  const base = title.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 80);
  return `${base || "canvas"}.html`;
}
