import type { MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent } from "react";
import { useTranslation } from "react-i18next";
import type { CanvasElement, CanvasNode } from "@pi-desktop/shared";
import { cx } from "../../components/ui";
import { IconCircleAlert, IconUndo2 } from "../../components/icons";
import { CanvasFrame, type CanvasFrameHandle } from "./CanvasFrame";
import type { Box } from "./canvas-model";
import type { Hover } from "./use-board-picking";

/**
 * One artboard on the stage: its name strip, the sandboxed page (or a
 * placeholder when it is off screen or too small), and what is outlined or
 * reported on it. `ink` is one screen pixel in canvas units.
 */
export function CanvasBoard({
  element,
  groupId,
  canvasId,
  ink,
  selected,
  entered,
  mounted,
  errors,
  hover,
  target,
  nodes,
  frameRef,
  onPointerDown,
  onStripDown,
  onContextMenu,
  onPointerLeave,
  onDoubleClick,
  onRestore,
  onReady,
  onError,
  onEscape,
  onFix,
}: {
  element: CanvasElement;
  groupId: string;
  canvasId: string;
  ink: number;
  selected: boolean;
  entered: boolean;
  mounted: boolean;
  /** Errors the page reported, first one shown. */
  errors: string[];
  /** The element under the pointer in this artboard. */
  hover: Hover | null;
  /** The element a comment is being written about. */
  target: Box | null;
  /** Elements picked in this artboard. */
  nodes: Array<CanvasNode & { rect: Box }>;
  frameRef: (handle: CanvasFrameHandle | null) => void;
  onPointerDown: (event: ReactPointerEvent<HTMLDivElement>) => void;
  /** Pointer down on the name strip, which moves the artboard. */
  onStripDown: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onContextMenu: (event: ReactMouseEvent<HTMLDivElement>) => void;
  onPointerLeave: () => void;
  onDoubleClick: () => void;
  onRestore: () => void;
  onReady: () => void;
  onError: (message: string) => void;
  onEscape: () => void;
  onFix: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div
      data-element={element.id}
      onContextMenu={onContextMenu}
      onPointerDown={onPointerDown}
      onPointerLeave={onPointerLeave}
      data-board={element.id}
      className={cx("mc-canvas-board", selected && "is-selected", entered && "is-entered")}
      style={{ left: element.x, top: element.y, width: element.w, height: element.h, outlineWidth: selected ? 2 * ink : ink }}
      onDoubleClick={onDoubleClick}
    >
      <div
        className="mc-canvas-strip"
        style={{ fontSize: 12 * ink, top: -22 * ink, height: 20 * ink }}
        onPointerDown={onStripDown}
      >
        <span>{element.title || element.id}</span>
        {entered ? (
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
            onClick={onRestore}
          >
            <IconUndo2 size={11 * ink} />
            {t("mcProject.canvasRestorePrevious")}
          </button>
        ) : null}
      </div>
      {mounted ? (
        <CanvasFrame
          ref={frameRef}
          groupId={groupId}
          canvasId={canvasId}
          boardId={element.id}
          rev={element.rev}
          title={element.title || element.id}
          width={element.w}
          height={element.h}
          interactive={entered}
          onReady={onReady}
          onError={onError}
          onEscape={onEscape}
        />
      ) : (
        <div className="mc-canvas-placeholder" style={{ fontSize: 14 * ink }}>
          {element.title || element.id}
        </div>
      )}
      {entered ? null : <div className="mc-canvas-board-cover" />}
      {hover ? (
        <div
          className="mc-canvas-hover"
          style={{ left: hover.rect.x, top: hover.rect.y, width: hover.rect.w, height: hover.rect.h, outlineWidth: ink }}
        >
          {hover.label ? (
            <span style={{ fontSize: 11 * ink, top: -18 * ink, padding: `${1 * ink}px ${5 * ink}px` }}>{hover.label}</span>
          ) : null}
        </div>
      ) : null}
      {target ? (
        <div
          className="mc-canvas-node"
          style={{ left: target.x, top: target.y, width: target.w, height: target.h, outlineWidth: 2 * ink }}
        />
      ) : null}
      {nodes.map((node) => (
        <div
          key={node.address}
          className="mc-canvas-node"
          style={{ left: node.rect.x, top: node.rect.y, width: node.rect.w, height: node.rect.h, outlineWidth: 2 * ink }}
        />
      ))}
      {errors.length ? (
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
          <span className="mc-canvas-board-error-text">{t("mcProject.canvasBoardError", { message: errors[0] })}</span>
          <button
            type="button"
            onPointerDown={(event) => event.stopPropagation()}
            onClick={onFix}
          >
            {t("mcProject.canvasFixWithAgent")}
          </button>
        </div>
      ) : null}
    </div>
  );
}
