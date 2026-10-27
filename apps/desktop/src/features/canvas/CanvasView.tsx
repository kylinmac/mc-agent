import {
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { useTranslation } from "react-i18next";
import { cx } from "../../components/ui";
import { IconChat, IconCircleAlert, IconMinus, IconPlus, IconTarget, IconUndo2, IconX } from "../../components/icons";
import { ContextMenu, useContextMenu } from "../../components/ContextMenu";
import { api } from "../../lib/api";
import type { Canvas, CanvasAnchorInput, CanvasElement, CanvasNode, CanvasOp, CanvasThread } from "@pi-desktop/shared";
import { CanvasFrame, type CanvasFrameHandle } from "./CanvasFrame";
import { useCanvas } from "./use-canvas";
import {
  EMPTY_HISTORY,
  PLACEHOLDER_ZOOM,
  boundsOf,
  elementBox,
  errorsAttachment,
  fitView,
  intersects,
  inverseOps,
  noteAttachment,
  pinPosition,
  pushHistory,
  rectFrom,
  toCanvas,
  toScreen,
  visibleArea,
  zoomAt,
  type Box,
  type CanvasAttachment,
  type CanvasHistory,
  type CanvasViewState,
  type CanvasViewport,
  type Point,
} from "./canvas-model";
import "./canvas.css";

/*
  mc-agent prototype canvas, tier A (docs/mc-agent/prototype-canvas.md). The
  agent draws; the user looks, tries and comments. Artboards (sandboxed HTML),
  the agent's notes and titles sit on a pan-and-zoom stage. The user can enter
  an artboard to use it, pick elements inside it, arrange artboards by
  dragging, and leave comment threads on elements, artboard points or the
  canvas, sent to the conversation beside it. The view state (what is visible
  and selected) goes up so the conversation's next message can carry it.
*/

type Tool = "select" | "hand" | "comment";

type Drag =
  | { kind: "pan"; start: Point; origin: CanvasViewport }
  | { kind: "move"; start: Point; origin: Map<string, Point>; moved: boolean }
  // On an artboard's page: a click picks the element there; a drag pans.
  | { kind: "press"; boardId: string; client: Point; origin: CanvasViewport; additive: boolean }
  | { kind: "marquee"; start: Point; current: Point; additive: boolean };

type Composer = {
  anchor: CanvasAnchorInput;
  at: Point;
  label?: string | null;
  /** The element the comment is about, outlined while it is written. */
  target?: { boardId: string; rect: Box };
};

type Hover = { boardId: string; tid: number; rect: Box; label?: string | null };

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

const POPOVER_W = 340;
const POPOVER_H = 240;

/** Where a popover goes for a point: beside it, kept inside the stage. */
function popoverPlace(at: Point, bounds: { w: number; h: number }, dx = 12, dy = 12) {
  const left = Math.max(8, Math.min(at.x + dx, bounds.w - POPOVER_W - 8));
  const top = at.y + dy + POPOVER_H > bounds.h ? Math.max(8, at.y - POPOVER_H) : at.y + dy;
  return { left, top };
}

function editableTarget(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName));
}

