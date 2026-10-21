import assert from "node:assert/strict";
import test from "node:test";
import { register } from "node:module";

register("./helpers/ts-import-hooks.mjs", import.meta.url);
const model = await import("../src/features/creative/creative-model.ts");

const asset = (id, over = {}) => ({
  id, groupId: "g", origin: "model", kind: "image", path: `/p/${id}.png`, sha256: id, bytes: 1,
  title: id, favorite: false, createdAt: 0, fileExists: true, jobId: null, resultIndex: null, category: "", ...over,
});
const job = (id, results, over = {}) => ({
  id, groupId: "g", entry: "form", snapshot: { prompt: id }, status: "done", createdAt: 0, updatedAt: 0, results, ...over,
});

test("views list all, uncategorized, and a category with its children", () => {
  const assets = [
    asset("a", { category: "" }),
    asset("b", { category: "角色" }),
    asset("c", { category: "角色/角色A", favorite: true }),
    asset("d", { category: "角色X" }),
  ];
  assert.deepEqual(model.viewAssets(assets, { kind: "all" }).map((x) => x.id), ["a", "b", "c", "d"]);
  assert.deepEqual(model.viewAssets(assets, { kind: "uncategorized" }).map((x) => x.id), ["a"]);
  assert.deepEqual(model.viewAssets(assets, { kind: "category", path: "角色" }).map((x) => x.id), ["b", "c"]);
});

test("the category tree nests paths and totals include sub-categories", () => {
  const tree = model.categoryTree([
    { path: "scene/wild", count: 2 },
    { path: "role", count: 1 },
    { path: "role/hero", count: 3 },
    { path: "scene/village", count: 0 },
  ]);
  assert.deepEqual(tree.map((n) => [n.name, n.total]), [["role", 4], ["scene", 2]]);
  assert.deepEqual(tree[1].children.map((n) => n.path), ["scene/village", "scene/wild"]);
  assert.deepEqual(model.flattenCategories(tree).map((n) => n.path), ["role", "role/hero", "scene", "scene/village", "scene/wild"]);
});

test("the grid runs images together by day, newest first, batches kept together", () => {
  const day = (d, h) => new Date(2026, 9, d, h).getTime();
  const jobs = [
    job("j3", [{ index: 0, status: "done", assetId: "c" }, { index: 1, status: "failed", error: "IMAGE_HTTP_500" }], { createdAt: day(21, 10) }),
    job("j2", [{ index: 0, status: "done", assetId: "b" }], { createdAt: day(21, 9) }),
    job("j1", [{ index: 0, status: "failed", error: "IMAGE_AUTH_FAILED" }], { status: "failed", createdAt: day(20, 9) }),
  ];
  const assets = [
    // Saved a little after its job was asked for; it still sorts with the job.
    asset("b", { jobId: "j2", resultIndex: 0, createdAt: day(21, 9) + 5000 }),
    asset("c", { jobId: "j3", resultIndex: 0, createdAt: day(21, 10) + 9000 }),
    asset("ref", { origin: "import", createdAt: day(20, 8) }),
  ];
  const groups = model.dayGroups(assets, jobs, true);
  assert.deepEqual(groups.map((g) => g.day), ["2026-10-21", "2026-10-20"]);
  assert.deepEqual(groups[0].items.map((i) => i.key), ["c", "j3:1", "b"]);
  assert.equal(groups[0].items[1].error, "IMAGE_HTTP_500");
  assert.equal(groups[0].items[0].job.id, "j3");
  assert.deepEqual(groups[1].items.map((i) => i.key), ["j1:0", "ref"]);
  // Without placeholders (a category or a search), only images remain.
  assert.deepEqual(model.dayGroups(assets, jobs, false).flatMap((g) => g.items.map((i) => i.key)), ["c", "b", "ref"]);
});

test("the queue lists running jobs first, then the latest finished", () => {
  const jobs = [
    job("done1", []),
    job("run", [], { status: "running" }),
    job("done2", []),
  ];
  assert.deepEqual(model.queueJobs(jobs, 1).map((j) => j.id), ["run", "done1"]);
  assert.equal(model.isActiveJob(jobs[1]), true);
});

test("selection keeps click order and references keep their roles", () => {
  let selection = model.toggleSelection([], "a");
  selection = model.toggleSelection(selection, "b");
  selection = model.toggleSelection(selection, "c");
  selection = model.toggleSelection(selection, "a");
  assert.deepEqual(selection, ["b", "c"]);
  const refs = model.referencesFromSelection(selection, [{ assetId: "c", role: "style" }]);
  assert.deepEqual(refs, [
    { assetId: "b", role: "reference" },
    { assetId: "c", role: "style" },
  ]);
});

