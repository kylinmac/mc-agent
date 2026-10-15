/** Pure view helpers for the resource catalog (mc-agent R2/R3/R4). */

export type ResourceViewItem = {
  key: string;
  category: string;
  title: string;
  status: "draft" | "confirmed" | "changed" | "deprecated" | "missing";
};

/**
 * Items grouped by category in the folder's category order; categories with
 * no items still appear so a fresh template shows its structure, and
 * uncategorized items come last.
 */
export function groupByCategory<T extends ResourceViewItem>(
  items: readonly T[],
  categories: readonly string[],
): Array<{ category: string; items: T[] }> {
  const order = [...categories];
  for (const item of items) {
    if (item.category && !order.includes(item.category)) order.push(item.category);
  }
  const groups = order.map((category) => ({
    category,
    items: items.filter((item) => item.category === category),
  }));
  const loose = items.filter((item) => !item.category);
  if (loose.length > 0) groups.push({ category: "", items: loose });
  return groups;
}

/** Confirmed resources whose file changed, then missing ones. */
export function attentionItems<T extends ResourceViewItem>(items: readonly T[]): T[] {
  return [
    ...items.filter((item) => item.status === "changed"),
    ...items.filter((item) => item.status === "missing"),
  ];
}