export function CanvasView({
  groupId,
  canvasId,
  head,
  onViewState,
  onAttach,
  onSendThread,
}: {
  groupId: string;
  canvasId: string;
  /** The canvas switcher, shown at the start of the toolbar. */
  head?: ReactNode;
  onViewState: (state: CanvasViewState | null) => void;
  /** Put something from the canvas on the conversation's next message. */
  onAttach: (attachment: CanvasAttachment) => void;
  /** Hand a thread to the conversation, now or with the next message. */
  onSendThread: (thread: CanvasThread, queue: boolean) => void;
}) {
  const { t } = useTranslation();
  const { canvas, comments, error, apply, preview, revert, setThreads } = useCanvas(groupId, canvasId);
  const stage = useRef<HTMLDivElement | null>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [view, setView] = useState<CanvasViewport | null>(null);
  const [tool, setTool] = useState<Tool>("select");
  const [spaceHeld, setSpaceHeld] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [nodes, setNodes] = useState<Array<CanvasNode & { rect: Box }>>([]);
  const [entered, setEntered] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string[]>>({});
  const [history, setHistory] = useState<CanvasHistory>(EMPTY_HISTORY);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [composer, setComposer] = useState<Composer | null>(null);
  const [hover, setHover] = useState<Hover | null>(null);
  const [openThread, setOpenThread] = useState<string | null>(null);
  const [panel, setPanel] = useState<"open" | "resolved" | null>(null);
  const [pinBoxes, setPinBoxes] = useState<Map<string, Record<number, Box>>>(new Map());
  const [ready, setReady] = useState<Record<string, number>>({});
  const [notice, setNotice] = useState<string | null>(null);
  const frames = useRef(new Map<string, CanvasFrameHandle>());
  /** Whether the pointer is over this canvas (`:hover` is not kept up to date while it is captured). */
  const pointerInside = useRef(false);
  const { contextMenu: menu, openContextMenu, closeContextMenu } = useContextMenu();

  const fail = useCallback((failure: unknown) => setNotice(failure instanceof Error ? failure.message : String(failure)), []);
  const conflict = useCallback(() => setNotice(t("mcProject.canvasConflict")), [t]);

  // ---- viewport ----------------------------------------------------------------

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
    setSelected([]);
    setNodes([]);
    setEntered(null);
    setErrors({});
    setHistory(EMPTY_HISTORY);
    setComposer(null);
    setOpenThread(null);
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

  const stagePoint = (clientX: number, clientY: number): Point => {
    const rect = stage.current?.getBoundingClientRect();
    return { x: clientX - (rect?.left ?? 0), y: clientY - (rect?.top ?? 0) };
  };
  const canvasPoint = (clientX: number, clientY: number): Point =>
    view ? toCanvas(stagePoint(clientX, clientY), view) : { x: 0, y: 0 };

  // ---- elements -----------------------------------------------------------------

  const elements = useMemo(() => canvas?.elements ?? [], [canvas]);
  const byId = useMemo(() => new Map(elements.map((element) => [element.id, element])), [elements]);
  const area = view && size.w ? visibleArea(view, size.w, size.h) : null;
  const mountArea = view && size.w ? visibleArea(view, size.w, size.h, 600) : null;

  /** Apply a user's change, remembering how to undo it. */
  const change = useCallback(
    async (ops: CanvasOp[]) => {
      if (!canvas || !ops.length) return null;
      try {
        const result = await apply(ops, conflict);
        if (result) setHistory((current) => pushHistory(current, inverseOps(result.before, ops)));
        return result;
      } catch (failure) {
        revert();
        fail(failure);
        return null;
      }
    },
    [apply, canvas, conflict, fail, revert],
  );

  const undo = useCallback(
    async (direction: "undo" | "redo") => {
      const stack = history[direction];
      const ops = stack[stack.length - 1];
      if (!ops) return;
      try {
        const result = await apply(ops, conflict);
        if (!result) {
          setHistory(EMPTY_HISTORY);
          return;
        }
        const inverse = inverseOps(result.before, ops);
        setHistory((current) => {
          const rest = current[direction].slice(0, -1);
          const other = direction === "undo" ? "redo" : "undo";
          return inverse
            ? ({ [direction]: rest, [other]: [...current[other], inverse] } as CanvasHistory)
            : EMPTY_HISTORY;
        });
      } catch (failure) {
        fail(failure);
        setHistory(EMPTY_HISTORY);
      }
    },
    [apply, conflict, fail, history],
  );

  const removeElements = useCallback(
    async (ids: readonly string[]) => {
      const targets = ids.map((id) => byId.get(id)).filter((element): element is CanvasElement => !!element);
      if (!targets.length) return;
      const frameCount = targets.filter((element) => element.type === "frame").length;
      if (frameCount && !window.confirm(t("mcProject.canvasDeleteBoardsConfirm", { count: frameCount }))) return;
      await change(targets.map((element) => ({ op: "remove", id: element.id })));
      setSelected([]);
      setNodes([]);
    },
    [byId, change, t],
  );

  // ---- picking inside artboards -------------------------------------------------

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
    [canvasId, groupId, view],
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
    [byId, canvasId, groupId, view],
  );

  // ---- comments -----------------------------------------------------------------

  const threads = comments.threads;
  const openThreads = threads.filter((thread) => thread.status === "open");
  const numberOf = useMemo(() => new Map(openThreads.map((thread, index) => [thread.id, index + 1])), [openThreads]);

  // Element pins follow their element: ask each artboard where those are.
  const pinRequest = useMemo(() => {
    const wanted = new Map<string, number[]>();
    for (const thread of threads) {
      const node = thread.located.state === "ok" ? thread.located.node : undefined;
      if (!node) continue;
      wanted.set(node.boardId, [...(wanted.get(node.boardId) ?? []), node.tid]);
    }
    return wanted;
  }, [threads]);
  const readyKey = JSON.stringify(ready);
  useEffect(() => {
    let live = true;
    void (async () => {
      const next = new Map<string, Record<number, Box>>();
      for (const [boardId, tids] of pinRequest) {
        const handle = frames.current.get(boardId);
        if (handle) next.set(boardId, await handle.rects(tids));
      }
      if (live) setPinBoxes(next);
    })();
    return () => {
      live = false;
    };
  }, [pinRequest, readyKey]);

  const startComment = useCallback(
    async (clientX: number, clientY: number, boardId: string | null) => {
      const at = stagePoint(clientX, clientY);
      if (!boardId) {
        const point = canvasPoint(clientX, clientY);
        setComposer({ anchor: { kind: "canvas", x: Math.round(point.x), y: Math.round(point.y) }, at });
        return;
      }
      const picked = await pickAt(boardId, clientX, clientY);
      const local = picked?.local ?? { x: 0, y: 0 };
      const point = { x: Math.round(local.x), y: Math.round(local.y) };
      setHover(null);
      setComposer(
        picked?.node
          ? {
              anchor: { kind: "element", boardId, node: picked.node.tid, ...point },
              at,
              label: picked.node.label,
              target: { boardId, rect: picked.node.rect },
            }
          : { anchor: { kind: "board", boardId, ...point }, at },
      );
    },
    // stagePoint and canvasPoint read the current view.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [pickAt, view],
  );

  const submitComment = async (text: string, sendToAgent: boolean, queue: boolean) => {
    if (!composer) return;
    try {
      const { threadId, comments: next } = await api.canvas.call("canvas.comments.add", {
        groupId,
        canvasId,
        anchor: composer.anchor,
        text,
      });
      setThreads(next);
      setComposer(null);
      const thread = next.threads.find((candidate) => candidate.id === threadId);
      if (sendToAgent && thread) onSendThread(thread, queue);
      else if (thread) setOpenThread(thread.id);
    } catch (failure) {
      fail(failure);
    }
  };

  // ---- view state for the conversation --------------------------------------------------

  const lastState = useRef("");
  useEffect(() => {
    if (!canvas || !area) {
      if (lastState.current !== "null") {
        lastState.current = "null";
        onViewState(null);
      }
      return;
    }
    const frameIds = elements.filter((element) => element.type === "frame");
    const state: CanvasViewState = {
      canvasId,
      title: canvas.title,
      version: canvas.version,
      visibleBoards: frameIds.filter((element) => intersects(elementBox(element), area)).map((element) => element.id),
      selectedBoards: [
        ...new Set([
          ...selected.filter((id) => byId.get(id)?.type === "frame"),
          ...nodes.map((node) => node.boardId),
        ]),
      ],
      selected: nodes.map(({ rect: _rect, ...node }) => node),
      errored: Object.entries(errors)
        .filter(([, messages]) => messages.length)
        .map(([key, messages]) => ({ boardId: key.split(":")[0], message: messages[0] })),
      dirty: drag !== null,
    };
    const serialized = JSON.stringify(state);
    if (serialized === lastState.current) return;
    lastState.current = serialized;
    onViewState(state);
  });
  useEffect(() => () => onViewState(null), [onViewState]);

  // ---- keyboard ------------------------------------------------------------------

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const node = stage.current;
      if (!node?.isConnected) return;
      // Escape always steps out of what is open here, unless the user is
      // typing somewhere else in the window.
      if (event.type === "keydown" && event.key === "Escape" && (composer || openThread || entered)) {
        const outside = editableTarget(event.target) && !node.closest(".mc-canvas")?.contains(event.target as Node);
        if (!outside) {
          if (composer) setComposer(null);
          else if (openThread) setOpenThread(null);
          else setEntered(null);
          return;
        }
      }
      // Other keys only while the pointer or focus is on this canvas: it
      // shares the window with the conversation.
      if (!pointerInside.current && !node.closest(".mc-canvas")?.matches(":focus-within")) {
        if (event.type === "keyup" && event.key === " ") setSpaceHeld(false);
        return;
      }
      if (event.key === " " && !editableTarget(event.target)) {
        if (event.type === "keydown") {
          if (!event.repeat) setSpaceHeld(true);
          event.preventDefault();
        } else setSpaceHeld(false);
        return;
      }
      if (event.type !== "keydown" || editableTarget(event.target)) return;
      const mod = event.metaKey || event.ctrlKey;
      if (event.key === "Escape") {
        setSelected([]);
        setNodes([]);
        return;
      }
      if (mod && event.key.toLowerCase() === "z") {
        event.preventDefault();
        void undo(event.shiftKey ? "redo" : "undo");
        return;
      }
      if (mod) return;
      if ((event.key === "Delete" || event.key === "Backspace") && selected.length) {
        event.preventDefault();
        void removeElements(selected);
        return;
      }
      const tools: Record<string, Tool> = { v: "select", h: "hand", c: "comment" };
      const next = tools[event.key.toLowerCase()];
      if (next) setTool(next);
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("keyup", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("keyup", onKey);
    };
  }, [composer, entered, openThread, removeElements, selected, undo]);

  // ---- pointer --------------------------------------------------------------------

  const panning = tool === "hand" || spaceHeld;

  const beginPan = (event: ReactPointerEvent) => {
    if (!view) return;
    (event.currentTarget as HTMLElement).setPointerCapture?.(event.pointerId);
    autoView.current = false;
    setDrag({ kind: "pan", start: { x: event.clientX, y: event.clientY }, origin: view });
  };

  const onStageDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button === 1 || (event.button === 0 && panning)) {
      event.preventDefault();
      beginPan(event);
      return;
    }
    if (event.button !== 0 || !view) return;
    setComposer(null);
    setEntered(null);
    if (tool === "comment") {
      void startComment(event.clientX, event.clientY, null);
      return;
    }
    const point = canvasPoint(event.clientX, event.clientY);
    if (!event.shiftKey) {
      setSelected([]);
      setNodes([]);
    }
    (event.currentTarget as HTMLElement).setPointerCapture?.(event.pointerId);
    setDrag({ kind: "marquee", start: point, current: point, additive: event.shiftKey });
  };

  /**
   * Pointer down on an artboard's page: a click picks the element under it
   * (shift adds to the picked ones), a drag pans the canvas. Moving the
   * artboard itself is done by its name strip.
   */
  const onBoardDown = (event: ReactPointerEvent<HTMLElement>, element: CanvasElement) => {
    if (entered === element.id) return;
    if (event.button === 1 || (event.button === 0 && panning)) {
      event.preventDefault();
      event.stopPropagation();
      beginPan(event);
      return;
    }
    if (event.button !== 0 || !view) return;
    event.stopPropagation();
    setComposer(null);
    setEntered(null);
    if (tool === "comment") {
      void startComment(event.clientX, event.clientY, element.id);
      return;
    }
    (event.currentTarget as HTMLElement).setPointerCapture?.(event.pointerId);
    setDrag({
      kind: "press",
      boardId: element.id,
      client: { x: event.clientX, y: event.clientY },
      origin: view,
      additive: event.shiftKey,
    });
  };

  /** Pointer down on an element: select it and start moving the selection. */
  const onElementDown = (event: ReactPointerEvent<HTMLElement>, element: CanvasElement) => {
    if (event.button === 1 || (event.button === 0 && panning)) {
      event.preventDefault();
      event.stopPropagation();
      beginPan(event);
      return;
    }
    if (event.button !== 0 || !view) return;
    event.stopPropagation();
    setComposer(null);
    if (tool === "comment") {
      void startComment(event.clientX, event.clientY, element.type === "frame" ? element.id : null);
      return;
    }
    let next = selected;
    if (event.shiftKey) {
      next = selected.includes(element.id) ? selected.filter((id) => id !== element.id) : [...selected, element.id];
    } else if (!selected.includes(element.id)) {
      next = [element.id];
      setNodes([]);
    }
    setSelected(next);
    const origin = new Map<string, Point>();
    for (const id of next) {
      const target = byId.get(id);
      if (target) origin.set(id, { x: target.x, y: target.y });
    }
    (event.currentTarget as HTMLElement).setPointerCapture?.(event.pointerId);
    setDrag({
      kind: "move",
      start: canvasPoint(event.clientX, event.clientY),
      origin,
      moved: false,
    });
  };

  const onPointerMove = (event: ReactPointerEvent) => {
    if (!view) return;
    if (!drag) {
      const board = tool !== "hand" && !spaceHeld ? (event.target as HTMLElement).closest?.("[data-board]") : null;
      const boardId = board?.getAttribute("data-board");
      if (boardId && boardId !== entered && (event.target as HTMLElement).classList.contains("mc-canvas-board-cover"))
        trackHover(boardId, event.clientX, event.clientY);
      else if (hover) setHover(null);
      return;
    }
    if (drag.kind === "press") {
      if (Math.hypot(event.clientX - drag.client.x, event.clientY - drag.client.y) < 4) return;
      autoView.current = false;
      setHover(null);
      setDrag({ kind: "pan", start: drag.client, origin: drag.origin });
      return;
    }
    if (drag.kind === "pan") {
      setView({
        ...drag.origin,
        panX: drag.origin.panX + event.clientX - drag.start.x,
        panY: drag.origin.panY + event.clientY - drag.start.y,
      });
      return;
    }
    const point = canvasPoint(event.clientX, event.clientY);
    if (drag.kind === "marquee") {
      setDrag({ ...drag, current: point });
      return;
    }
    const dx = point.x - drag.start.x;
    const dy = point.y - drag.start.y;
    if (!drag.moved && Math.hypot(dx, dy) * view.zoom < 3) return;
    if (!drag.moved) setDrag({ ...drag, moved: true });
    preview((current) => ({
      ...current,
      elements: current.elements.map((element) => {
        const origin = drag.origin.get(element.id);
        return origin ? { ...element, x: Math.round(origin.x + dx), y: Math.round(origin.y + dy) } : element;
      }),
    }));
  };
  const onPointerUp = (event: ReactPointerEvent) => {
    if (!drag) return;
    setDrag(null);
    if (drag.kind === "pan") return;
    if (drag.kind === "marquee") {
      const box = rectFrom(drag.start, drag.current);
      if (box.w * (view?.zoom ?? 1) < 3 && box.h * (view?.zoom ?? 1) < 3) return;
      const hits = elements.filter((element) => intersects(elementBox(element), box)).map((element) => element.id);
      setSelected((current) => (drag.additive ? [...new Set([...current, ...hits])] : hits));
      return;
    }
    if (drag.kind === "press") {
      const { boardId, client, additive } = drag;
      setSelected([boardId]);
      void pickAt(boardId, client.x, client.y).then((picked) => {
        const node = picked?.node;
        setNodes((current) => {
          const kept = additive ? current.filter((entry) => entry.boardId === boardId) : [];
          if (!node) return kept;
          return [...kept.filter((entry) => entry.address !== node.address), node];
        });
      });
      return;
    }
    if (!drag.moved) return;
    const moved = [...drag.origin.keys()]
      .map((id) => byId.get(id))
      .filter((element): element is CanvasElement => !!element);
    void change(moved.map((element) => ({ op: "update", id: element.id, set: { x: element.x, y: element.y } })));
  };

  // ---- rendering --------------------------------------------------------------------

  // The stage stays the same element while the canvas loads: its size is
  // observed once.
  if (!canvas || !view) {
    return (
      <div className="mc-canvas">
        <div className="mc-canvas-stage" ref={stage}>
          {error ? <p className="mc-canvas-error mc-canvas-hint">{error}</p> : null}
        </div>
        {/* After the stage, as in the loaded canvas, so the stage stays the same element. */}
        <div className="mc-canvas-toolbar">{head}</div>
      </div>
    );
  }

  const zoom = view.zoom;
  const ink = 1 / zoom;
  const worldStyle = { transform: `translate(${view.panX}px, ${view.panY}px) scale(${zoom})` };
  const marquee = drag?.kind === "marquee" ? rectFrom(drag.start, drag.current) : null;

  const elementMenu = (event: ReactMouseEvent<HTMLElement>, element: CanvasElement) =>
    openContextMenu(event, {
      label: element.title || element.text?.slice(0, 40) || element.id,
      items: [
        ...(element.type === "frame" && element.hasPrev
          ? [{ id: "restore", label: t("mcProject.canvasRestorePrevious"), onSelect: () => void change([{ op: "restore", id: element.id }]) }]
          : []),
        ...(element.type === "note"
          ? [{ id: "attach", label: t("mcProject.canvasAttachNote"), onSelect: () => onAttach(noteAttachment(canvasId, element)) }]
          : []),
        {
          id: "delete",
          label: t("mcProject.canvasDelete"),
          danger: true,
          separatorBefore: element.type === "note" || element.hasPrev,
          onSelect: () => void removeElements([element.id]),
        },
      ],
    });

  const renderElement = (element: CanvasElement) => {
    const isSelected = selected.includes(element.id);
    const common = {
      "data-element": element.id,
      onPointerDown: (event: ReactPointerEvent<HTMLDivElement>) => onElementDown(event, element),
      onContextMenu: (event: ReactMouseEvent<HTMLDivElement>) => elementMenu(event, element),
    };
    if (element.type === "frame") {
      const { onPointerDown: moveBoard, ...menu } = common;
      const errorKey = `${element.id}:${element.rev}`;
      const boardErrors = errors[errorKey] ?? [];
      const mounted = zoom >= PLACEHOLDER_ZOOM && mountArea !== null && intersects(elementBox(element), mountArea);
      const isEntered = entered === element.id;
      return (
        <div
          key={element.id}
          {...menu}
          onPointerDown={(event) => onBoardDown(event, element)}
          onPointerLeave={() => setHover((current) => (current?.boardId === element.id ? null : current))}
          data-board={element.id}
          className={cx("mc-canvas-board", isSelected && "is-selected", isEntered && "is-entered")}
          style={{ left: element.x, top: element.y, width: element.w, height: element.h, outlineWidth: isSelected ? 2 * ink : ink }}
          onDoubleClick={() => {
            if (tool === "select") setEntered(element.id);
          }}
        >
          <div
            className="mc-canvas-strip"
            style={{ fontSize: 12 * ink, top: -22 * ink, height: 20 * ink }}
            onPointerDown={(event) => moveBoard(event)}
          >
            <span>{element.title || element.id}</span>
            {isEntered ? (
              <span className="mc-canvas-entered-hint">{t("mcProject.canvasEnteredHint")}</span>
            ) : (
              <span className="mc-canvas-strip-size">
                {element.w}×{element.h}
              </span>
            )}
            {element.hasPrev ? (
              <button
                type="button"
                className="mc-canvas-strip-action"
                onPointerDown={(event) => event.stopPropagation()}
                onClick={() => void change([{ op: "restore", id: element.id }])}
              >
                <IconUndo2 size={11 * ink} />
                {t("mcProject.canvasRestorePrevious")}
              </button>
            ) : null}
          </div>
          {mounted ? (
            <CanvasFrame
              ref={(handle) => {
                if (handle) frames.current.set(element.id, handle);
                else frames.current.delete(element.id);
              }}
              groupId={groupId}
              canvasId={canvasId}
              boardId={element.id}
              rev={element.rev}
              title={element.title || element.id}
              width={element.w}
              height={element.h}
              interactive={isEntered}
              onReady={() => setReady((current) => ({ ...current, [element.id]: (current[element.id] ?? 0) + 1 }))}
              onError={(message) =>
                setErrors((current) => {
                  const list = current[errorKey] ?? [];
                  return list.length >= 10 ? current : { ...current, [errorKey]: [...list, message] };
                })
              }
              onEscape={() => setEntered(null)}
            />
          ) : (
            <div className="mc-canvas-placeholder" style={{ fontSize: 14 * ink }}>
              {element.title || element.id}
            </div>
          )}
          {isEntered ? null : <div className="mc-canvas-board-cover" />}
          {hover?.boardId === element.id && !drag ? (
            <div
              className="mc-canvas-hover"
              style={{ left: hover.rect.x, top: hover.rect.y, width: hover.rect.w, height: hover.rect.h, outlineWidth: ink }}
            >
              {hover.label ? (
                <span style={{ fontSize: 11 * ink, top: -18 * ink, padding: `${1 * ink}px ${5 * ink}px` }}>{hover.label}</span>
              ) : null}
            </div>
          ) : null}
          {composer?.target?.boardId === element.id ? (
            <div
              className="mc-canvas-node"
              style={{
                left: composer.target.rect.x,
                top: composer.target.rect.y,
                width: composer.target.rect.w,
                height: composer.target.rect.h,
                outlineWidth: 2 * ink,
              }}
            />
          ) : null}
          {nodes
            .filter((node) => node.boardId === element.id)
            .map((node) => (
              <div
                key={node.address}
                className="mc-canvas-node"
                style={{ left: node.rect.x, top: node.rect.y, width: node.rect.w, height: node.rect.h, outlineWidth: 2 * ink }}
              />
            ))}
          {boardErrors.length ? (
            // Under the artboard, so it never covers what it reports on;
            // readable when zoomed out.
            <div
              className="mc-canvas-board-error"
              style={{
                fontSize: 12 * Math.min(ink, 2.5),
                marginTop: 4 * ink,
                padding: `${6 * Math.min(ink, 2.5)}px ${8 * Math.min(ink, 2.5)}px`,
              }}
            >
              <IconCircleAlert size={13 * Math.min(ink, 2.5)} />
              <span className="mc-canvas-board-error-text">{t("mcProject.canvasBoardError", { message: boardErrors[0] })}</span>
              <button
                type="button"
                onPointerDown={(event) => event.stopPropagation()}
                onClick={() => onAttach(errorsAttachment(canvasId, element.id, boardErrors))}
              >
                {t("mcProject.canvasFixWithAgent")}
              </button>
            </div>
          ) : null}
        </div>
      );
    }
    const box = elementBox(element);
    return (
      <div
        key={element.id}
        {...common}
        className={cx(
          element.type === "title" ? "mc-canvas-title" : "mc-canvas-note",
          element.type === "note" && `is-${element.color ?? "yellow"}`,
          isSelected && "is-selected",
        )}
        style={{
          left: element.x,
          top: element.y,
          width: element.w,
          ...(element.h ? { height: element.h } : element.type === "note" ? { maxHeight: box.w * (4 / 3) } : {}),
          outlineWidth: isSelected ? 2 * ink : 0,
        }}
      >
        <div className="mc-canvas-note-text">{element.text}</div>
      </div>
    );
  };

  const thread = openThread ? threads.find((candidate) => candidate.id === openThread) : undefined;
  const threadAt = thread ? pinPosition(thread, canvas, pinBoxes) : null;

  return (
    <div
      className={cx("mc-canvas", `tool-${panning ? "hand" : tool}`, drag?.kind === "pan" && "is-panning")}
      onPointerEnter={() => {
        pointerInside.current = true;
      }}
      onPointerMoveCapture={() => {
        pointerInside.current = true;
      }}
      onPointerLeave={() => {
        pointerInside.current = false;
      }}
    >
      <div
        className="mc-canvas-stage"
        ref={stage}
        onPointerDown={onStageDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={() => {
          setDrag(null);
          revert();
        }}
        style={{ backgroundSize: `${24 * zoom}px ${24 * zoom}px`, backgroundPosition: `${view.panX}px ${view.panY}px` }}
      >
        <div className="mc-canvas-world" style={worldStyle}>
          {elements.map(renderElement)}
          {openThreads.map((candidate) => {
            const at = pinPosition(candidate, canvas, pinBoxes);
            if (!at) return null;
            return (
              <button
                key={candidate.id}
                type="button"
                className={cx("mc-canvas-pin", candidate.agentSession && "is-sent", openThread === candidate.id && "is-open")}
                style={{ left: at.x, top: at.y, width: 22 * ink, height: 22 * ink, fontSize: 11 * ink, marginLeft: -11 * ink, marginTop: -11 * ink }}
                title={candidate.messages[0]?.text}
                onPointerDown={(event) => event.stopPropagation()}
                onClick={() => setOpenThread(candidate.id)}
              >
                {numberOf.get(candidate.id)}
              </button>
            );
          })}
          {marquee ? (
            <div
              className="mc-canvas-marquee"
              style={{ left: marquee.x, top: marquee.y, width: marquee.w, height: marquee.h, borderWidth: ink }}
            />
          ) : null}
        </div>
        {composer ? (
          <CommentComposer
            at={composer.at}
            bounds={size}
            label={composer.label}
            onCancel={() => setComposer(null)}
            onSubmit={(text, sendToAgent, queue) => void submitComment(text, sendToAgent, queue)}
          />
        ) : null}
        {thread && threadAt ? (
          <ThreadPopover
            key={thread.id}
            at={toScreen(threadAt, view)}
            bounds={size}
            thread={thread}
            number={numberOf.get(thread.id)}
            onClose={() => setOpenThread(null)}
            onReply={async (text) => {
              const { comments: next } = await api.canvas.call("canvas.comments.reply", {
                groupId,
                canvasId,
                threadId: thread.id,
                text,
              });
              setThreads(next);
            }}
            onStatus={async (status) => {
              const { comments: next } = await api.canvas.call("canvas.comments.setStatus", {
                groupId,
                canvasId,
                threadId: thread.id,
                status,
              });
              setThreads(next);
              if (status === "resolved") setOpenThread(null);
            }}
            onDelete={async () => {
              if (!window.confirm(t("mcProject.canvasDeleteThreadConfirm"))) return;
              const { comments: next } = await api.canvas.call("canvas.comments.delete", {
                groupId,
                canvasId,
                threadId: thread.id,
              });
              setThreads(next);
              setOpenThread(null);
            }}
            onSend={(queue) => onSendThread(thread, queue)}
            onError={fail}
          />
        ) : null}
      </div>

      <div className="mc-canvas-toolbar" onPointerDown={(event) => event.stopPropagation()}>
        {head}
        <span className="mc-canvas-toolbar-spacer" />
        {(
          [
            ["select", t("mcProject.canvasToolSelect"), "V", <IconTarget size={14} key="i" />],
            ["hand", t("mcProject.canvasToolHand"), "H", <span className="mc-canvas-hand" aria-hidden key="i">✋</span>],
            ["comment", t("mcProject.canvasToolComment"), "C", <IconChat size={14} key="i" />],
          ] as const
        ).map(([id, label, key, icon]) => (
          <button
            key={id}
            type="button"
            className={cx("mc-canvas-tool", tool === id && "active")}
            title={`${label} (${key})`}
            aria-label={label}
            aria-pressed={tool === id}
            onClick={() => setTool(id)}
          >
            {icon}
          </button>
        ))}
        <span className="mc-canvas-toolbar-sep" />
        <button type="button" className="mc-canvas-tool" title={t("mcProject.canvasZoomOut")} aria-label={t("mcProject.canvasZoomOut")} onClick={() => userView(zoomAt(view, 1 / 1.25, { x: size.w / 2, y: size.h / 2 }))}>
          <IconMinus size={14} />
        </button>
        <button
          type="button"
          className="mc-canvas-zoom"
          title={t("mcProject.canvasZoomFit")}
          onClick={() => {
            autoView.current = true;
            fitAll();
          }}
        >
          {Math.round(zoom * 100)}%
        </button>
        <button type="button" className="mc-canvas-tool" title={t("mcProject.canvasZoomIn")} aria-label={t("mcProject.canvasZoomIn")} onClick={() => userView(zoomAt(view, 1.25, { x: size.w / 2, y: size.h / 2 }))}>
          <IconPlus size={14} />
        </button>
        <span className="mc-canvas-toolbar-sep" />
        <button
          type="button"
          className={cx("mc-canvas-tool mc-canvas-tool-wide", panel && "active")}
          onClick={() => setPanel(panel ? null : "open")}
          aria-pressed={panel !== null}
        >
          <IconChat size={14} />
          {t("mcProject.canvasComments", { count: openThreads.length })}
        </button>
      </div>

      {panel ? (
        <CommentsPanel
          threads={threads}
          filter={panel}
          numberOf={numberOf}
          onFilter={setPanel}
          onClose={() => setPanel(null)}
          onOpen={(candidate) => {
            const at = pinPosition(candidate, canvas, pinBoxes);
            if (at) userView({ ...view, panX: size.w / 2 - at.x * zoom, panY: size.h / 2 - at.y * zoom });
            setOpenThread(candidate.id);
          }}
        />
      ) : null}

      {elements.length === 0 ? <p className="mc-canvas-hint">{t("mcProject.canvasEmptyHint")}</p> : null}
      {notice ? (
        <div className="mc-canvas-notice" role="status">
          <span>{notice}</span>
          <button type="button" aria-label={t("mcProject.canvasClose")} onClick={() => setNotice(null)}>
            <IconX size={12} />
          </button>
        </div>
      ) : null}
      <ContextMenu state={menu} onClose={closeContextMenu} />
    </div>
  );
}

