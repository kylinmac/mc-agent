import { useCallback, useEffect, useRef, useState } from "react";
import type { Canvas, CanvasComments, CanvasOp, CanvasSummary } from "@pi-desktop/shared";
import { api } from "../../lib/api";

/*
  mc-agent prototype canvas: loading and changing a canvas through host-core.
  Changes go out one at a time, each against the version the last one
  returned; a refusal because the canvas changed meanwhile reloads it.
*/

export function useCanvasList(groupId: string | null) {
  const [canvases, setCanvases] = useState<CanvasSummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  const reload = useCallback(async () => {
    if (!groupId) {
      setCanvases([]);
      return;
    }
    try {
      const { canvases: listed } = await api.canvas.call("canvas.list", { groupId });
      setCanvases(listed);
      setError(null);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    }
  }, [groupId]);
  useEffect(() => {
    void reload();
  }, [reload]);
  useEffect(
    () =>
      api.canvas.onChanged((change) => {
        if (change.groupId === groupId) void reload();
      }),
    [groupId, reload],
  );
  return { canvases, error, reload };
}

export function isConflict(failure: unknown): boolean {
  const message = failure instanceof Error ? failure.message : String(failure);
  return /CONFLICT/.test(message);
}

export function useCanvas(groupId: string, canvasId: string) {
  const [canvas, setCanvas] = useState<Canvas | null>(null);
  const [comments, setComments] = useState<CanvasComments>({ version: 0, threads: [] });
  const [error, setError] = useState<string | null>(null);
  const current = useRef<Canvas | null>(null);
  const queue = useRef<Promise<unknown>>(Promise.resolve());

  const load = useCallback(async () => {
    try {
      const [{ canvas: loaded }, { comments: threads }] = await Promise.all([
        api.canvas.call("canvas.get", { groupId, canvasId }),
        api.canvas.call("canvas.comments.list", { groupId, canvasId }),
      ]);
      current.current = loaded;
      setCanvas(loaded);
      setComments(threads);
      setError(null);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    }
  }, [groupId, canvasId]);

  useEffect(() => {
    current.current = null;
    setCanvas(null);
    setComments({ version: 0, threads: [] });
    void load();
  }, [load]);

  useEffect(
    () =>
      api.canvas.onChanged((change) => {
        if (change.groupId === groupId && change.canvasId === canvasId) void load();
      }),
    [groupId, canvasId, load],
  );

  /**
   * Apply a batch made against the canvas as it is now. Resolves with the
   * canvas before and after, or null when it was refused (the canvas is then
   * reloaded and `onConflict` hears about it).
   */
  const apply = useCallback(
    (ops: CanvasOp[], onConflict?: () => void) => {
      const run = async () => {
        const before = current.current;
        if (!before) return null;
        try {
          const applied = await api.canvas.call("canvas.apply", {
            groupId,
            canvasId,
            baseVersion: before.version,
            ops,
          });
          current.current = applied.canvas;
          setCanvas(applied.canvas);
          return { before, after: applied.canvas, added: applied.added };
        } catch (failure) {
          if (isConflict(failure)) {
            onConflict?.();
            await load();
            return null;
          }
          throw failure;
        }
      };
      const next = queue.current.then(run, run);
      queue.current = next.catch(() => undefined);
      return next;
    },
    [groupId, canvasId, load],
  );

  /** Show a change before host-core confirms it (e.g. while dragging). */
  const preview = useCallback((change: (canvas: Canvas) => Canvas) => {
    setCanvas((value) => (value ? change(value) : value));
  }, []);

  /** Undo a preview that will not be sent. */
  const revert = useCallback(() => setCanvas(current.current), []);

  const setThreads = useCallback((next: CanvasComments) => setComments(next), []);

  return { canvas, comments, error, reload: load, apply, preview, revert, setThreads };
}
