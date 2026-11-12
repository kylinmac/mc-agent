type SourceNode = {
  type: string;
  properties?: Record<string, unknown>;
  position?: { start: { offset?: number }; end: { offset?: number } };
  children?: SourceNode[];
};

export type SourcePositionProps = {
  "data-source-start"?: number;
  "data-source-end"?: number;
};

/** Attach parser-owned offsets after sanitization, relative to the full message. */
export function rehypeSourcePositions({ offset }: { offset: number }) {
  return (tree: SourceNode) => {
    const pending = [tree];
    while (pending.length) {
      const node = pending.pop()!;
      if (node.children) pending.push(...node.children);
      const start = node.position?.start.offset;
      const end = node.position?.end.offset;
      if (node.type !== "element" || start === undefined || end === undefined) continue;
      node.properties = {
        ...node.properties,
        "data-source-start": offset + start,
        "data-source-end": offset + end,
      };
    }
  };
}

/** Custom Markdown components may change their tag but retain the source anchor. */
export function sourcePositionProps(props: SourcePositionProps): SourcePositionProps {
  return {
    "data-source-start": props["data-source-start"],
    "data-source-end": props["data-source-end"],
  };
}

/** Offset of the first code unit of a 1-based line; past the end clamps to the length. */
export function lineStartOffset(source: string, line: number): number {
  let offset = 0;
  for (let current = 1; current < line; current += 1) {
    const next = source.indexOf("\n", offset);
    if (next < 0) return source.length;
    offset = next + 1;
  }
  return offset;
}

/**
 * The rendered element that best stands for a source offset: the narrowest
 * range containing it, else the first one starting after it (a blank line
 * between blocks), else the last one. Returns an index into `ranges`, or -1.
 */
export function sourceAnchorIndex(
  ranges: readonly { start: number; end: number }[],
  offset: number,
): number {
  let best = -1;
  let next = -1;
  for (let i = 0; i < ranges.length; i += 1) {
    const { start, end } = ranges[i]!;
    if (start <= offset && offset < end) {
      if (best < 0 || end - start < ranges[best]!.end - ranges[best]!.start) best = i;
    } else if (start > offset && (next < 0 || start < ranges[next]!.start)) {
      next = i;
    }
  }
  if (best >= 0) return best;
  if (next >= 0) return next;
  return ranges.length - 1;
}