function CommentComposer({
  at,
  bounds,
  label,
  onCancel,
  onSubmit,
}: {
  at: Point;
  bounds: { w: number; h: number };
  label?: string | null;
  onCancel: () => void;
  /** `sendToAgent` hands the thread to the conversation; `queue` waits for the next message. */
  onSubmit: (text: string, sendToAgent: boolean, queue: boolean) => void;
}) {
  const { t } = useTranslation();
  const [text, setText] = useState("");
  // "@Agent" in the text is a way of saying "send it"; it is not kept.
  const body = text.replace(/(^|\s)@agent\b/gi, " ").trim();
  const submit = (sendToAgent: boolean, queue = false) => {
    if (body) onSubmit(body, sendToAgent, queue);
  };
  return (
    <div className="mc-canvas-popover" style={popoverPlace(at, bounds)} onPointerDown={(event) => event.stopPropagation()}>
      {label ? <div className="mc-canvas-popover-label">{t("mcProject.canvasCommentOn", { label })}</div> : null}
      <textarea
        autoFocus
        rows={3}
        value={text}
        placeholder={t("mcProject.canvasCommentPlaceholder")}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            submit(true);
          }
          if (event.key === "Escape") onCancel();
        }}
      />
      <div className="mc-canvas-popover-actions">
        <button type="button" onClick={onCancel}>
          {t("mcProject.canvasCancel")}
        </button>
        <span className="mc-canvas-tab-spacer" />
        <button type="button" disabled={!body} onClick={() => submit(false)}>
          {t("mcProject.canvasCommentSubmit")}
        </button>
        <button type="button" disabled={!body} onClick={() => submit(true, true)}>
          {t("mcProject.canvasQueueToAgent")}
        </button>
        <button type="button" className="is-primary" disabled={!body} title="⌘↩" onClick={() => submit(true)}>
          {t("mcProject.canvasSendToAgent")}
        </button>
      </div>
    </div>
  );
}

