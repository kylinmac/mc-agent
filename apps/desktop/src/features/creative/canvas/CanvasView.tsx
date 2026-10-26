import {
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
import { cx } from "../../../components/ui";
import {
  IconChat,
  IconCircleAlert,
  IconMinus,
  IconPencil,
  IconPlus,
  IconTarget,
  IconUndo2,
  IconX,
} from "../../../components/icons";
import { ContextMenu, useContextMenu } from "../../../components/ContextMenu";
import { api } from "../../../lib/api";
import { CANVAS_NOTE_COLORS } from "@pi-desktop/shared";
import type {
  Canvas,
  CanvasAnchorInput,
  CanvasElement,
  CanvasNode,
  CanvasNoteColor,
  CanvasOp,
  CanvasThread,
} from "@pi-desktop/shared";
import { useAssetImage } from "../use-creative";
import { CanvasFrame, type CanvasFrameHandle } from "./CanvasFrame";
import { useCanvas } from "./use-canvas";
import {
  EMPTY_HISTORY,
  PLACEHOLDER_ZOOM,
  boundsOf,
  elementBox,
  errorsAttachment,
  fitView,
  frameAt,
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
  mc-agent creative canvas, tier A (docs/mc-agent/creative-canvas.md):
  artboards (sandboxed HTML), library images, notes and titles laid out on a
  pan-and-zoom stage; elements inside artboards can be picked; comment threads
  sit on elements, artboard points or the canvas, and can be sent to the
  studio's conversation. The view state (what is visible and selected) goes up
  so the chat can carry it.
*/

type Tool = "select" | "hand" | "note" | "comment";

type Drag =
  | { kind: "pan"; start: Point; origin: CanvasViewport }
  | { kind: "move"; start: Point; origin: Map<string, Point>; moved: boolean; boardClick?: { boardId: string; client: Point } }
  | { kind: "resize"; id: string; start: Point; origin: Box }
  | { kind: "marquee"; start: Point; current: Point; additive: boolean };

type Composer = { anchor: CanvasAnchorInput; at: Point; label?: string | null };

const VIEW_KEY = "mc.creative.canvasView.";

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

function editableTarget(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName));
}

