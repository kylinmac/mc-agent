import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type PointerEvent as ReactPointerEvent,
  type WheelEvent,
} from "react";
import { useTranslation } from "react-i18next";
import { Button, cx } from "../../components/ui";
import { IconCheck, IconGripVertical, IconPlus, IconX } from "../../components/icons";
import type { CreativeAsset, CreativeCategory, CreativeComparison } from "./creative-types";
import {
  categoryTree,
  compareGrid,
  flattenCategories,
  MAX_COMPARE,
  placeInComparison,
  viewAssets,
  type CompareLayout,
  type StudioView,
} from "./creative-model";
import { useAssetImage } from "./use-creative";

/*
  mc-agent creative studio: compare images. Panels sit on top in a row, a
  column or a grid; the project's images run along the bottom and are dragged
  up into the panels (onto the empty slot to add, onto a panel to replace it;
  panels swap by dragging one onto another). Zoom (wheel) and pan (drag) are
  shared, so the same detail is compared everywhere; two images can also be
  laid over each other with a slider.
*/

const DRAG_TYPE = "application/x-mc-compare-asset";
const LAYOUT_KEY = "mc.creative.compareLayout";

type View = { scale: number; x: number; y: number };
const START: View = { scale: 1, x: 0, y: 0 };

function readLayout(): CompareLayout {
  try {
    const raw = JSON.parse(localStorage.getItem(LAYOUT_KEY) ?? "null") as Partial<CompareLayout> | null;
    if (raw && (raw.kind === "row" || raw.kind === "column" || raw.kind === "grid")) {
      return { kind: raw.kind, columns: typeof raw.columns === "number" ? Math.min(6, Math.max(0, raw.columns)) : 0 };
    }
  } catch {
    // Remembering the layout is a convenience only.
  }
  return { kind: "row", columns: 0 };
}

function storeLayout(layout: CompareLayout) {
  try {
    localStorage.setItem(LAYOUT_KEY, JSON.stringify(layout));
  } catch {
    // Remembering the layout is a convenience only.
  }
}

function draggedId(event: DragEvent): string | null {
  return event.dataTransfer.types.includes(DRAG_TYPE) ? event.dataTransfer.getData(DRAG_TYPE) || null : null;
}

function acceptsDrop(event: DragEvent): boolean {
  if (!event.dataTransfer.types.includes(DRAG_TYPE)) return false;
  event.preventDefault();
  event.dataTransfer.dropEffect = "move";
  return true;
}

