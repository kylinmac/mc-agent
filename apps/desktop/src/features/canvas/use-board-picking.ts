import { useCallback, useRef } from "react";
import type { CanvasElement } from "@pi-desktop/shared";
import { api } from "../../lib/api";
import type { CanvasFrameHandle } from "./CanvasFrame";
import type { Box, CanvasViewport } from "./canvas-model";

export type Hover = { boardId: string; tid: number; rect: Box; label?: string | null };

/** Finding the element under the pointer inside an artboard. */
export function useBoardPicking({
  groupId,
  canvasId,
  stage,
  frames,
  view,
  byId,
  setHover,
}: {
  groupId: string;
  canvasId: string;
  stage: { current: HTMLDivElement | null };
  frames: { current: Map<string, CanvasFrameHandle> };
  view: CanvasViewport | null;
  byId: Map<string, CanvasElement>;
  setHover: (hover: Hover | null) => void;
}) {
  /** The element under a client point in an artboard, named by host-core. */
  const pickAt = useCallback(
    async (boardId: string, clientX: number, clientY: number) => {
      const handle = frames.current.get(boardId);
      const iframe = stage.current?.querySelector<HTMLIFrameElement>(`[data-board="${CSS.escape(boardId)}"] iframe`);
      if (!handle || !iframe || !view) return null;
      const rect = iframe.getBoundingClientRect();
      const local = { x: (clientX - rect.left) / view.zoom, y: (clientY - rect.top) / view.zoom };
      const hit = await handle.pick(local.x, local.y);
      if (!hit) return { local, node: null };
      try {
        const { node } = await api.canvas.call("canvas.resolveNode", { groupId, canvasId, boardId, node: hit.node });
        return { local, node: { ...node, rect: hit.rect } };
      } catch {
        return { local, node: null };
      }
    },
    [canvasId, frames, groupId, stage, view],
  );

  // What the pointer is over inside an artboard: outlined, with its label
  // (named by host-core, remembered per artboard version).
  const labels = useRef(new Map<string, string | null>());
  const hovering = useRef<{ busy: boolean; next: { boardId: string; x: number; y: number } | null }>({ busy: false, next: null });
  const trackHover = useCallback(
    (boardId: string, clientX: number, clientY: number) => {
      const state = hovering.current;
      state.next = { boardId, x: clientX, y: clientY };
      if (state.busy) return;
      state.busy = true;
      void (async () => {
        while (state.next) {
          const at = state.next;
          state.next = null;
          const handle = frames.current.get(at.boardId);
          const iframe = stage.current?.querySelector<HTMLIFrameElement>(`[data-board="${CSS.escape(at.boardId)}"] iframe`);
          const board = byId.get(at.boardId);
          if (!handle || !iframe || !view || !board) continue;
          const rect = iframe.getBoundingClientRect();
          const hit = await handle.pick((at.x - rect.left) / view.zoom, (at.y - rect.top) / view.zoom);
          if (!hit) {
            setHover(null);
            continue;
          }
          const key = `${at.boardId}:${board.rev}:${hit.node}`;
          if (!labels.current.has(key)) {
            try {
              const { node } = await api.canvas.call("canvas.resolveNode", { groupId, canvasId, boardId: at.boardId, node: hit.node });
              labels.current.set(key, node.label ?? node.tag);
            } catch {
              labels.current.set(key, null);
            }
          }
          setHover({ boardId: at.boardId, tid: hit.node, rect: hit.rect, label: labels.current.get(key) });
        }
        state.busy = false;
      })();
    },
    [byId, canvasId, frames, groupId, setHover, stage, view],
  );

  return { pickAt, trackHover };
}