function ThreadPopover({
  at,
  bounds,
  thread,
  number,
  onClose,
  onReply,
  onStatus,
  onDelete,
  onSend,
  onError,
}: {
  at: Point;
  bounds: { w: number; h: number };
  thread: CanvasThread;
  number?: number;
  onClose: () => void;
  onReply: (text: string) => Promise<void>;
  onStatus: (status: "open" | "resolved") => Promise<void>;
  onDelete: () => Promise<void>;
  onSend: (queue: boolean) => void;
  onError: (failure: unknown) => void;
}) {
  const { t } = useTranslation();
  const [text, setText] = useState("");
  const reply = () => {
    const body = text.trim();
    if (!body) return;
    void onReply(body)
      .then(() => setText(""))
      .catch(onError);
  };
  return (
    <div className="mc-canvas-popover is-thread" style={popoverPlace(at, bounds, 16, -8)} onPointerDown={(event) => event.stopPropagation()}>
      <div className="mc-canvas-popover-head">
        <span className="mc-canvas-pin-badge">{number ?? "✓"}</span>
        <span className="mc-canvas-popover-label">
          {thread.anchor.label ? t("mcProject.canvasCommentOn", { label: thread.anchor.label }) : t(`mcProject.canvasAnchor_${thread.anchor.kind}`)}
        </span>
        <button type="button" className="mc-canvas-icon" aria-label={t("mcProject.canvasClose")} onClick={onClose}>
          <IconX size={12} />
        </button>
      </div>
      {thread.located.state === "moved" || thread.located.state === "boardMissing" ? (
        <p className="mc-canvas-moved">{t(`mcProject.canvasLocated_${thread.located.state}`)}</p>
      ) : null}
      <div className="mc-canvas-messages">
        {thread.messages.map((message) => (
          <div key={message.id} className={cx("mc-canvas-message", `is-${message.author}`)}>
            <span className="mc-canvas-message-author">
              {message.author === "agent" ? t("mcProject.canvasAuthorAgent") : t("mcProject.canvasAuthorUser")}
            </span>
            <span className="selectable">{message.text}</span>
          </div>
        ))}
      </div>
      <textarea
        rows={2}
        value={text}
        placeholder={t("mcProject.canvasReplyPlaceholder")}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            reply();
          }
        }}
      />
      <div className="mc-canvas-popover-actions">
        <button type="button" className="is-danger" onClick={() => void onDelete().catch(onError)}>
          {t("mcProject.canvasDelete")}
        </button>
        <button type="button" onClick={() => void onStatus(thread.status === "open" ? "resolved" : "open").catch(onError)}>
          {thread.status === "open" ? t("mcProject.canvasResolve") : t("mcProject.canvasReopen")}
        </button>
        <button type="button" className="is-primary" disabled={!text.trim()} onClick={reply}>
          {t("mcProject.canvasReply")}
        </button>
      </div>
      <div className="mc-canvas-popover-agent">
        {thread.agentSession ? <span className="mc-canvas-muted">{t("mcProject.canvasSentToAgent")}</span> : null}
        <span className="mc-canvas-tab-spacer" />
        <button type="button" onClick={() => onSend(true)}>
          {t("mcProject.canvasQueueToAgent")}
        </button>
        <button type="button" onClick={() => onSend(false)}>
          {thread.agentSession ? t("mcProject.canvasSendAgain") : t("mcProject.canvasSendToAgent")}
        </button>
      </div>
    </div>
  );
}