function Panel({
  asset,
  view,
  chosen,
  dropping,
  onChoose,
  onRemove,
  onWheel,
  onPointerDown,
  onDragOver,
  onDragLeave,
  onDrop,
}: {
  asset: CreativeAsset;
  view: View;
  chosen: boolean;
  dropping: boolean;
  onChoose: () => void;
  onRemove: () => void;
  onWheel: (event: WheelEvent) => void;
  onPointerDown: (event: ReactPointerEvent) => void;
  onDragOver: (event: DragEvent) => void;
  onDragLeave: () => void;
  onDrop: (event: DragEvent) => void;
}) {
  const { t } = useTranslation();
  const url = useAssetImage(asset.groupId, asset.id, 0);
  return (
    <figure
      className={cx("mc-creative-compare-panel", chosen && "is-chosen", dropping && "is-drop")}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      <div className="mc-creative-compare-stage" onWheel={onWheel} onPointerDown={onPointerDown}>
        {url ? (
          <img
            src={url}
            alt={asset.title}
            draggable={false}
            style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})` }}
          />
        ) : null}
      </div>
      <figcaption>
        <span
          className="mc-creative-compare-grip"
          draggable
          title={t("mcProject.creativeCompareDragToSwap")}
          onDragStart={(event) => {
            event.dataTransfer.setData(DRAG_TYPE, asset.id);
            event.dataTransfer.effectAllowed = "move";
          }}
        >
          <IconGripVertical size={13} />
        </span>
        <span className="mc-creative-compare-title" title={asset.title}>
          {asset.title || t("mcProject.creativeAsset")}
        </span>
        <button
          type="button"
          className={cx("mc-creative-icon-button mc-creative-compare-choose", chosen && "is-on")}
          aria-pressed={chosen}
          aria-label={chosen ? t("mcProject.creativeChosen") : t("mcProject.creativeChoose")}
          title={chosen ? t("mcProject.creativeChosen") : t("mcProject.creativeChoose")}
          onClick={onChoose}
        >
          <IconCheck size={14} />
        </button>
        <button type="button" className="mc-creative-icon-button" aria-label={t("mcProject.creativeRemoveFromCompare")} onClick={onRemove}>
          <IconX size={13} />
        </button>
      </figcaption>
    </figure>
  );
}

function SliderOverlay({
  left,
  right,
  onDropSide,
}: {
  left: CreativeAsset;
  right: CreativeAsset;
  /** An image dropped on the left or right half takes that side. */
  onDropSide: (side: "left" | "right", id: string) => void;
}) {
  const { t } = useTranslation();
  const leftUrl = useAssetImage(left.groupId, left.id, 0);
  const rightUrl = useAssetImage(right.groupId, right.id, 0);
  const [split, setSplit] = useState(50);
  const [dropping, setDropping] = useState<"left" | "right" | null>(null);
  const half = (side: "left" | "right") => ({
    className: cx("mc-creative-slider-drop", `is-${side}`, dropping === side && "is-drop"),
    onDragOver: (event: DragEvent) => {
      if (acceptsDrop(event)) setDropping(side);
    },
    onDragLeave: () => setDropping((current) => (current === side ? null : current)),
    onDrop: (event: DragEvent) => {
      const id = draggedId(event);
      setDropping(null);
      if (!id) return;
      event.preventDefault();
      onDropSide(side, id);
    },
  });
  return (
    <div className="mc-creative-slider">
      <div className="mc-creative-slider-stage">
        {rightUrl ? <img src={rightUrl} alt={right.title} draggable={false} /> : null}
        <div className="mc-creative-slider-clip" style={{ clipPath: `inset(0 ${100 - split}% 0 0)` }}>
          {leftUrl ? <img src={leftUrl} alt={left.title} draggable={false} /> : null}
        </div>
        <div className="mc-creative-slider-line" style={{ left: `${split}%` }} />
        <div {...half("left")}>{dropping === "left" ? <span>{t("mcProject.creativeCompareSliderLeft")}</span> : null}</div>
        <div {...half("right")}>{dropping === "right" ? <span>{t("mcProject.creativeCompareSliderRight")}</span> : null}</div>
      </div>
      <input
        type="range"
        min={0}
        max={100}
        value={split}
        onChange={(event) => setSplit(Number(event.target.value))}
        aria-label="split"
      />
    </div>
  );
}

function StripTile({ asset, inUse, onAdd }: { asset: CreativeAsset; inUse: boolean; onAdd: () => void }) {
  const { t } = useTranslation();
  const url = useAssetImage(asset.groupId, asset.id, 240);
  return (
    <div
      className={cx("mc-creative-strip-tile", inUse && "is-in-use")}
      draggable
      title={asset.title}
      onDragStart={(event) => {
        event.dataTransfer.setData(DRAG_TYPE, asset.id);
        event.dataTransfer.effectAllowed = "copyMove";
      }}
      onDoubleClick={onAdd}
    >
      {url ? <img src={url} alt={asset.title} draggable={false} /> : null}
      {inUse ? (
        <span className="mc-creative-strip-mark" aria-label={t("mcProject.creativeCompareInUse")}>
          <IconCheck size={11} />
        </span>
      ) : null}
    </div>
  );
}

export function CompareView({
  ids,
  library,
  categories,
  comparison,
  saved,
  onOpen,
  onChange,
  onSave,
}: {
  /** The compared images, in panel order. */
  ids: string[];
  /** The project's images, for the strip. */
  library: readonly CreativeAsset[];
  categories: readonly CreativeCategory[];
  comparison: CreativeComparison | null;
  /** Saved comparisons of the project, to reopen. */
  saved: readonly CreativeComparison[];
  /** Open a saved comparison, or start a new one (null). */
  onOpen: (comparison: CreativeComparison | null) => void;
  onChange: (ids: string[]) => void;
  onSave: (input: { title: string; note: string; chosen: string | null }) => Promise<void>;
}) {
  const { t } = useTranslation();
  const [view, setView] = useState<View>(START);
  const [mode, setMode] = useState<"panels" | "slider">("panels");
  const [layout, setLayout] = useState<CompareLayout>(readLayout);
  const [title, setTitle] = useState(comparison?.title ?? "");
  const [note, setNote] = useState(comparison?.note ?? "");
  const [chosen, setChosen] = useState<string | null>(comparison?.chosen ?? null);
  const [saving, setSaving] = useState(false);
  const [dropTarget, setDropTarget] = useState<number | null | undefined>(undefined);
  const [stripView, setStripView] = useState<StudioView>({ kind: "all" });
  const drag = useRef<{ x: number; y: number; view: View } | null>(null);

  const byId = useMemo(() => new Map(library.map((asset) => [asset.id, asset])), [library]);
  const assets = ids.map((id) => byId.get(id)).filter((asset): asset is CreativeAsset => !!asset);
  const strip = useMemo(
    () => viewAssets(library, stripView).filter((asset) => asset.fileExists),
    [library, stripView],
  );
  const options = useMemo(() => flattenCategories(categoryTree(categories)), [categories]);
  const canAdd = ids.length < MAX_COMPARE;
  // The add slot is a panel only while the comparison is empty; after that a
  // small box in the corner takes drops.
  const grid = compareGrid(layout, assets.length || 1);
  // With images in the comparison, the add slot is a thin track at the end
  // of the layout: a narrow column, a short row, or a bar under the grid.
  const addTrack = assets.length > 0 && canAdd;
  const tracks = {
    columns: `repeat(${grid.columns}, minmax(0, 1fr))${addTrack && layout.kind === "row" ? " 64px" : ""}`,
    rows: `repeat(${grid.rows}, minmax(0, 1fr))${addTrack && layout.kind !== "row" ? " 44px" : ""}`,
  };
  // The two images the slider lays over each other (any two of the comparison).
  const [pair, setPair] = useState<[string | null, string | null]>([null, null]);
  const leftId = pair[0] && ids.includes(pair[0]) ? pair[0] : ids[0] ?? null;
  const rightId = pair[1] && ids.includes(pair[1]) && pair[1] !== leftId ? pair[1] : ids.find((id) => id !== leftId) ?? null;
  const left = leftId ? byId.get(leftId) : undefined;
  const right = rightId ? byId.get(rightId) : undefined;
  const slider = mode === "slider" && !!left && !!right;

  useEffect(() => {
    setTitle(comparison?.title ?? "");
    setNote(comparison?.note ?? "");
    setChosen(comparison?.chosen ?? null);
  }, [comparison]);

  useEffect(() => {
    if (assets.length < 2 && mode === "slider") setMode("panels");
  }, [assets.length, mode]);

  useEffect(() => {
    const move = (event: PointerEvent) => {
      const start = drag.current;
      if (!start) return;
      setView({ ...start.view, x: start.view.x + event.clientX - start.x, y: start.view.y + event.clientY - start.y });
    };
    const up = () => {
      drag.current = null;
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("blur", up);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("blur", up);
    };
  }, []);

  const onWheel = (event: WheelEvent) => {
    const factor = event.deltaY < 0 ? 1.1 : 1 / 1.1;
    setView((current) => ({ ...current, scale: Math.min(8, Math.max(0.5, current.scale * factor)) }));
  };
  const onPointerDown = (event: ReactPointerEvent) => {
    if (event.button !== 0) return;
    drag.current = { x: event.clientX, y: event.clientY, view };
  };

  const changeLayout = (next: CompareLayout) => {
    setLayout(next);
    storeLayout(next);
  };

  const dropProps = (target: number | null) => ({
    onDragOver: (event: DragEvent) => {
      if (acceptsDrop(event)) setDropTarget(target);
    },
    onDragLeave: () => setDropTarget((current) => (current === target ? undefined : current)),
    onDrop: (event: DragEvent) => {
      const id = draggedId(event);
      setDropTarget(undefined);
      if (!id) return;
      event.preventDefault();
      onChange(placeInComparison(ids, id, target));
    },
  });

  return (
    <div className="mc-creative-compare">
      <div className="mc-creative-compare-bar">
        <select
          className="mc-creative-select mc-creative-compare-pick"
          aria-label={t("mcProject.creativeSectionComparisons")}
          value={comparison?.id ?? ""}
          onChange={(event) => onOpen(saved.find((entry) => entry.id === event.target.value) ?? null)}
        >
          <option value="">{t("mcProject.creativeCompareNew")}</option>
          {saved.map((entry) => (
            <option key={entry.id} value={entry.id}>
              {entry.title} · {t("mcProject.creativeCompareCount", { count: entry.assetIds.length })}
            </option>
          ))}
        </select>
        <div className="mc-creative-segment" role="group" aria-label={t("mcProject.creativeCompareLayout")}>
          {(["row", "column", "grid"] as const).map((kind) => (
            <button
              key={kind}
              type="button"
              className={cx(!slider && layout.kind === kind && "is-on")}
              onClick={() => {
                setMode("panels");
                changeLayout({ ...layout, kind });
              }}
            >
              {t(kind === "row" ? "mcProject.creativeCompareRow" : kind === "column" ? "mcProject.creativeCompareColumn" : "mcProject.creativeCompareGrid")}
            </button>
          ))}
          <button
            type="button"
            className={cx(slider && "is-on")}
            disabled={assets.length < 2}
            title={assets.length < 2 ? t("mcProject.creativeCompareSliderHint") : undefined}
            onClick={() => setMode("slider")}
          >
            {t("mcProject.creativeCompareSlider")}
          </button>
        </div>
        {slider ? (
          <>
            {(["left", "right"] as const).map((side) => (
              <label key={side} className="mc-creative-field">
                <span>{t(side === "left" ? "mcProject.creativeCompareSliderLeft" : "mcProject.creativeCompareSliderRight")}</span>
                <select
                  className="mc-creative-select mc-creative-compare-side"
                  value={(side === "left" ? leftId : rightId) ?? ""}
                  onChange={(event) =>
                    setPair(side === "left" ? [event.target.value, rightId] : [leftId, event.target.value])
                  }
                >
                  {assets.map((asset, index) => (
                    <option key={asset.id} value={asset.id} disabled={asset.id === (side === "left" ? rightId : leftId)}>
                      {index + 1}. {asset.title || t("mcProject.creativeAsset")}
                    </option>
                  ))}
                </select>
              </label>
            ))}
          </>
        ) : null}
        {layout.kind === "grid" && !slider ? (
          <label className="mc-creative-field">
            <span>{t("mcProject.creativeCompareColumns")}</span>
            <select
              className="mc-creative-select"
              value={layout.columns}
              onChange={(event) => changeLayout({ ...layout, columns: Number(event.target.value) })}
            >
              <option value={0}>{t("mcProject.creativeAspectAuto")}</option>
              {[2, 3, 4, 5, 6].map((count) => (
                <option key={count} value={count}>
                  {count}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        <Button size="sm" variant="ghost" onClick={() => setView(START)}>
          {t("mcProject.creativeCompareReset")}
        </Button>
        <span className="mc-creative-muted mc-creative-compare-hint">{t("mcProject.creativeCompareHint")}</span>
      </div>

      {slider ? (
        <SliderOverlay
          left={left!}
          right={right!}
          onDropSide={(side, id) => {
            if (!ids.includes(id)) onChange(placeInComparison(ids, id, ids.length >= MAX_COMPARE ? ids.indexOf((side === "left" ? leftId : rightId)!) : null));
            setPair(side === "left" ? [id, rightId === id ? leftId : rightId] : [leftId === id ? rightId : leftId, id]);
          }}
        />
      ) : (
        <div
          className="mc-creative-compare-panels"
          style={{ gridTemplateColumns: tracks.columns, gridTemplateRows: tracks.rows }}
        >
          {assets.map((asset, index) => (
            <Panel
              key={asset.id}
              asset={asset}
              view={view}
              chosen={chosen === asset.id}
              dropping={dropTarget === index}
              onChoose={() => setChosen((current) => (current === asset.id ? null : asset.id))}
              onRemove={() => onChange(ids.filter((id) => id !== asset.id))}
              onWheel={onWheel}
              onPointerDown={onPointerDown}
              {...dropProps(index)}
            />
          ))}
          {!assets.length ? (
            <div className={cx("mc-creative-compare-empty", dropTarget === null && "is-drop")} {...dropProps(null)}>
              <IconPlus size={18} />
              <span>{t("mcProject.creativeCompareDropFirst")}</span>
            </div>
          ) : addTrack ? (
            <div
              className={cx("mc-creative-compare-add", `is-${layout.kind}`, dropTarget === null && "is-drop")}
              title={t("mcProject.creativeCompareDropMore")}
              {...dropProps(null)}
            >
              <IconPlus size={14} />
              <span>{t("mcProject.creativeCompareAdd")}</span>
            </div>
          ) : null}
        </div>
      )}

      <div className="mc-creative-compare-save">
        <input
          className="mc-creative-input"
          value={title}
          placeholder={t("mcProject.creativeCompareTitle")}
          onChange={(event) => setTitle(event.target.value)}
        />
        <input
          className="mc-creative-input mc-creative-grow"
          value={note}
          placeholder={t("mcProject.creativeCompareNote")}
          onChange={(event) => setNote(event.target.value)}
        />
        <Button
          size="sm"
          variant="primary"
          disabled={saving || assets.length < 2 || !title.trim()}
          onClick={() => {
            setSaving(true);
            void onSave({ title: title.trim(), note, chosen: chosen && ids.includes(chosen) ? chosen : null }).finally(() =>
              setSaving(false),
            );
          }}
        >
          {comparison ? t("mcProject.creativeCompareUpdate") : t("mcProject.creativeCompareSave")}
        </Button>
      </div>

      <div className="mc-creative-strip">
        <div className="mc-creative-strip-head">
          <span className="mc-creative-muted">{t("mcProject.creativeCompareStripHint")}</span>
          <select
            className="mc-creative-select"
            aria-label={t("mcProject.creativeCategories")}
            value={stripView.kind === "category" ? `c:${stripView.path}` : stripView.kind}
            onChange={(event) => {
              const value = event.target.value;
              setStripView(
                value === "all"
                  ? { kind: "all" }
                  : value === "uncategorized"
                    ? { kind: "uncategorized" }
                    : { kind: "category", path: value.slice(2) },
              );
            }}
          >
            <option value="all">{t("mcProject.creativeViewAll")}</option>
            <option value="uncategorized">{t("mcProject.creativeUncategorized")}</option>
            {options.map((node) => (
              <option key={node.path} value={`c:${node.path}`}>
                {"　".repeat(node.path.split("/").length - 1)}
                {node.name}
              </option>
            ))}
          </select>
        </div>
        <div className="mc-creative-strip-list">
          {strip.length ? (
            strip.map((asset) => (
              <StripTile
                key={asset.id}
                asset={asset}
                inUse={ids.includes(asset.id)}
                onAdd={() => onChange(placeInComparison(ids, asset.id, null))}
              />
            ))
          ) : (
            <p className="mc-creative-muted">{t("mcProject.creativeNothingHere")}</p>
          )}
        </div>
      </div>
    </div>
  );
}
