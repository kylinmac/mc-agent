/*
  mc-agent creative studio: what the pointer carries while images are dragged
  onto a category — up to three thumbnails stacked like a pile, with the count.
  Built from the tiles' own previews, shown for the drag only.
*/
export function setAssetDragImage(
  event: DragEvent | { dataTransfer: DataTransfer | null },
  ids: readonly string[],
  label: string,
): void {
  const transfer = event.dataTransfer;
  if (!transfer || typeof transfer.setDragImage !== "function") return;
  const sources = ids
    .slice(0, 3)
    .map((id) => document.querySelector<HTMLImageElement>(`[data-asset-id="${CSS.escape(id)}"] img`)?.src)
    .filter((src): src is string => !!src);
  const pile = document.createElement("div");
  pile.className = "mc-creative-drag-pile";
  sources.reverse().forEach((src, index) => {
    const image = document.createElement("img");
    image.src = src;
    image.style.transform = `translate(${index * 6}px, ${index * 6}px) rotate(${(index - (sources.length - 1) / 2) * 4}deg)`;
    pile.appendChild(image);
  });
  const badge = document.createElement("span");
  badge.className = "mc-creative-drag-badge";
  badge.textContent = label;
  pile.appendChild(badge);
  document.body.appendChild(pile);
  transfer.setDragImage(pile, 36, 36);
  // The browser snapshots the element at once; it is not needed afterwards.
  window.setTimeout(() => pile.remove(), 0);
}
