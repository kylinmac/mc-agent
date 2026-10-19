import assert from "node:assert/strict";
import test from "node:test";
import { MAX_TABS, closeTab, openTab, pruneTabs } from "../src/features/session-tabs/tab-list.ts";

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
  assert.equal(activeTabKey("settings", "s1"), "page:settings");
  assert.equal(activeTabKey("chat", "s1"), "s1");
  assert.equal(activeTabKey("chat", null), null);
  assert.equal(activeTabKey("projects", "s1"), null);
  assert.equal(tabPage(pageTabKey("plugins")), "plugins");
  assert.equal(tabPage("page:unknown"), null);
  assert.equal(tabPage("s1"), null);
  assert.deepEqual(pruneTabs(["page:settings", "gone", "s1"], new Set(["s1"])), ["page:settings", "s1"]);
});
