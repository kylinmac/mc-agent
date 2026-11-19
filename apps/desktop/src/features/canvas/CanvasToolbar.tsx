import { useRef, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { cx } from "../../components/ui";
import { IconChat, IconMinus, IconPlus, IconTarget } from "../../components/icons";
import { useToolbarFocusGroup } from "./use-toolbar-focusgroup";

export type Tool = "select" | "hand" | "comment";

/** The canvas toolbar: the switcher, tools, zoom and the comment list toggle. */
export function CanvasToolbar({
  head,
  tool,
  zoom,
  panelOpen,
  openCount,
  onTool,
  onZoomOut,
  onZoomIn,
  onFit,
  onTogglePanel,
}: {
  head?: ReactNode;
  tool: Tool;
  zoom: number;
  panelOpen: boolean;
  /** Open comment threads. */
  openCount: number;
  onTool: (tool: Tool) => void;
  onZoomOut: () => void;
  onZoomIn: () => void;
  onFit: () => void;
  onTogglePanel: () => void;
}) {
  const { t } = useTranslation();
  const barRef = useRef<HTMLDivElement | null>(null);
  useToolbarFocusGroup(barRef);
  return (
    <div
      ref={barRef}
      className="mc-canvas-toolbar"
      role="toolbar"
      aria-label={t("mcProject.canvasSection")}
      {...({ focusgroup: "toolbar wrap" } as Record<string, string>)}
      onPointerDown={(event) => event.stopPropagation()}
    >
      <div className="mc-canvas-toolbar-group" role="group" aria-label={t("mcProject.canvasSection")}>
        {head}
      </div>
      <span className="mc-canvas-toolbar-spacer" />
      <div className="mc-canvas-toolbar-group" role="group" aria-label={t("mcProject.canvasToolSelect")}>
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
            onClick={() => onTool(id)}
          >
            {icon}
          </button>
        ))}
      </div>
      <span className="mc-canvas-toolbar-sep" role="separator" aria-orientation="vertical" />
      <div className="mc-canvas-toolbar-group" role="group" aria-label={t("mcProject.canvasZoomFit")}>
        <button type="button" className="mc-canvas-tool" title={t("mcProject.canvasZoomOut")} aria-label={t("mcProject.canvasZoomOut")} onClick={onZoomOut}>
          <IconMinus size={14} />
        </button>
        <button
          type="button"
          className="mc-canvas-zoom"
          title={t("mcProject.canvasZoomFit")}
          onClick={onFit}
        >
          {Math.round(zoom * 100)}%
        </button>
        <button type="button" className="mc-canvas-tool" title={t("mcProject.canvasZoomIn")} aria-label={t("mcProject.canvasZoomIn")} onClick={onZoomIn}>
          <IconPlus size={14} />
        </button>
      </div>
      <span className="mc-canvas-toolbar-sep" role="separator" aria-orientation="vertical" />
      <button
        type="button"
        className={cx("mc-canvas-tool mc-canvas-tool-wide", panelOpen && "active")}
        onClick={onTogglePanel}
        aria-pressed={panelOpen}
      >
        <IconChat size={14} />
        {t("mcProject.canvasComments", { count: openCount })}
      </button>
    </div>
  );
}
