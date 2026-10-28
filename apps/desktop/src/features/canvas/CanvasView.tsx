import {
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { useTranslation } from "react-i18next";
import { cx } from "../../components/ui";
import { IconX } from "../../components/icons";
import { ContextMenu, useContextMenu } from "../../components/ContextMenu";
import { api } from "../../lib/api";
import type { CanvasAnchorInput, CanvasElement, CanvasNode, CanvasOp, CanvasThread } from "@pi-desktop/shared";
import type { CanvasFrameHandle } from "./CanvasFrame";
import { CanvasBoard } from "./CanvasBoard";
import { CommentComposer, CommentsPanel, ThreadPopover } from "./CanvasComments";
import { CanvasToolbar, type Tool } from "./CanvasToolbar";
import { useCanvas } from "./use-canvas";
import { useBoardPicking, type Hover } from "./use-board-picking";
import { useCanvasKeys } from "./use-canvas-keys";
import { useCanvasViewport } from "./use-canvas-viewport";
import {
  EMPTY_HISTORY,
  PLACEHOLDER_ZOOM,
  elementBox,
  errorsAttachment,
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
  const { size, view, setView, userView, fitAll, autoView } = useCanvasViewport(stage, canvas, canvasId, entered);

  const fail = useCallback((failure: unknown) => setNotice(failure instanceof Error ? failure.message : String(failure)), []);
  const conflict = useCallback(() => setNotice(t("mcProject.canvasConflict")), [t]);

  // ---- viewport ----------------------------------------------------------------

  useEffect(() => {
    setSelected([]);
    setNodes([]);
    setEntered(null);
    setErrors({});
    setHistory(EMPTY_HISTORY);
    setComposer(null);
    setOpenThread(null);
  }, [canvasId]);

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

  const { pickAt, trackHover } = useBoardPicking({ groupId, canvasId, stage, frames, view, byId, setHover });

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

  useCanvasKeys({
    stage,
    pointerInside,
    composer,
    openThread,
    entered,
    selected,
    setComposer,
    setOpenThread,
    setEntered,
    setSpaceHeld,
    setSelected,
    setNodes,
    setTool,
    undo,
    removeElements,
  });

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
      const errorKey = `${element.id}:${element.rev}`;
      return (
        <CanvasBoard
          key={element.id}
          element={element}
          groupId={groupId}
          canvasId={canvasId}
          ink={ink}
          selected={isSelected}
          entered={entered === element.id}
          mounted={zoom >= PLACEHOLDER_ZOOM && mountArea !== null && intersects(elementBox(element), mountArea)}
          errors={errors[errorKey] ?? []}
          hover={hover?.boardId === element.id && !drag ? hover : null}
          target={composer?.target?.boardId === element.id ? composer.target.rect : null}
          nodes={nodes.filter((node) => node.boardId === element.id)}
          frameRef={(handle) => {
            if (handle) frames.current.set(element.id, handle);
            else frames.current.delete(element.id);
          }}
          onPointerDown={(event) => onBoardDown(event, element)}
          onStripDown={common.onPointerDown}
          onContextMenu={common.onContextMenu}
          onPointerLeave={() => setHover((current) => (current?.boardId === element.id ? null : current))}
          onDoubleClick={() => {
            if (tool === "select") setEntered(element.id);
          }}
          onRestore={() => void change([{ op: "restore", id: element.id }])}
          onReady={() => setReady((current) => ({ ...current, [element.id]: (current[element.id] ?? 0) + 1 }))}
          onError={(message) =>
            setErrors((current) => {
              const list = current[errorKey] ?? [];
              return list.length >= 10 ? current : { ...current, [errorKey]: [...list, message] };
            })
          }
          onEscape={() => setEntered(null)}
          onFix={() => onAttach(errorsAttachment(canvasId, element.id, errors[errorKey] ?? []))}
        />
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

      <CanvasToolbar
        head={head}
        tool={tool}
        zoom={zoom}
        panelOpen={panel !== null}
        openCount={openThreads.length}
        onTool={setTool}
        onZoomOut={() => userView(zoomAt(view, 1 / 1.25, { x: size.w / 2, y: size.h / 2 }))}
        onZoomIn={() => userView(zoomAt(view, 1.25, { x: size.w / 2, y: size.h / 2 }))}
        onFit={() => {
          autoView.current = true;
          fitAll();
        }}
        onTogglePanel={() => setPanel(panel ? null : "open")}
      />

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
