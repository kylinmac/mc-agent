import { fenceCanvasData } from "@pi-desktop/shared";
import type { Canvas, CanvasElement, CanvasNode, CanvasOp, CanvasThread } from "@pi-desktop/shared";

/*
  mc-agent prototype canvas (docs/mc-agent/prototype-canvas.md): the pure part
  of the canvas view — coordinates, what is visible, what the chat is told,
  and how a user's change is undone.
*/

/** Screen = canvas × zoom + pan. */
export type CanvasViewport = { panX: number; panY: number; zoom: number };
export type Point = { x: number; y: number };
export type Box = { x: number; y: number; w: number; h: number };

export const MIN_ZOOM = 0.05;
export const MAX_ZOOM = 4;
/** Below this zoom an artboard shows its title instead of its page. */
export const PLACEHOLDER_ZOOM = 0.2;

export function clampZoom(zoom: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));
}

export function toCanvas(point: Point, view: CanvasViewport): Point {
  return { x: (point.x - view.panX) / view.zoom, y: (point.y - view.panY) / view.zoom };
}

export function toScreen(point: Point, view: CanvasViewport): Point {
  return { x: point.x * view.zoom + view.panX, y: point.y * view.zoom + view.panY };
}

/** Zoom by `factor` keeping the canvas point under `at` (screen) still. */
export function zoomAt(view: CanvasViewport, factor: number, at: Point): CanvasViewport {
  const zoom = clampZoom(view.zoom * factor);
  const anchor = toCanvas(at, view);
  return { zoom, panX: at.x - anchor.x * zoom, panY: at.y - anchor.y * zoom };
}

/** A note or title with h = 0 grows with its text; estimate for layout math. */
export function elementBox(element: CanvasElement, measured?: number): Box {
  if (element.h > 0) return { x: element.x, y: element.y, w: element.w, h: element.h };
  if (measured) return { x: element.x, y: element.y, w: element.w, h: measured };
  const chars = (element.text ?? "").length;
  const perLine = Math.max(8, Math.floor(element.w / 8));
  const lines = Math.max(1, Math.ceil(chars / perLine) + (element.text ?? "").split("\n").length - 1);
  const height = element.type === "title" ? 56 : Math.min(element.w * (4 / 3), 24 + lines * 20);
  return { x: element.x, y: element.y, w: element.w, h: height };
}

export function boundsOf(boxes: readonly Box[]): Box | null {
  if (!boxes.length) return null;
  const left = Math.min(...boxes.map((box) => box.x));
  const top = Math.min(...boxes.map((box) => box.y));
  const right = Math.max(...boxes.map((box) => box.x + box.w));
  const bottom = Math.max(...boxes.map((box) => box.y + box.h));
  return { x: left, y: top, w: right - left, h: bottom - top };
}

/** Frame `box` in a viewport of `width` × `height`, never zooming past 100 %. */
export function fitView(box: Box | null, width: number, height: number, padding = 64): CanvasViewport {
  if (!box || width <= 0 || height <= 0) return { panX: padding, panY: padding, zoom: 1 };
  const zoom = clampZoom(
    Math.min(1, (width - padding * 2) / Math.max(1, box.w), (height - padding * 2) / Math.max(1, box.h)),
  );
  return {
    zoom,
    panX: (width - box.w * zoom) / 2 - box.x * zoom,
    panY: (height - box.h * zoom) / 2 - box.y * zoom,
  };
}

export function intersects(a: Box, b: Box): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

/** The canvas area the viewport shows, with a margin in screen pixels. */
export function visibleArea(view: CanvasViewport, width: number, height: number, margin = 0): Box {
  const topLeft = toCanvas({ x: -margin, y: -margin }, view);
  return { x: topLeft.x, y: topLeft.y, w: (width + margin * 2) / view.zoom, h: (height + margin * 2) / view.zoom };
}

/** Normalize a drag rectangle from two corners. */
export function rectFrom(a: Point, b: Point): Box {
  return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(a.x - b.x), h: Math.abs(a.y - b.y) };
}

