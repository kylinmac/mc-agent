import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { Canvas } from "@pi-desktop/shared";
import { boundsOf, elementBox, fitView, zoomAt, type CanvasViewport } from "./canvas-model";

const VIEW_KEY = "mc.canvasView.";

function readView(canvasId: string): CanvasViewport | null {
  try {
    const raw = localStorage.getItem(VIEW_KEY + canvasId);
    const parsed = raw ? (JSON.parse(raw) as CanvasViewport) : null;
    return parsed && [parsed.panX, parsed.panY, parsed.zoom].every(Number.isFinite) ? parsed : null;
  } catch {
    return null;
  }
}

function storeView(canvasId: string, view: CanvasViewport) {
  try {
    localStorage.setItem(VIEW_KEY + canvasId, JSON.stringify(view));
  } catch {
    // Remembering the view is a convenience only.
  }
}

/**
 * The stage's size and the canvas's pan and zoom: remembered per canvas,
 * changed by the wheel (zoom with ⌘/Ctrl or a pinch). `autoView` is true
 * while the view is a fit the user has not moved.
 */
export function useCanvasViewport(
  stage: { current: HTMLDivElement | null },
  canvas: Canvas | null,
  canvasId: string,
  entered: string | null,
) {
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [view, setView] = useState<CanvasViewport | null>(null);

  useLayoutEffect(() => {
    const node = stage.current;
    if (!node) return;
    const observer = new ResizeObserver(() => setSize({ w: node.clientWidth, h: node.clientHeight }));
    observer.observe(node);
    setSize({ w: node.clientWidth, h: node.clientHeight });
    return () => observer.disconnect();
  }, []);

  const fitAll = useCallback(
    (target: Canvas | null = canvas) => {
      if (!target || !size.w) return;
      setView(fitView(boundsOf(target.elements.map((element) => elementBox(element))), size.w, size.h, 32));
    },
    [canvas, size.w, size.h],
  );

  // First view of a canvas: where it was left, else everything. A fitted
  // view follows the panel's size (it opens narrow and grows) until the user
  // pans or zooms.
  const placed = useRef<string | null>(null);
  const autoView = useRef(true);
  const userView = (next: CanvasViewport) => {
    autoView.current = false;
    setView(next);
  };
  useEffect(() => {
    if (!canvas || !size.w || placed.current === canvasId) return;
    placed.current = canvasId;
    const stored = readView(canvasId);
    autoView.current = !stored;
    if (stored) setView(stored);
    else fitAll(canvas);
  }, [canvas, canvasId, size.w, fitAll]);
  // `fitAll` changes with the stage size and the canvas.
  useEffect(() => {
    if (canvas && autoView.current && placed.current === canvasId) fitAll(canvas);
  }, [canvas, canvasId, fitAll]);

  // The agent's first artboards on an empty canvas come into view.
  const hadElements = useRef(false);
  useEffect(() => {
    if (!canvas) return;
    const has = canvas.elements.length > 0;
    if (has && !hadElements.current && placed.current === canvasId) fitAll(canvas);
    hadElements.current = has;
  }, [canvas, canvasId, fitAll]);

  useEffect(() => {
    setView(null);
    placed.current = null;
    autoView.current = true;
    hadElements.current = false;
  }, [canvasId]);

  useEffect(() => {
    if (!view || autoView.current) return;
    const timer = setTimeout(() => storeView(canvasId, view), 300);
    return () => clearTimeout(timer);
  }, [view, canvasId]);

  // Wheel pans; with ⌘/Ctrl (and trackpad pinch, which reports ctrlKey) it zooms.
  useEffect(() => {
    const node = stage.current;
    if (!node) return;
    const onWheel = (event: WheelEvent) => {
      if (entered && (event.target as HTMLElement | null)?.closest?.(".mc-canvas-board.is-entered")) return;
      event.preventDefault();
      const rect = node.getBoundingClientRect();
      const at = { x: event.clientX - rect.left, y: event.clientY - rect.top };
      autoView.current = false;
      setView((current) => {
        if (!current) return current;
        if (event.ctrlKey || event.metaKey) return zoomAt(current, Math.exp(-event.deltaY * 0.01), at);
        return { ...current, panX: current.panX - event.deltaX, panY: current.panY - event.deltaY };
      });
    };
    node.addEventListener("wheel", onWheel, { passive: false });
    return () => node.removeEventListener("wheel", onWheel);
  }, [entered]);

  return { size, view, setView, userView, fitAll, autoView };
}