export function CanvasView({
  groupId,
  canvasId,
  assetExists,
  onViewState,
  onAttach,
  onSendThread,
}: {
  groupId: string;
  canvasId: string;
  /** Whether a library asset is still there; undefined while unknown. */
  assetExists: (assetId: string) => boolean | undefined;
  onViewState: (state: CanvasViewState | null) => void;
  onAttach: (attachment: CanvasAttachment) => void;
  /** Hand a thread to the studio conversation, now or with the next message. */
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
  const [editing, setEditing] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string[]>>({});
  const [history, setHistory] = useState<CanvasHistory>(EMPTY_HISTORY);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [composer, setComposer] = useState<Composer | null>(null);
  const [openThread, setOpenThread] = useState<string | null>(null);
  const [panel, setPanel] = useState<"open" | "resolved" | null>(null);
  const [pinBoxes, setPinBoxes] = useState<Map<string, Record<number, Box>>>(new Map());
  const [ready, setReady] = useState<Record<string, number>>({});
  const [notice, setNotice] = useState<string | null>(null);
  const frames = useRef(new Map<string, CanvasFrameHandle>());
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
      setView(fitView(boundsOf(target.elements.map((element) => elementBox(element))), size.w, size.h));
    },
    [canvas, size.w, size.h],
  );

  // First view of a canvas: where it was left, else everything.
  const placed = useRef<string | null>(null);
  useEffect(() => {
    if (!canvas || !size.w || placed.current === canvasId) return;
    placed.current = canvasId;
    const stored = readView(canvasId);
    if (stored) setView(stored);
    else fitAll(canvas);
  }, [canvas, canvasId, size.w, fitAll]);

  useEffect(() => {
    setSelected([]);
    setNodes([]);
    setEntered(null);
    setEditing(null);
    setErrors({});
    setHistory(EMPTY_HISTORY);
    setComposer(null);
    setOpenThread(null);
    setView(null);
    placed.current = null;
  }, [canvasId]);

  useEffect(() => {
    if (!view) return;
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

  const removeSelected = useCallback(async () => {
    const targets = selected.map((id) => byId.get(id)).filter((element): element is CanvasElement => !!element);
    if (!targets.length) return;
    const frameCount = targets.filter((element) => element.type === "frame").length;
    if (frameCount && !window.confirm(t("mcProject.canvasDeleteBoardsConfirm", { count: frameCount }))) return;
    await change(targets.map((element) => ({ op: "remove", id: element.id })));
    setSelected([]);
    setNodes([]);
  }, [byId, change, selected, t]);

  const addNote = useCallback(
    async (at: Point) => {
      const board = canvas ? frameAt(canvas, at) : null;
      const id = `n${Date.now().toString(36)}`;
      const result = await change([
        {
          op: "add",
          element: {
            id,
            type: "note",
            x: Math.round(at.x),
            y: Math.round(at.y),
            w: 240,
            h: 0,
            text: "",
            ...(board ? { boardId: board.id } : {}),
          },
        },
      ]);
      if (result) {
        setSelected([id]);
        setEditing(id);
      }
      setTool("select");
    },
    [canvas, change],
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
        const { node } = await api.creative.call("creative.canvas.resolveNode", {
          groupId,
          canvasId,
          boardId,
          node: hit.node,
        });
        return { local, node: { ...node, rect: hit.rect } };
      } catch {
        return { local, node: null };
      }
    },
    [canvasId, groupId, view],
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
      setComposer(
        picked?.node
          ? { anchor: { kind: "element", boardId, node: picked.node.tid, ...point }, at, label: picked.node.label }
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
      const { threadId, comments: next } = await api.creative.call("creative.canvasComments.add", {
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

  // ---- view state for the chat --------------------------------------------------

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
      dirty: drag !== null || editing !== null,
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
      if (event.key === " " && !editableTarget(event.target)) {
        if (event.type === "keydown") {
          if (!event.repeat) setSpaceHeld(true);
          event.preventDefault();
        } else setSpaceHeld(false);
        return;
      }
      if (event.type !== "keydown" || editableTarget(event.target)) return;
      if (!stage.current?.isConnected) return;
      const mod = event.metaKey || event.ctrlKey;
      if (event.key === "Escape") {
        if (composer) setComposer(null);
        else if (openThread) setOpenThread(null);
        else if (entered) setEntered(null);
        else {
          setSelected([]);
          setNodes([]);
        }
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
        void removeSelected();
        return;
      }
      const tools: Record<string, Tool> = { v: "select", h: "hand", n: "note", c: "comment" };
      const next = tools[event.key.toLowerCase()];
      if (next) setTool(next);
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("keyup", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("keyup", onKey);
    };
  }, [composer, entered, openThread, removeSelected, selected.length, undo]);

  // ---- pointer --------------------------------------------------------------------

  const panning = tool === "hand" || spaceHeld;

  const beginPan = (event: ReactPointerEvent) => {
    if (!view) return;
    (event.currentTarget as HTMLElement).setPointerCapture?.(event.pointerId);
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
    setEditing(null);
    if (tool === "note") {
      void addNote(canvasPoint(event.clientX, event.clientY));
      return;
    }
    if (tool === "comment") {
      void startComment(event.clientX, event.clientY, null);
      return;
    }
    setEntered(null);
    const point = canvasPoint(event.clientX, event.clientY);
    if (!event.shiftKey) {
      setSelected([]);
      setNodes([]);
    }
    (event.currentTarget as HTMLElement).setPointerCapture?.(event.pointerId);
    setDrag({ kind: "marquee", start: point, current: point, additive: event.shiftKey });
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
    if (tool === "note") {
      void addNote(canvasPoint(event.clientX, event.clientY));
      return;
    }
    if (editing === element.id) return;
    setEditing(null);
    const alreadyAlone = selected.length === 1 && selected[0] === element.id;
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
      // A click (no drag) on an artboard that is already selected picks the
      // element under the pointer.
      boardClick:
        alreadyAlone && element.type === "frame" && !event.shiftKey
          ? { boardId: element.id, client: { x: event.clientX, y: event.clientY } }
          : undefined,
    });
  };

  const onResizeDown = (event: ReactPointerEvent<HTMLElement>, element: CanvasElement) => {
    if (event.button !== 0) return;
    event.stopPropagation();
    (event.currentTarget as HTMLElement).setPointerCapture?.(event.pointerId);
    setDrag({ kind: "resize", id: element.id, start: canvasPoint(event.clientX, event.clientY), origin: elementBox(element) });
  };

  const onPointerMove = (event: ReactPointerEvent) => {
    if (!drag || !view) return;
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
    if (drag.kind === "move") {
      if (!drag.moved && Math.hypot(dx, dy) * view.zoom < 3) return;
      if (!drag.moved) setDrag({ ...drag, moved: true });
      preview((current) => ({
        ...current,
        elements: current.elements.map((element) => {
          const origin = drag.origin.get(element.id);
          return origin ? { ...element, x: Math.round(origin.x + dx), y: Math.round(origin.y + dy) } : element;
        }),
      }));
      return;
    }
    preview((current) => ({
      ...current,
      elements: current.elements.map((element) =>
        element.id === drag.id
          ? {
              ...element,
              w: Math.max(40, Math.round(drag.origin.w + dx)),
              h: element.h === 0 && element.type !== "frame" && element.type !== "image" ? 0 : Math.max(40, Math.round(drag.origin.h + dy)),
            }
          : element,
      ),
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
    if (drag.kind === "move") {
      if (!drag.moved) {
        if (drag.boardClick) {
          const { boardId, client } = drag.boardClick;
          void pickAt(boardId, client.x, client.y).then((picked) => {
            if (!picked?.node) {
              setNodes([]);
              return;
            }
            const node = picked.node;
            setNodes((current) =>
              event.shiftKey ? [...current.filter((entry) => entry.address !== node.address), node] : [node],
            );
          });
        }
        return;
      }
      const moved = [...drag.origin.keys()]
        .map((id) => byId.get(id))
        .filter((element): element is CanvasElement => !!element);
      void change(moved.map((element) => ({ op: "update", id: element.id, set: { x: element.x, y: element.y } })));
      return;
    }
    const element = byId.get(drag.id);
    if (element) void change([{ op: "update", id: element.id, set: { w: element.w, ...(element.h ? { h: element.h } : {}) } }]);
  };

  // ---- rendering --------------------------------------------------------------------

  // The stage stays the same element while the canvas loads: its size is
  // observed once.
  if (!canvas || !view) {
    return (
      <div className="mc-canvas">
        <div className="mc-canvas-stage" ref={stage}>
          {error ? <p className="mc-creative-error mc-canvas-hint">{error}</p> : null}
        </div>
      </div>
    );
  }

  const zoom = view.zoom;
  const ink = 1 / zoom;
  const worldStyle = { transform: `translate(${view.panX}px, ${view.panY}px) scale(${zoom})` };
  const marquee = drag?.kind === "marquee" ? rectFrom(drag.start, drag.current) : null;
  const single = selected.length === 1 ? byId.get(selected[0]) : undefined;

  const boardMenu = (event: ReactMouseEvent<HTMLElement>, element: CanvasElement) =>
    openContextMenu(event, {
      label: element.title || element.id,
      items: [
        ...(element.type === "frame" && element.hasPrev
          ? [{ id: "restore", label: t("mcProject.canvasRestorePrevious"), onSelect: () => void change([{ op: "restore", id: element.id }]) }]
          : []),
        ...(element.type === "note"
          ? [
              { id: "attach", label: t("mcProject.canvasAttachNote"), onSelect: () => onAttach(noteAttachment(canvasId, element)) },
              { id: "edit", label: t("mcProject.canvasEditNote"), onSelect: () => setEditing(element.id) },
            ]
          : []),
        { id: "front", label: t("mcProject.canvasBringFront"), onSelect: () => void change([{ op: "reorder", id: element.id, to: "front" }]) },
        { id: "back", label: t("mcProject.canvasSendBack"), onSelect: () => void change([{ op: "reorder", id: element.id, to: "back" }]) },
        {
          id: "delete",
          label: t("mcProject.canvasDelete"),
          danger: true,
          separatorBefore: true,
          onSelect: () => {
            setSelected([element.id]);
            if (element.type === "frame" && !window.confirm(t("mcProject.canvasDeleteBoardsConfirm", { count: 1 }))) return;
            void change([{ op: "remove", id: element.id }]);
          },
        },
      ],
    });

  const renderElement = (element: CanvasElement) => {
    const isSelected = selected.includes(element.id);
    const common = {
      "data-element": element.id,
      onPointerDown: (event: ReactPointerEvent<HTMLDivElement>) => onElementDown(event, element),
      onContextMenu: (event: ReactMouseEvent<HTMLDivElement>) => boardMenu(event, element),
    };
    if (element.type === "frame") {
      const errorKey = `${element.id}:${element.rev}`;
      const boardErrors = errors[errorKey] ?? [];
      const mounted = zoom >= PLACEHOLDER_ZOOM && mountArea !== null && intersects(elementBox(element), mountArea);
      const isEntered = entered === element.id;
      return (
        <div
          key={element.id}
          {...common}
          data-board={element.id}
          className={cx("mc-canvas-board", isSelected && "is-selected", isEntered && "is-entered")}
          style={{ left: element.x, top: element.y, width: element.w, height: element.h, outlineWidth: isSelected ? 2 * ink : ink }}
          onDoubleClick={() => {
            if (tool === "select") setEntered(element.id);
          }}
        >
          <div className="mc-canvas-strip" style={{ fontSize: 12 * ink, top: -22 * ink, height: 20 * ink }}>
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
    if (element.type === "image") {
      return (
        <div
          key={element.id}
          {...common}
          className={cx("mc-canvas-image", isSelected && "is-selected")}
          style={{ left: element.x, top: element.y, width: element.w, height: element.h, outlineWidth: isSelected ? 2 * ink : 0 }}
        >
          <CanvasImage groupId={groupId} assetId={element.assetId} missing={element.assetId ? assetExists(element.assetId) === false : true} />
        </div>
      );
    }
    const isEditing = editing === element.id;
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
        onDoubleClick={() => setEditing(element.id)}
      >
        {isEditing ? (
          <NoteEditor
            initial={element.text ?? ""}
            onDone={(text) => {
              setEditing(null);
              if (text !== (element.text ?? "")) void change([{ op: "update", id: element.id, set: { text } }]);
            }}
          />
        ) : (
          <div className="mc-canvas-note-text">{element.text || (element.type === "note" ? t("mcProject.canvasEmptyNote") : "")}</div>
        )}
      </div>
    );
  };

  const thread = openThread ? threads.find((candidate) => candidate.id === openThread) : undefined;
  const threadAt = thread ? pinPosition(thread, canvas, pinBoxes) : null;

  return (
    <div className={cx("mc-canvas", `tool-${panning ? "hand" : tool}`, drag?.kind === "pan" && "is-panning")}>
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
          {single && (single.type === "frame" || single.type === "image" || single.type === "note") && !editing ? (
            <div
              className="mc-canvas-resize"
              style={{
                left: single.x + single.w - 6 * ink,
                top: single.y + elementBox(single).h - 6 * ink,
                width: 12 * ink,
                height: 12 * ink,
              }}
              onPointerDown={(event) => onResizeDown(event, single)}
            />
          ) : null}
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
            label={composer.label}
            onCancel={() => setComposer(null)}
            onSubmit={(text, sendToAgent, queue) => void submitComment(text, sendToAgent, queue)}
          />
        ) : null}
        {thread && threadAt ? (
          <ThreadPopover
            key={thread.id}
            at={toScreen(threadAt, view)}
            thread={thread}
            number={numberOf.get(thread.id)}
            onClose={() => setOpenThread(null)}
            onReply={async (text) => {
              const { comments: next } = await api.creative.call("creative.canvasComments.reply", {
                groupId,
                canvasId,
                threadId: thread.id,
                text,
              });
              setThreads(next);
            }}
            onStatus={async (status) => {
              const { comments: next } = await api.creative.call("creative.canvasComments.setStatus", {
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
              const { comments: next } = await api.creative.call("creative.canvasComments.delete", {
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
        {(
          [
            ["select", t("mcProject.canvasToolSelect"), "V", <IconTarget size={14} key="i" />],
            ["hand", t("mcProject.canvasToolHand"), "H", <span className="mc-canvas-hand" aria-hidden key="i">✋</span>],
            ["note", t("mcProject.canvasToolNote"), "N", <IconPencil size={14} key="i" />],
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
        <button type="button" className="mc-canvas-tool" title={t("mcProject.canvasZoomOut")} aria-label={t("mcProject.canvasZoomOut")} onClick={() => setView(zoomAt(view, 1 / 1.25, { x: size.w / 2, y: size.h / 2 }))}>
          <IconMinus size={14} />
        </button>
        <button type="button" className="mc-canvas-zoom" title={t("mcProject.canvasZoomFit")} onClick={() => fitAll()}>
          {Math.round(zoom * 100)}%
        </button>
        <button type="button" className="mc-canvas-tool" title={t("mcProject.canvasZoomIn")} aria-label={t("mcProject.canvasZoomIn")} onClick={() => setView(zoomAt(view, 1.25, { x: size.w / 2, y: size.h / 2 }))}>
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
            if (at) setView({ ...view, panX: size.w / 2 - at.x * zoom, panY: size.h / 2 - at.y * zoom });
            setOpenThread(candidate.id);
          }}
        />
      ) : null}

      {single?.type === "note" && !editing ? (
        <div className="mc-canvas-selection-bar" onPointerDown={(event) => event.stopPropagation()}>
          {CANVAS_NOTE_COLORS.map((color) => (
            <button
              key={color}
              type="button"
              className={cx("mc-canvas-swatch", `is-${color}`, (single.color ?? "yellow") === color && "active")}
              aria-label={t(`mcProject.canvasColor_${color}`)}
              title={t(`mcProject.canvasColor_${color}`)}
              onClick={() => void change([{ op: "update", id: single.id, set: { color: color as CanvasNoteColor } }])}
            />
          ))}
          <button type="button" className="mc-canvas-bar-button" onClick={() => onAttach(noteAttachment(canvasId, single))}>
            {t("mcProject.canvasAttachNote")}
          </button>
        </div>
      ) : null}

      {elements.length === 0 ? <p className="mc-canvas-hint">{t("mcProject.canvasEmptyHint")}</p> : null}
      {notice ? (
        <div className="mc-canvas-notice" role="status">
          <span>{notice}</span>
          <button type="button" aria-label={t("mcProject.creativeClose")} onClick={() => setNotice(null)}>
            <IconX size={12} />
          </button>
        </div>
      ) : null}
      <ContextMenu state={menu} onClose={closeContextMenu} />
    </div>
  );
}

function CanvasImage({ groupId, assetId, missing }: { groupId: string; assetId?: string; missing: boolean }) {
  const { t } = useTranslation();
  const url = useAssetImage(groupId, missing ? null : assetId, 1024);
  if (missing) return <div className="mc-canvas-placeholder is-missing">{t("mcProject.canvasAssetMissing")}</div>;
  return url ? <img src={url} alt="" draggable={false} /> : <div className="mc-canvas-placeholder" />;
}

function NoteEditor({ initial, onDone }: { initial: string; onDone: (text: string) => void }) {
  const [text, setText] = useState(initial);
  const done = useRef(false);
  const finish = () => {
    if (done.current) return;
    done.current = true;
    onDone(text.trimEnd());
  };
  return (
    <textarea
      className="mc-canvas-note-editor"
      autoFocus
      value={text}
      onChange={(event) => setText(event.target.value)}
      onPointerDown={(event) => event.stopPropagation()}
      onBlur={finish}
      onKeyDown={(event) => {
        if (event.key === "Escape" || (event.key === "Enter" && (event.metaKey || event.ctrlKey))) {
          event.preventDefault();
          finish();
        }
      }}
    />
  );
}

function CommentComposer({
  at,
  label,
  onCancel,
  onSubmit,
}: {
  at: Point;
  label?: string | null;
  onCancel: () => void;
  onSubmit: (text: string, sendToAgent: boolean, queue: boolean) => void;
}) {
  const { t } = useTranslation();
  const [text, setText] = useState("");
  const [agent, setAgent] = useState(false);
  const [queue, setQueue] = useState(false);
  const mentions = /(^|\s)@agent\b/i.test(text);
  const toAgent = agent || mentions;
  const submit = () => {
    const body = text.replace(/(^|\s)@agent\b/gi, " ").trim();
    if (body) onSubmit(body, toAgent, toAgent && queue);
  };
  return (
    <div className="mc-canvas-popover" style={{ left: at.x + 12, top: at.y + 12 }} onPointerDown={(event) => event.stopPropagation()}>
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
            submit();
          }
          if (event.key === "Escape") onCancel();
        }}
      />
      <label className="mc-canvas-check">
        <input type="checkbox" checked={toAgent} disabled={mentions} onChange={(event) => setAgent(event.target.checked)} />
        {t("mcProject.canvasSendToAgent")}
      </label>
      {toAgent ? (
        <label className="mc-canvas-check">
          <input type="checkbox" checked={queue} onChange={(event) => setQueue(event.target.checked)} />
          {t("mcProject.canvasQueue")}
        </label>
      ) : null}
      <div className="mc-canvas-popover-actions">
        <button type="button" onClick={onCancel}>
          {t("mcProject.creativeCancel")}
        </button>
        <button type="button" className="is-primary" disabled={!text.trim()} onClick={submit}>
          {t("mcProject.canvasCommentSubmit")}
        </button>
      </div>
    </div>
  );
}

function ThreadPopover({
  at,
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
  const [queue, setQueue] = useState(false);
  const reply = () => {
    const body = text.trim();
    if (!body) return;
    void onReply(body)
      .then(() => setText(""))
      .catch(onError);
  };
  return (
    <div className="mc-canvas-popover is-thread" style={{ left: at.x + 16, top: at.y - 8 }} onPointerDown={(event) => event.stopPropagation()}>
      <div className="mc-canvas-popover-head">
        <span className="mc-canvas-pin-badge">{number ?? "✓"}</span>
        <span className="mc-canvas-popover-label">
          {thread.anchor.label ? t("mcProject.canvasCommentOn", { label: thread.anchor.label }) : t(`mcProject.canvasAnchor_${thread.anchor.kind}`)}
        </span>
        <button type="button" className="mc-canvas-icon" aria-label={t("mcProject.creativeClose")} onClick={onClose}>
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
        {thread.agentSession ? <span className="mc-creative-muted">{t("mcProject.canvasSentToAgent")}</span> : null}
        <label className="mc-canvas-check">
          <input type="checkbox" checked={queue} onChange={(event) => setQueue(event.target.checked)} />
          {t("mcProject.canvasQueue")}
        </label>
        <button type="button" onClick={() => onSend(queue)}>
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
        <button type="button" className="mc-canvas-icon" aria-label={t("mcProject.creativeClose")} onClick={onClose}>
          <IconX size={12} />
        </button>
      </div>
      {shown.length ? (
        shown.map((thread) => (
          <button key={thread.id} type="button" className="mc-canvas-panel-item" onClick={() => onOpen(thread)}>
            <span className="mc-canvas-pin-badge">{numberOf.get(thread.id) ?? "✓"}</span>
            <span className="mc-canvas-panel-text">
              <span>{thread.messages[0]?.text}</span>
              <span className="mc-creative-muted">
                {thread.anchor.label ?? t(`mcProject.canvasAnchor_${thread.anchor.kind}`)}
                {thread.located.state === "moved" ? ` · ${t("mcProject.canvasMovedShort")}` : ""}
                {thread.agentSession ? ` · ${t("mcProject.canvasSentShort")}` : ""}
                {thread.messages.length > 1 ? ` · ${t("mcProject.canvasReplies", { count: thread.messages.length - 1 })}` : ""}
              </span>
            </span>
          </button>
        ))
      ) : (
        <p className="mc-creative-muted mc-canvas-panel-empty">{t("mcProject.canvasNoComments")}</p>
      )}
    </aside>
  );
}
