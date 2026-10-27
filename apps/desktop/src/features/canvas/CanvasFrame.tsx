import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import {
  CANVAS_ERROR_MESSAGE,
  CANVAS_KEY_MESSAGE,
  CANVAS_LEAVE_MESSAGE,
  CANVAS_MAX_ERROR_CHARS,
  CANVAS_PICK_MESSAGE,
  CANVAS_PICKED_MESSAGE,
  CANVAS_READY_MESSAGE,
  CANVAS_RECTS_MESSAGE,
  CANVAS_RECTS_REPLY_MESSAGE,
  canvasBoardUrl,
  canvasNodeFrom,
  canvasRectFrom,
  type CanvasRect,
} from "@pi-desktop/shared";

/**
 * One artboard in a sandboxed, opaque-origin frame (no `allow-same-origin`):
 * it cannot reach this document or the preload bridge. Only messages from
 * this frame's own window are read, and only numbers and boxes are taken
 * from them; error text is shown and quoted as data.
 */
export type CanvasFrameHandle = {
  /** The numbered element at a point in the frame's viewport pixels. */
  pick(x: number, y: number): Promise<{ node: number; rect: CanvasRect } | null>;
  /** Boxes of numbered elements, for comment pins. */
  rects(nodes: readonly number[]): Promise<Record<number, CanvasRect>>;
};

type Pending = { resolve: (value: unknown) => void; timer: ReturnType<typeof setTimeout> };

export const CanvasFrame = forwardRef<
  CanvasFrameHandle,
  {
    groupId: string;
    canvasId: string;
    boardId: string;
    rev: number;
    title: string;
    width: number;
    height: number;
    interactive: boolean;
    onReady?: () => void;
    onError?: (message: string) => void;
    onEscape?: () => void;
  }
>(function CanvasFrame(props, ref) {
  const frame = useRef<HTMLIFrameElement | null>(null);
  const pending = useRef(new Map<number, Pending>());
  const seq = useRef(0);
  const callbacks = useRef(props);
  useEffect(() => {
    callbacks.current = props;
  });

  const ask = <T,>(message: Record<string, unknown>, fallback: T): Promise<T> =>
    new Promise((resolve) => {
      const target = frame.current?.contentWindow;
      if (!target) {
        resolve(fallback);
        return;
      }
      seq.current += 1;
      const id = seq.current;
      const timer = setTimeout(() => {
        pending.current.delete(id);
        resolve(fallback);
      }, 1500);
      pending.current.set(id, { resolve: resolve as (value: unknown) => void, timer });
      // The guest origin is opaque, so "*" is the only target that reaches it;
      // the message carries coordinates and numbers only.
      target.postMessage({ ...message, seq: id }, "*");
    });

  useImperativeHandle(ref, () => ({
    pick: (x, y) => ask({ type: CANVAS_PICK_MESSAGE, x, y }, null),
    rects: (nodes) => ask({ type: CANVAS_RECTS_MESSAGE, nodes: [...nodes] }, {}),
  }));

  useEffect(() => {
    const settle = (id: unknown, value: unknown) => {
      const entry = typeof id === "number" ? pending.current.get(id) : undefined;
      if (!entry) return;
      clearTimeout(entry.timer);
      pending.current.delete(id as number);
      entry.resolve(value);
    };
    const onMessage = (event: MessageEvent) => {
      if (!frame.current || event.source !== frame.current.contentWindow) return;
      const data = event.data as Record<string, unknown> | null;
      if (!data || typeof data !== "object") return;
      switch (data.type) {
        case CANVAS_READY_MESSAGE:
          callbacks.current.onReady?.();
          return;
        case CANVAS_PICKED_MESSAGE: {
          const hit = data.hit as Record<string, unknown> | null;
          const node = hit ? canvasNodeFrom(hit.node) : null;
          const rect = hit ? canvasRectFrom(hit.rect) : null;
          settle(data.seq, node !== null && rect ? { node, rect } : null);
          return;
        }
        case CANVAS_RECTS_REPLY_MESSAGE: {
          const rects: Record<number, CanvasRect> = {};
          const raw = data.rects && typeof data.rects === "object" ? (data.rects as Record<string, unknown>) : {};
          for (const [key, value] of Object.entries(raw).slice(0, 500)) {
            const node = canvasNodeFrom(Number(key));
            const rect = canvasRectFrom(value);
            if (node !== null && rect) rects[node] = rect;
          }
          settle(data.seq, rects);
          return;
        }
        case CANVAS_ERROR_MESSAGE:
          if (typeof data.message === "string") callbacks.current.onError?.(data.message.slice(0, CANVAS_MAX_ERROR_CHARS));
          return;
        case CANVAS_KEY_MESSAGE:
          if (data.key === "Escape") callbacks.current.onEscape?.();
          return;
      }
    };
    window.addEventListener("message", onMessage);
    const waiting = pending.current;
    return () => {
      window.removeEventListener("message", onMessage);
      for (const entry of waiting.values()) {
        clearTimeout(entry.timer);
        entry.resolve(null);
      }
      waiting.clear();
    };
  }, []);

  // Leaving the artboard drops what was selected or focused in it, so no
  // selection is left behind and keys come back to the canvas.
  const wasInteractive = useRef(props.interactive);
  useEffect(() => {
    if (wasInteractive.current && !props.interactive) {
      frame.current?.contentWindow?.postMessage({ type: CANVAS_LEAVE_MESSAGE }, "*");
      frame.current?.blur();
      window.focus();
    }
    wasInteractive.current = props.interactive;
  }, [props.interactive]);

  return (
    <iframe
      ref={frame}
      className="mc-canvas-frame"
      src={canvasBoardUrl(props.groupId, props.canvasId, props.boardId, props.rev)}
      title={props.title}
      sandbox="allow-scripts"
      referrerPolicy="no-referrer"
      style={{ width: props.width, height: props.height, pointerEvents: props.interactive ? "auto" : "none" }}
    />
  );
});
