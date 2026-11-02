import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { useTranslation } from "react-i18next";
import {
  DEFAULT_CHAT_CONTENT_MAX_WIDTH,
  MIN_CHAT_CONTENT_MAX_WIDTH,
  chatContentWidthFromDrag,
  clampChatContentMaxWidth,
  resolveChatContentMaxWidth,
} from "@pi-desktop/shared";
import { api } from "../lib/api";
import { useAppStore } from "../stores/app-store";
import { cx } from "./ui";

type DragState = {
  pointerId: number;
  startClientX: number;
  startWidth: number;
  paneWidth: number;
  currentWidth: number;
  frame: number;
};

function surfaceOf(node: HTMLElement | null): HTMLElement | null {
  return node?.closest<HTMLElement>(".chat-surface") ?? null;
}

function applyPreferredWidth(surface: HTMLElement | null, width: number) {
  if (!surface) return;
  const px = `${width}px`;
  surface.style.setProperty("--chat-content-max-width", px);
  surface.style.setProperty("--chat-composer-max-width", px);
  // The per-message prose width must track the band, otherwise the message
  // rows stay frozen at the `.main-pane` default (760px) while the band it
  // sits in widens (the bug this fixes: content no longer scales with it).
  surface.style.setProperty("--chat-prose-max-width", px);

}

function setResizing(surface: HTMLElement | null, on: boolean) {
  if (!surface) return;
  if (on) {
    surface.dataset.chatResizing = "true";
    document.documentElement.dataset.chatResizing = "true";
  } else {
    delete surface.dataset.chatResizing;
    delete document.documentElement.dataset.chatResizing;
  }
}

function usePersistedChatWidth() {
  return useAppStore((state) =>
    resolveChatContentMaxWidth(state.settings?.chatContentMaxWidth),
  );
}

/**
 * Applies the saved band width to the chat surface even while no composer (and
 * so no grip) is mounted.
 */
export function ConversationWidthSync() {
  const hostRef = useRef<HTMLSpanElement>(null);
  const persisted = usePersistedChatWidth();
  useLayoutEffect(() => {
    applyPreferredWidth(surfaceOf(hostRef.current), persisted);
  }, [persisted]);
  return <span ref={hostRef} hidden />;
}

/**
 * Width grip beside the composer's right edge (R11.13). The composer shares
 * the band width, so the grip follows the text column and stays clear of the
 * work panel's resize edge. The band is centered: 1px of drag → 2px of width.
 */
