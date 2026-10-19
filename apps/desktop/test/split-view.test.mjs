import assert from "node:assert/strict";
import test from "node:test";
import {
  closeColumn,
  columnWeights,
  followActive,
  normalizeStoredSplit,
  openColumnRight,
  pruneColumns,
  resizeColumns,
} from "../src/lib/mc-split-view.ts";
import { retainSessionPane } from "../src/lib/session-panes.ts";

// mc-agent split view (MC-ADR-0007).

test("opening to the right splits beside the focused column", () => {
  assert.deepEqual(openColumnRight([], "a", "b"), ["a", "b"]);
  assert.deepEqual(openColumnRight(["a", "b"], "a", "c"), ["a", "c", "b"]);
  // Already on screen: unchanged.
  assert.deepEqual(openColumnRight(["a", "b"], "a", "b"), ["a", "b"]);
  // Full: the rightmost column that is not focused gives way.
  assert.deepEqual(openColumnRight(["a", "b", "c"], "a", "d"), ["a", "b", "d"]);
  assert.deepEqual(openColumnRight(["a", "b", "c"], "c", "d"), ["a", "d", "c"]);
  // A new task without a session is a column too.
  assert.deepEqual(openColumnRight([], undefined, "b"), ["", "b"]);
});

test("a newly active session replaces the column that had focus", () => {
  const columns = ["a", "b"];
  assert.equal(followActive(columns, "a", "b"), columns);
  assert.deepEqual(followActive(columns, "b", "x"), ["a", "x"]);
  assert.deepEqual(followActive(["", "b"], undefined, "x"), ["x", "b"]);
  assert.deepEqual(followActive(["a", "b"], "a", undefined), ["", "b"]);
  // No split: nothing to follow.
  assert.deepEqual(followActive([], "a", "b"), []);
});

test("closing and pruning leave no one-column split", () => {
  assert.deepEqual(closeColumn(["a", "b", "c"], "b"), ["a", "c"]);
  assert.deepEqual(closeColumn(["a", "b"], "a"), []);
  const columns = ["a", "b", "c"];
  assert.equal(pruneColumns(columns, new Set(["a", "b", "c"])), columns);
  assert.deepEqual(pruneColumns(columns, new Set(["a", "c"])), ["a", "c"]);
  assert.deepEqual(pruneColumns(["a", "b"], new Set(["a"])), []);
  assert.deepEqual(pruneColumns(["", "b"], new Set(["b"])), ["", "b"]);
});

test("column widths trade across a divider within limits", () => {
  assert.deepEqual(columnWeights(2, [1.5, 0.5]), [1.5, 0.5]);
  assert.deepEqual(columnWeights(3, [1, 1]), [1, 1, 1]);
  assert.deepEqual(columnWeights(2, [1.8, 0.1]), [1, 1]);
  const moved = resizeColumns([1, 1], [500, 500], 0, 100);
  assert.ok(Math.abs(moved[0] - 1.2) < 1e-9 && Math.abs(moved[1] - 0.8) < 1e-9);
  // Never narrower than the minimum column.
  const far = resizeColumns([1, 1], [500, 500], 0, -900);
  assert.ok(Math.abs(far[0] - (2 * 320) / 1000) < 1e-9);
});

test("a stored split is restored only when it is one", () => {
  assert.deepEqual(normalizeStoredSplit({ columns: ["a", "b"], weights: [1.2, 0.8] }), {
    columns: ["a", "b"],
    weights: [1.2, 0.8],
  });
  assert.deepEqual(normalizeStoredSplit({ columns: ["a", "a"] }), { columns: [], weights: [] });
  assert.deepEqual(normalizeStoredSplit("junk"), { columns: [], weights: [] });
  assert.equal(normalizeStoredSplit({ columns: ["a", "b", "c", "d"] }).columns.length, 3);
});

test("split columns keep their retained panes beyond the bound", () => {
  const panes = { retainedSessionIds: ["c", "b", "a"], retainedTranscripts: { a: [], b: [], c: [] } };
  // Without a split the oldest pane is released.
  assert.deepEqual(retainSessionPane(panes, "d", [], []).retainedSessionIds, ["d", "c", "b"]);
  // A pinned column survives.
  assert.deepEqual(retainSessionPane(panes, "d", [], ["a", "d"]).retainedSessionIds, ["d", "c", "b", "a"]);
});
