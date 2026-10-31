import assert from "node:assert/strict";
import test from "node:test";
import { MAX_TABS, closeTab, closeTabGroup, moveTab, openTab, pruneTabs, tabDropTarget } from "../src/features/session-tabs/tab-list.ts";

test("batch close follows the clicked tab and keeps a surviving focus", () => {
  const tabs = ["a", "page:creative", "b", "c"];
  assert.deepEqual(closeTabGroup(tabs, "b", "a", "others"), { tabs: ["b"], next: "b", closedActive: true });
  assert.deepEqual(closeTabGroup(tabs, "page:creative", "c", "right"), { tabs: ["a", "page:creative"], next: "page:creative", closedActive: true });
  assert.deepEqual(closeTabGroup(tabs, "b", "a", "right"), { tabs: ["a", "page:creative", "b"], next: null, closedActive: false });
  assert.deepEqual(closeTabGroup(tabs, "b", "b", "all"), { tabs: [], next: null, closedActive: true });
  assert.deepEqual(closeTabGroup(tabs, "gone", "a", "all"), { tabs, next: null, closedActive: false });
  assert.deepEqual(tabs, ["a", "page:creative", "b", "c"]);
});

test("tabs keep their opening order and never duplicate", () => {
  let tabs = openTab([], "a");
  tabs = openTab(tabs, "b");
  tabs = openTab(tabs, "a");
  assert.deepEqual(tabs, ["a", "b"]);
});

test("the oldest tab drops past the limit, never the one being kept", () => {
  const full = Array.from({ length: MAX_TABS }, (_, i) => `s${i}`);
  assert.deepEqual(openTab(full, "new", "s0").slice(0, 2), ["s0", "s2"]);
  assert.equal(openTab(full, "new").length, MAX_TABS);
  assert.equal(openTab(full, "new").at(-1), "new");
});

test("closing the active tab shows its right neighbour, else its left one", () => {
  assert.deepEqual(closeTab(["a", "b", "c"], "b", "b"), { tabs: ["a", "c"], next: "c", closedActive: true });
  assert.deepEqual(closeTab(["a", "b", "c"], "c", "c"), { tabs: ["a", "b"], next: "b", closedActive: true });
  assert.deepEqual(closeTab(["a"], "a", "a"), { tabs: [], next: null, closedActive: true });
  assert.deepEqual(closeTab(["a", "b"], "a", "b"), { tabs: ["b"], next: null, closedActive: false });
  assert.deepEqual(closeTab(["a"], "x", "a").tabs, ["a"]);
});

test("tabs of deleted sessions are pruned", () => {
  assert.deepEqual(pruneTabs(["a", "b", "c"], new Set(["a", "c"])), ["a", "c"]);
});

test("app pages are tabs too and survive pruning", async () => {
  const { activeTabKey, pageTabKey, tabPage } = await import("../src/features/session-tabs/tab-list.ts");
  assert.equal(activeTabKey("creative", "s1"), "page:creative");
  assert.equal(activeTabKey("chat", "s1"), "s1");
  assert.equal(activeTabKey("chat", null), null);
  assert.equal(activeTabKey("projects", "s1"), null);
  assert.equal(tabPage(pageTabKey("creative")), "creative");
  assert.equal(tabPage("page:unknown"), null);
  assert.equal(tabPage("s1"), null);
  assert.deepEqual(pruneTabs(["page:creative", "gone", "s1"], new Set(["s1"])), ["page:creative", "s1"]);
});

test("rail-only pages never open tabs and old cached entries are migrated", async () => {
  const { activeTabKey, loadTabs } = await import("../src/features/session-tabs/tab-list.ts");
  for (const page of ["settings", "scheduled", "plugins"]) {
    assert.equal(activeTabKey(page, "s1"), null);
    assert.deepEqual(openTab(["s1"], `page:${page}`), ["s1"]);
  }
  let saved = JSON.stringify(["page:settings", "s1", "page:scheduled", "page:plugins", "page:creative"]);
  const previous = globalThis.window;
  globalThis.window = { localStorage: { getItem: () => saved, setItem: (_key, value) => { saved = value; } } };
  try {
    assert.deepEqual(loadTabs(), ["s1", "page:creative"]);
    assert.deepEqual(JSON.parse(saved), ["s1", "page:creative"]);
  } finally {
    if (previous === undefined) delete globalThis.window;
    else globalThis.window = previous;
  }
});

test("tabs reorder by drag position or a neighbour move", () => {
  const tabs = ["a", "b", "c", "d"];
  assert.deepEqual(moveTab(tabs, "d", "a", false), ["d", "a", "b", "c"]);
  assert.deepEqual(moveTab(tabs, "a", "c", true), ["b", "c", "a", "d"]);
  assert.deepEqual(moveTab(tabs, "a", "a", true), tabs);
  assert.deepEqual(moveTab(tabs, "x", "a", true), tabs);
  const rects = [
    { key: "a", left: 0, right: 100 },
    { key: "b", left: 102, right: 200 },
  ];
  assert.deepEqual(tabDropTarget(20, rects), { key: "a", after: false });
  assert.deepEqual(tabDropTarget(80, rects), { key: "a", after: true });
  assert.deepEqual(tabDropTarget(101, rects), { key: "a", after: true });
  assert.deepEqual(tabDropTarget(500, rects), { key: "b", after: true });
  assert.deepEqual(tabDropTarget(-5, rects), { key: "a", after: false });
  assert.equal(tabDropTarget(10, []), null);
});