/** The topmost artboard under a canvas point. */
export function frameAt(canvas: Canvas, point: Point): CanvasElement | null {
  for (let index = canvas.elements.length - 1; index >= 0; index -= 1) {
    const element = canvas.elements[index];
    if (element.type !== "frame") continue;
    if (point.x >= element.x && point.x <= element.x + element.w && point.y >= element.y && point.y <= element.y + element.h)
      return element;
  }
  return null;
}

// ---- what the chat is told ---------------------------------------------------

export function makeNonce(): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => alphabet[byte % alphabet.length]).join("");
}

export type CanvasViewState = {
  canvasId: string;
  title: string;
  version: number;
  visibleBoards: string[];
  selectedBoards: string[];
  /** Selected elements inside artboards, most recent last. */
  selected: CanvasNode[];
  errored: Array<{ boardId: string; message: string }>;
  dirty: boolean;
};

/**
 * The view context a message carries (docs: 关键设计 5), capped as the doc
 * says. Labels come from host-core's reading of the source.
 */
export function viewContext(state: CanvasViewState) {
  return {
    canvas: { id: state.canvasId, title: state.title, version: state.version },
    visibleBoards: state.visibleBoards.slice(0, 20),
    selectedBoards: state.selectedBoards.slice(0, 20),
    selected: state.selected.slice(-20).map((node) => node.address),
    selection: state.selected.slice(-5).map((node) => ({
      id: node.address,
      mcId: node.mcId ?? undefined,
      kind: node.kind,
      tag: node.tag,
      label: node.label ?? undefined,
    })),
    erroredBoards: state.errored.slice(0, 10).map((error) => ({
      boardId: error.boardId,
      firstError: error.message.slice(0, 60),
    })),
    dirty: state.dirty,
  };
}

export function hasViewContext(state: CanvasViewState | null): state is CanvasViewState {
  return Boolean(state && (state.visibleBoards.length || state.selected.length || state.selectedBoards.length));
}

export function viewContextText(state: CanvasViewState, nonce: string): string {
  return fenceCanvasData("view", JSON.stringify(viewContext(state), null, 1), nonce);
}

/** Something from the canvas queued for the next message, fixed when queued. */
export type CanvasAttachment =
  | {
      kind: "thread";
      key: string;
      canvasId: string;
      threadId: string;
      anchor: { boardId?: string; address?: string; mcId?: string; label?: string };
      messages: Array<{ author: "user" | "agent"; text: string }>;
    }
  | { kind: "note"; key: string; canvasId: string; noteId: string; text: string; boardId?: string }
  | { kind: "errors"; key: string; canvasId: string; boardId: string; messages: string[] };

/** Up to this much error text goes into one message. */
export const MAX_ERROR_ATTACHMENT_CHARS = 1800;

export function threadAttachment(canvasId: string, thread: CanvasThread): CanvasAttachment {
  return {
    kind: "thread",
    key: `thread:${canvasId}:${thread.id}`,
    canvasId,
    threadId: thread.id,
    anchor: {
      boardId: thread.anchor.boardId,
      address: thread.located.node?.address ?? thread.anchor.address,
      mcId: thread.anchor.mcId,
      label: thread.anchor.label,
    },
    messages: thread.messages.map((message) => ({ author: message.author, text: message.text })),
  };
}

export function noteAttachment(canvasId: string, note: CanvasElement): CanvasAttachment {
  return { kind: "note", key: `note:${canvasId}:${note.id}`, canvasId, noteId: note.id, text: note.text ?? "", boardId: note.boardId };
}

export function errorsAttachment(canvasId: string, boardId: string, messages: readonly string[]): CanvasAttachment {
  const kept: string[] = [];
  let total = 0;
  for (const message of messages) {
    if (total + message.length > MAX_ERROR_ATTACHMENT_CHARS) break;
    kept.push(message);
    total += message.length;
  }
  return { kind: "errors", key: `errors:${canvasId}:${boardId}`, canvasId, boardId, messages: kept };
}

/** Attachments added again replace the earlier copy, in their first place. */
export function addAttachment(list: readonly CanvasAttachment[], item: CanvasAttachment): CanvasAttachment[] {
  const at = list.findIndex((existing) => existing.key === item.key);
  if (at === -1) return [...list, item];
  const next = [...list];
  next[at] = item;
  return next;
}

