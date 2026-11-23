import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { clampSidebarWidth, SIDEBAR_WIDTH_MIN } from "../../lib/sidebar-preferences";
import { SIDEBAR_RESIZE_STEP, sidebarPointerResize, sidebarResetWidth } from "../../lib/sidebar-resize";
type SidebarResizeState = {
  pointerId: number;
  startX: number;
  startWidth: number;
  currentWidth: number;
  frame: number;
  handle: HTMLDivElement;
};
function clearSidebarResizeStyles(): void {
  document.documentElement.removeAttribute("data-sidebar-resizing");
}
export function useSidebarResize(
  sidebarWidth: number,
  widthMax: number,
  sidebarPinned: boolean,
  onWidthChange: (width: number) => void,
  onWidthCommit: (width: number) => void,
  onResizeCollapse: () => void,
) {
  const [sidebarResizing, setSidebarResizing] = useState(false);

  const sidebarResizeRef = useRef<SidebarResizeState | null>(null);

  const finishSidebarResize = useCallback((cancelled: boolean, collapse = false) => {
    const state = sidebarResizeRef.current;
    if (!state) return;
    if (collapse) {
      // Keep the previewed width for the exit animation and persist nothing:
      // the shell restores the preferred expanded width on reopen.
    } else if (cancelled) {
      onWidthChange(state.startWidth);
    } else {
      onWidthChange(state.currentWidth);
      onWidthCommit(state.currentWidth);
    }
    sidebarResizeRef.current = null;
    if (state.frame) cancelAnimationFrame(state.frame);
    clearSidebarResizeStyles();
    if (state.handle.hasPointerCapture(state.pointerId)) {
      state.handle.releasePointerCapture(state.pointerId);
    }
    setSidebarResizing(false);
    if (collapse) onResizeCollapse();
  }, [onResizeCollapse, onWidthChange, onWidthCommit]);

  const startSidebarResize = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || sidebarResizeRef.current) return;
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.focus({ preventScroll: true });
    // Anchor to the rendered width so pressing the handle never resizes the
    // column; the live budget only limits where the gesture may land.
    const startWidth = clampSidebarWidth(sidebarWidth);
    sidebarResizeRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startWidth,
      currentWidth: startWidth,
      frame: 0,
      handle: event.currentTarget,
    };
    setSidebarResizing(true);
    document.documentElement.setAttribute("data-sidebar-resizing", "true");
    event.currentTarget.setPointerCapture(event.pointerId);
  }, [sidebarWidth, widthMax]);

  const moveSidebarResize = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const state = sidebarResizeRef.current;
    if (!state || state.pointerId !== event.pointerId) return;
    const result = sidebarPointerResize({
      startWidth: state.startWidth,
      deltaX: event.clientX - state.startX,
      maxWidth: widthMax,
    });
    if (result.type === "collapse") {
      if (!sidebarPinned) {
        finishSidebarResize(true, true);
        return;
      }
      state.currentWidth = SIDEBAR_WIDTH_MIN;
    } else {
      state.currentWidth = result.width;
    }
    if (state.frame) return;
    state.frame = requestAnimationFrame(() => {
      if (sidebarResizeRef.current !== state) return;
      state.frame = 0;
      onWidthChange(state.currentWidth);
    });
  }, [finishSidebarResize, onWidthChange, sidebarPinned, widthMax]);

  const endSidebarResize = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (sidebarResizeRef.current?.pointerId !== event.pointerId) return;
    finishSidebarResize(false);
  }, [finishSidebarResize]);

  const cancelSidebarResize = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (sidebarResizeRef.current?.pointerId !== event.pointerId) return;
    finishSidebarResize(true);
  }, [finishSidebarResize]);

  const handleSidebarResizeKeyDown = useCallback((event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    event.stopPropagation();
    const currentWidth = clampSidebarWidth(sidebarWidth, widthMax);
    const nextWidth = event.key === "Home"
      ? SIDEBAR_WIDTH_MIN
      : event.key === "End"
        ? clampSidebarWidth(widthMax, widthMax)
        : clampSidebarWidth(
            currentWidth + (event.key === "ArrowRight" ? SIDEBAR_RESIZE_STEP : -SIDEBAR_RESIZE_STEP),
            widthMax,
          );
    if (nextWidth === currentWidth) return;
    onWidthCommit(nextWidth);
  }, [onWidthCommit, sidebarWidth, widthMax]);

  /**
   * Double-click reset: the shell's default width, clamped by the live
   * three-column budget. A pointer gesture that is somehow still open is
   * dropped first so its release cannot overwrite the reset.
   */
  const resetSidebarWidth = useCallback(() => {
    if (sidebarResizeRef.current) finishSidebarResize(true);
    onWidthCommit(sidebarResetWidth(widthMax));
  }, [finishSidebarResize, onWidthCommit, widthMax]);

  useEffect(() => {
    if (!sidebarResizing) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      finishSidebarResize(true);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [finishSidebarResize, sidebarResizing]);

  useEffect(() => {
    return () => {
      const state = sidebarResizeRef.current;
      if (!state) return;
      if (state.frame) cancelAnimationFrame(state.frame);
      onWidthChange(state.startWidth);
      clearSidebarResizeStyles();
      sidebarResizeRef.current = null;
    };
  }, [onWidthChange]);
  return {
    sidebarResizing,
    startSidebarResize,
    moveSidebarResize,
    endSidebarResize,
    cancelSidebarResize,
    handleSidebarResizeKeyDown,
    resetSidebarWidth,
  };
}
