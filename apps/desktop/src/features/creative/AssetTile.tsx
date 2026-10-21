import type { DragEvent, MouseEvent } from "react";
import { useTranslation } from "react-i18next";
import { cx } from "../../components/ui";
import { IconCheck, IconCircleAlert } from "../../components/icons";
import type { CreativeAsset } from "./creative-types";
import { useAssetImage } from "./use-creative";

/*
  One image in the grid, handled the way photo libraries do: a click selects
  (⌘ toggles, ⇧ extends), a double-click opens the preview, a right-click
  opens the menu, and dragging carries the selection onto a category. The
  check circle appears on hover; nothing destructive sits on the tile itself.
*/
export function AssetTile({
  asset,
  caption,
  selectedIndex,
  focused,
  onSelect,
  onToggle,
  onOpen,
  onContextMenu,
  onDragStart,
  onDragEnd,
}: {
  asset: CreativeAsset;
  /** Shown along the bottom on hover: the prompt (or name) and where it came from. */
  caption?: { title: string; meta: string };
  /** Position in the selection (1-based), or 0 when not selected. */
  selectedIndex: number;
  /** The keyboard's current tile. */
  focused: boolean;
  onSelect: (event: MouseEvent) => void;
  /** The check circle: add or remove this one, whatever else is selected. */
  onToggle: () => void;
  onOpen: () => void;
  onContextMenu: (event: MouseEvent<HTMLElement>) => void;
  /** Dragging a tile onto a category moves it there. */
  onDragStart?: (event: DragEvent) => void;
  onDragEnd?: () => void;
}) {
  const { t } = useTranslation();
  const url = useAssetImage(asset.groupId, asset.fileExists ? asset.id : null, 480);
  return (
    <div
      role="option"
      aria-selected={selectedIndex > 0}
      data-asset-id={asset.id}
      className={cx("mc-creative-tile", selectedIndex > 0 && "is-selected", focused && "is-focused")}
      title={caption?.title || asset.title || undefined}
      draggable={!!onDragStart}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onClick={onSelect}
      onDoubleClick={onOpen}
      onContextMenu={onContextMenu}
    >
      <div className="mc-creative-tile-image">
        {url ? (
          <img src={url} alt={asset.title || t("mcProject.creativeAsset")} loading="lazy" draggable={false} />
        ) : (
          <span className="mc-creative-tile-missing">
            {asset.fileExists ? null : <IconCircleAlert size={16} />}
            {asset.fileExists ? "" : t("mcProject.creativeFileMissing")}
          </span>
        )}
      </div>
      {caption ? (
        <div className="mc-creative-tile-caption" aria-hidden>
          {caption.title ? <span className="mc-creative-tile-caption-title">{caption.title}</span> : null}
          {caption.meta ? <span className="mc-creative-tile-caption-meta">{caption.meta}</span> : null}
        </div>
      ) : null}
      <button
        type="button"
        className="mc-creative-tile-check"
        aria-pressed={selectedIndex > 0}
        aria-label={t("mcProject.creativeSelect")}
        onClick={(event) => {
          event.stopPropagation();
          onToggle();
        }}
        onDoubleClick={(event) => event.stopPropagation()}
      >
        {selectedIndex > 0 ? <span>{selectedIndex}</span> : <IconCheck size={12} />}
      </button>
    </div>
  );
}
