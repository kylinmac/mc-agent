import { useEffect, useRef, useState, type MouseEvent, type PointerEvent } from "react";
import { neighbour, selectionAfterClick } from "./creative-model";

/*
  The studio grid's selection, as in photo libraries: click, ⌘-click and
  ⇧-click runs, box selection on empty space (Finder), and the keyboard's ⌘A,
  Esc and arrows. A selection belongs to the view it was made in: switching
  views starts fresh, and a search keeps only what is still on screen.
*/

export type MarqueeBox = { left: number; top: number; width: number; height: number };

export function useGridSelection({
  order,
  viewKey,
  disabled,
}: {
  /** The grid's visible order, for runs, arrows and select-all. */
  order: readonly string[];
  /** Changes when the view changes; the selection starts over. */
  viewKey: string;
  /** No box selection (the comparison workspace). */
  disabled: boolean;
}) {
  const [selection, setSelection] = useState<string[]>([]);
  const [anchor, setAnchor] = useState<string | null>(null);
  const [focusId, setFocusId] = useState<string | null>(null);
  const [marquee, setMarquee] = useState<MarqueeBox | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    setSelection([]);
    setAnchor(null);
    setFocusId(null);
  }, [viewKey]);
  useEffect(() => {
    setSelection((current) => {
      const kept = current.filter((id) => order.includes(id));
      return kept.length === current.length ? current : kept;
    });
  }, [order]);

  const selectTile = (id: string, event: MouseEvent) => {
    const next = selectionAfterClick(selection, anchor, order, id, {
      toggle: event.metaKey || event.ctrlKey,
      range: event.shiftKey,
    });
    setSelection(next.selection);
    setAnchor(next.anchor);
    setFocusId(id);
  };

  /** Select just this tile (a right-click outside the selection, a drag). */
  const selectOnly = (id: string) => {
    setSelection([id]);
    setAnchor(id);
    setFocusId(id);
  };

  /*
    Box selection on empty space, as in Finder: the rectangle selects what it
    touches (added to the selection with ⇧/⌘); a click without a drag clears it.
  */
  const startMarquee = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || disabled) return;
    const target = event.target as HTMLElement;
    if (target.closest(".mc-creative-tile, button, a, input, select, textarea")) return;
    const container = scrollRef.current;
    if (!container) return;
    const keep = event.shiftKey || event.metaKey || event.ctrlKey ? selection : [];
    const origin = { x: event.clientX, y: event.clientY };
    let moved = false;
    const box = container.getBoundingClientRect();
    const onMove = (move: globalThis.PointerEvent) => {
      const left = Math.min(origin.x, move.clientX);
      const top = Math.min(origin.y, move.clientY);
      const right = Math.max(origin.x, move.clientX);
      const bottom = Math.max(origin.y, move.clientY);
      if (!moved && right - left < 4 && bottom - top < 4) return;
      moved = true;
      setMarquee({
        left: left - box.left + container.scrollLeft,
        top: top - box.top + container.scrollTop,
        width: right - left,
        height: bottom - top,
      });
      const hits = [...container.querySelectorAll<HTMLElement>("[data-asset-id]")]
        .filter((tile) => {
          const rect = tile.getBoundingClientRect();
          return rect.right > left && rect.left < right && rect.bottom > top && rect.top < bottom;
        })
        .map((tile) => tile.dataset.assetId!)
        .filter((id) => !keep.includes(id));
      setSelection([...keep, ...hits]);
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      setMarquee(null);
      if (!moved && !keep.length) setSelection([]);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  /** ⌘A, Esc and the arrows; true when the key was handled here. */
  const navigateKey = (event: KeyboardEvent): boolean => {
    const mod = event.metaKey || event.ctrlKey;
    if (mod && event.key.toLowerCase() === "a") {
      event.preventDefault();
      setSelection([...order]);
      return true;
    }
    if (event.key === "Escape" && selection.length) {
      event.preventDefault();
      setSelection([]);
      return true;
    }
    if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) return false;
    event.preventDefault();
    const from = focusId && order.includes(focusId) ? focusId : selection[selection.length - 1] ?? null;
    let next: string | null;
    if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      next = neighbour(order, from, event.key === "ArrowLeft" ? -1 : 1);
    } else {
      // Up/down: the nearest tile in the row above or below.
      const tiles = [...(scrollRef.current?.querySelectorAll<HTMLElement>("[data-asset-id]") ?? [])];
      const current = tiles.find((tile) => tile.dataset.assetId === from);
      if (!current) next = neighbour(order, null, 1);
      else {
        const here = current.getBoundingClientRect();
        const down = event.key === "ArrowDown";
        const candidates = tiles
          .map((tile) => ({ id: tile.dataset.assetId!, rect: tile.getBoundingClientRect() }))
          .filter(({ rect }) => (down ? rect.top > here.top + 4 : rect.top < here.top - 4))
          .sort(
            (a, b) =>
              Math.abs(a.rect.top - here.top) - Math.abs(b.rect.top - here.top) ||
              Math.abs(a.rect.left - here.left) - Math.abs(b.rect.left - here.left),
          );
        const rowTop = candidates[0]?.rect.top;
        next =
          candidates
            .filter(({ rect }) => rect.top === rowTop)
            .sort((a, b) => Math.abs(a.rect.left - here.left) - Math.abs(b.rect.left - here.left))[0]?.id ?? from;
      }
    }
    if (next) {
      const step = selectionAfterClick(selection, anchor, order, next, { toggle: false, range: event.shiftKey });
      setSelection(step.selection);
      setAnchor(step.anchor);
      setFocusId(next);
      scrollRef.current?.querySelector(`[data-asset-id="${CSS.escape(next)}"]`)?.scrollIntoView({ block: "nearest" });
    }
    return true;
  };

  /** The tile the keyboard acts on: the focused one if selected, else the last selected. */
  const keyTarget = focusId && selection.includes(focusId) ? focusId : selection[selection.length - 1];

  return {
    selection,
    setSelection,
    anchor,
    setAnchor,
    focusId,
    setFocusId,
    marquee,
    scrollRef,
    selectTile,
    selectOnly,
    startMarquee,
    navigateKey,
    keyTarget,
  };
}
