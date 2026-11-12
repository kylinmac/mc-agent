import assert from "node:assert/strict";
import test from "node:test";
import { lineStartOffset, sourceAnchorIndex } from "../src/lib/markdown-source.ts";

test("a 1-based line maps to the offset its text starts at", () => {
  const source = "# Title\n\nbody\r\nlast";
  assert.equal(lineStartOffset(source, 1), 0);
  assert.equal(lineStartOffset(source, 2), 8);
  assert.equal(lineStartOffset(source, 3), 9);
  assert.equal(lineStartOffset(source, 4), 15);
  assert.equal(lineStartOffset(source, 99), source.length);
});

test("a line lands on the narrowest rendered block that contains it", () => {
  // A list (0–30) holding an item (10–20), then a paragraph (32–40).
  const ranges = [
    { start: 0, end: 30 },
    { start: 10, end: 20 },
    { start: 32, end: 40 },
  ];
  assert.equal(sourceAnchorIndex(ranges, 12), 1);
  assert.equal(sourceAnchorIndex(ranges, 25), 0);
  // A blank line between blocks goes to the block after it.
  assert.equal(sourceAnchorIndex(ranges, 31), 2);
  // Past the last block stays on the last one.
  assert.equal(sourceAnchorIndex(ranges, 99), 2);
  assert.equal(sourceAnchorIndex([], 5), -1);
});