test("the chat handoff writes order, role and path so it does not depend on later selection", () => {
  const text = model.chatHandoffText(
    [
      { asset: asset("x", { title: "猫" }), role: "edit" },
      { asset: asset("y", { title: "" }), role: "style" },
    ],
    (role) => ({ edit: "修改这张", style: "风格参考", reference: "参考" })[role],
    "参考这些图片（按顺序）：",
  );
  assert.match(text, /^参考这些图片（按顺序）：\n1\. 修改这张：猫 \(\/p\/x\.png\)\n2\. 风格参考：y\.png \(\/p\/y\.png\)/);
  assert.equal(model.chatHandoffText([], () => "", "x"), "");
});

test("clicks select like a photo library: plain, ⌘ toggle, ⇧ range", () => {
  const order = ["a", "b", "c", "d", "e"];
  let state = model.selectionAfterClick([], null, order, "b", { toggle: false, range: false });
  assert.deepEqual(state, { selection: ["b"], anchor: "b" });
  state = model.selectionAfterClick(state.selection, state.anchor, order, "d", { toggle: false, range: true });
  assert.deepEqual(state, { selection: ["b", "c", "d"], anchor: "b" });
  state = model.selectionAfterClick(state.selection, state.anchor, order, "a", { toggle: true, range: false });
  assert.deepEqual(state, { selection: ["b", "c", "d", "a"], anchor: "a" });
  state = model.selectionAfterClick(state.selection, state.anchor, order, "c", { toggle: true, range: false });
  assert.deepEqual(state.selection, ["b", "d", "a"]);
  // ⌘⇧ adds a run to what is already selected.
  state = model.selectionAfterClick(["e"], "a", order, "b", { toggle: true, range: true });
  assert.deepEqual(state.selection, ["e", "a", "b"]);
  // A plain click replaces everything.
  assert.deepEqual(model.selectionAfterClick(["a", "b"], "a", order, "e", { toggle: false, range: false }).selection, ["e"]);
});

test("neighbour steps through the visible order and stays at the ends", () => {
  const order = ["a", "b", "c"];
  assert.equal(model.neighbour(order, "b", 1), "c");
  assert.equal(model.neighbour(order, "c", 1), "c");
  assert.equal(model.neighbour(order, "a", -1), "a");
  assert.equal(model.neighbour(order, null, 1), "a");
  assert.equal(model.neighbour(order, null, -1), "c");
  assert.equal(model.neighbour([], "a", 1), null);
});

test("dropping onto a comparison adds, replaces or swaps", () => {
  const ids = ["a", "b", "c"];
  assert.deepEqual(model.placeInComparison(ids, "d", null), ["a", "b", "c", "d"]);
  assert.deepEqual(model.placeInComparison(ids, "d", 1), ["a", "d", "c"]);
  assert.deepEqual(model.placeInComparison(ids, "c", 0), ["c", "b", "a"]);
  assert.deepEqual(model.placeInComparison(ids, "a", null), ["b", "c", "a"]);
  assert.deepEqual(model.placeInComparison(ids, "b", 1), ids);
  const full = Array.from({ length: model.MAX_COMPARE }, (_, i) => `x${i}`);
  assert.equal(model.placeInComparison(full, "new", null).length, model.MAX_COMPARE);
  assert.equal(model.placeInComparison(full, "new", 0)[0], "new");
});

test("comparison layouts lay panels in a row, a column or a grid", () => {
  assert.deepEqual(model.compareGrid({ kind: "row", columns: 0 }, 3), { columns: 3, rows: 1 });
  assert.deepEqual(model.compareGrid({ kind: "column", columns: 0 }, 3), { columns: 1, rows: 3 });
  assert.deepEqual(model.compareGrid({ kind: "grid", columns: 0 }, 5), { columns: 3, rows: 2 });
  assert.deepEqual(model.compareGrid({ kind: "grid", columns: 2 }, 5), { columns: 2, rows: 3 });
  assert.deepEqual(model.compareGrid({ kind: "grid", columns: 4 }, 2), { columns: 2, rows: 1 });
});

test("the chat is told the compared images in panel order with their paths", () => {
  const text = model.compareContextText(
    [asset("a", { title: "龙", path: "/p/creative/龙.png" }), asset("b", { title: "", path: "/p/creative/red.png" })],
    "Compared:",
  );
  assert.equal(text, "Compared:\n1. 龙 (/p/creative/龙.png)\n2. red.png (/p/creative/red.png)");
  assert.equal(model.compareContextText([], "Compared:"), "");
});