function CommentsPanel({
  threads,
  filter,
  numberOf,
  onFilter,
  onClose,
  onOpen,
}: {
  threads: CanvasThread[];
  filter: "open" | "resolved";
  numberOf: Map<string, number>;
  onFilter: (filter: "open" | "resolved") => void;
  onClose: () => void;
  onOpen: (thread: CanvasThread) => void;
}) {
  const { t } = useTranslation();
  const shown = threads.filter((thread) => thread.status === filter);
  return (
    <aside className="mc-canvas-panel" onPointerDown={(event) => event.stopPropagation()}>
      <div className="mc-canvas-panel-head">
        {(["open", "resolved"] as const).map((value) => (
          <button key={value} type="button" className={cx(filter === value && "active")} onClick={() => onFilter(value)}>
            {t(`mcProject.canvasFilter_${value}`, { count: threads.filter((thread) => thread.status === value).length })}
          </button>
        ))}
        <button type="button" className="mc-canvas-icon" aria-label={t("mcProject.canvasClose")} onClick={onClose}>
          <IconX size={12} />
        </button>
      </div>
      {shown.length ? (
        shown.map((thread) => (
          <button key={thread.id} type="button" className="mc-canvas-panel-item" onClick={() => onOpen(thread)}>
            <span className="mc-canvas-pin-badge">{numberOf.get(thread.id) ?? "✓"}</span>
            <span className="mc-canvas-panel-text">
              <span>{thread.messages[0]?.text}</span>
              <span className="mc-canvas-muted">
                {thread.anchor.label ?? t(`mcProject.canvasAnchor_${thread.anchor.kind}`)}
                {thread.located.state === "moved" ? ` · ${t("mcProject.canvasMovedShort")}` : ""}
                {thread.agentSession ? ` · ${t("mcProject.canvasSentShort")}` : ""}
                {thread.messages.length > 1 ? ` · ${t("mcProject.canvasReplies", { count: thread.messages.length - 1 })}` : ""}
              </span>
            </span>
          </button>
        ))
      ) : (
        <p className="mc-canvas-muted mc-canvas-panel-empty">{t("mcProject.canvasNoComments")}</p>
      )}
    </aside>
  );
}