export function attachmentsText(list: readonly CanvasAttachment[], nonce: string): string {
  if (!list.length) return "";
  const body = list.map((item) => {
    switch (item.kind) {
      case "thread":
        return {
          type: "comment thread sent to you",
          canvasId: item.canvasId,
          threadId: item.threadId,
          on: item.anchor,
          messages: item.messages,
        };
      case "note":
        return { type: "note", canvasId: item.canvasId, noteId: item.noteId, boardId: item.boardId, text: item.text };
      case "errors":
        return { type: "artboard errors", canvasId: item.canvasId, boardId: item.boardId, errors: item.messages };
    }
  });
  return fenceCanvasData("attachments", JSON.stringify(body, null, 1), nonce);
}

// ---- undo ---------------------------------------------------------------------

const MOVABLE: Array<keyof CanvasElement> = ["x", "y", "w", "h", "title", "text", "color", "boardId"];

/**
 * The operations that undo `ops` applied to `before`. Null when a step cannot
 * be undone here (removing an artboard deletes its file; restoring is its own
 * undo button).
 */
export function inverseOps(before: Canvas, ops: readonly CanvasOp[]): CanvasOp[] | null {
  const byId = new Map(before.elements.map((element) => [element.id, element]));
  const inverse: CanvasOp[] = [];
  for (const op of ops) {
    switch (op.op) {
      case "add":
        if (!op.element.id) return null;
        inverse.unshift({ op: "remove", id: op.element.id });
        break;
      case "update": {
        const element = byId.get(op.id);
        if (!element || op.html !== undefined) return null;
        const set: Record<string, unknown> = {};
        for (const key of Object.keys(op.set ?? {}) as Array<keyof CanvasElement>) {
          if (!MOVABLE.includes(key)) return null;
          const value = element[key];
          set[key] = value === undefined ? (key === "color" || key === "boardId" ? "" : value) : value;
        }
        inverse.unshift({ op: "update", id: op.id, set });
        break;
      }
      case "remove": {
        const element = byId.get(op.id);
        if (!element || element.type === "frame") return null;
        const index = before.elements.indexOf(element);
        const { rev: _rev, hasPrev: _prev, ...fields } = element;
        inverse.unshift({ op: "add", element: fields });
        // Added back on top; one that was at the very back goes back there.
        if (index === 0 && before.elements.length > 1) inverse.push({ op: "reorder", id: element.id, to: "back" });
        break;
      }
      default:
        return null;
    }
  }
  return inverse;
}

export type CanvasHistory = { undo: CanvasOp[][]; redo: CanvasOp[][] };
export const EMPTY_HISTORY: CanvasHistory = { undo: [], redo: [] };
const MAX_HISTORY = 50;

export function pushHistory(history: CanvasHistory, inverse: CanvasOp[] | null): CanvasHistory {
  if (!inverse) return EMPTY_HISTORY;
  return { undo: [...history.undo, inverse].slice(-MAX_HISTORY), redo: [] };
}

// ---- comment pins ------------------------------------------------------------

/**
 * Where a thread's pin sits on the canvas. Element pins use the element's box
 * inside its artboard when the frame reported one; otherwise the stored
 * point, on the artboard.
 */
export function pinPosition(
  thread: CanvasThread,
  canvas: Canvas,
  elementBoxes: ReadonlyMap<string, Record<number, Box>>,
): Point | null {
  const anchor = thread.anchor;
  if (anchor.kind === "canvas" || !anchor.boardId) return { x: anchor.x, y: anchor.y };
  const board = canvas.elements.find((element) => element.id === anchor.boardId && element.type === "frame");
  if (!board) return null;
  const node = thread.located.state === "ok" ? thread.located.node : undefined;
  const box = node ? elementBoxes.get(board.id)?.[node.tid] : undefined;
  if (box) return { x: board.x + Math.min(box.x + box.w, board.w) - 4, y: board.y + Math.max(0, box.y) + 4 };
  return {
    x: board.x + Math.min(Math.max(anchor.x, 0), board.w),
    y: board.y + Math.min(Math.max(anchor.y, 0), board.h),
  };
}