export function ChatWidthGrip() {
  const { t } = useTranslation();
  const hostRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<DragState | null>(null);
  const persisted = usePersistedChatWidth();
  const [dragWidth, setDragWidth] = useState<number | null>(null);
  const [paneWidth, setPaneWidth] = useState(0);
  const width = dragWidth ?? persisted;

  useLayoutEffect(() => {
    applyPreferredWidth(surfaceOf(hostRef.current), width);
  }, [width]);

  useEffect(() => {
    const surface = surfaceOf(hostRef.current);
    if (!surface) return;
    const sync = () => setPaneWidth(surface.clientWidth);
    sync();
    const observer = new ResizeObserver(sync);
    observer.observe(surface);
    return () => observer.disconnect();
  }, []);

  useEffect(
    () => () => {
      const drag = dragRef.current;
      if (drag?.frame) cancelAnimationFrame(drag.frame);
      dragRef.current = null;
      setResizing(surfaceOf(hostRef.current), false);
    },
    [],
  );

  const persistWidth = useCallback(async (next: number) => {
    const settings = useAppStore.getState().settings;
    if (!settings) return;
    if (settings.chatContentMaxWidth === next) return;
    const payload = { ...settings, chatContentMaxWidth: next };
    try {
      await api.setSettings(payload);
      useAppStore.setState({ settings: payload });
    } catch {
      /* keep the live band; the next drag can retry */
    }
  }, []);

  const finishDrag = useCallback(
    (target: HTMLDivElement, pointerId: number, cancelled: boolean) => {
      const drag = dragRef.current;
      if (drag?.pointerId !== pointerId) return;
      if (drag.frame) cancelAnimationFrame(drag.frame);
      dragRef.current = null;
      if (target.hasPointerCapture(pointerId)) {
        target.releasePointerCapture(pointerId);
      }
      setResizing(surfaceOf(hostRef.current), false);
      const committed = cancelled ? drag.startWidth : drag.currentWidth;
      setDragWidth(null);
      applyPreferredWidth(surfaceOf(hostRef.current), committed);
      if (!cancelled) void persistWidth(committed);
    },
    [persistWidth],
  );

  const onPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (event.button !== 0) return;
      event.preventDefault();
      event.stopPropagation();
      event.currentTarget.focus({ preventScroll: true });
      const surface = surfaceOf(hostRef.current);
      const livePane = surface?.clientWidth ?? paneWidth;
      const startWidth = clampChatContentMaxWidth(width, livePane);
      dragRef.current = {
        pointerId: event.pointerId,
        startClientX: event.clientX,
        startWidth,
        paneWidth: livePane,
        currentWidth: startWidth,
        frame: 0,
      };
      setDragWidth(startWidth);
      setResizing(surface, true);
      event.currentTarget.setPointerCapture(event.pointerId);
    },
    [paneWidth, width],
  );

  const onPointerMove = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const drag = dragRef.current;
      if (drag?.pointerId !== event.pointerId) return;
      drag.currentWidth = chatContentWidthFromDrag({
        side: "right",
        startWidth: drag.startWidth,
        startClientX: drag.startClientX,
        clientX: event.clientX,
        paneWidth: drag.paneWidth,
      });
      if (drag.frame) return;
      drag.frame = requestAnimationFrame(() => {
        if (dragRef.current !== drag) return;
        drag.frame = 0;
        setDragWidth(drag.currentWidth);
      });
    },
    [],
  );

  const onPointerUp = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      finishDrag(event.currentTarget, event.pointerId, false);
    },
    [finishDrag],
  );

  const onPointerCancel = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      finishDrag(event.currentTarget, event.pointerId, true);
    },
    [finishDrag],
  );

  const onDoubleClick = useCallback(() => {
    setDragWidth(null);
    applyPreferredWidth(surfaceOf(hostRef.current), DEFAULT_CHAT_CONTENT_MAX_WIDTH);
    void persistWidth(DEFAULT_CHAT_CONTENT_MAX_WIDTH);
  }, [persistWidth]);

  const onKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      const drag = dragRef.current;
      if (event.key === "Escape" && drag) {
        event.preventDefault();
        finishDrag(event.currentTarget, drag.pointerId, true);
        return;
      }
      const livePane = surfaceOf(hostRef.current)?.clientWidth ?? paneWidth;
      const step = event.shiftKey ? 32 : 16;
      let next: number | null = null;
      if (event.key === "ArrowRight") {
        next = width + step;
      } else if (event.key === "ArrowLeft") {
        next = width - step;
      } else if (event.key === "Home") {
        next = DEFAULT_CHAT_CONTENT_MAX_WIDTH;
      } else if (event.key === "End") {
        next = Number.POSITIVE_INFINITY;
      }
      if (next === null) return;
      event.preventDefault();
      const clamped = clampChatContentMaxWidth(next, livePane);
      applyPreferredWidth(surfaceOf(hostRef.current), clamped);
      void persistWidth(clamped);
    },
    [finishDrag, paneWidth, persistWidth, width],
  );

  const max = clampChatContentMaxWidth(Number.POSITIVE_INFINITY, paneWidth || 10_000);
  const resizing = dragWidth !== null;

  return (
    <div
      ref={hostRef}
      role="separator"
      aria-orientation="vertical"
      aria-label={t("nav.resizeChatWidth")}
      aria-valuemin={MIN_CHAT_CONTENT_MAX_WIDTH}
      aria-valuemax={max}
      aria-valuenow={width}
      aria-valuetext={t("nav.chatWidth", { width })}
      data-testid="chat-width-grip"
      tabIndex={0}
      className={cx("chat-width-grip", "no-drag", resizing && "is-resizing")}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
      onDoubleClick={onDoubleClick}
      onKeyDown={onKeyDown}
    />
  );
}
