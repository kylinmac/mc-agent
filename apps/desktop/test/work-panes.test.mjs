import assert from "node:assert/strict";
import test from "node:test";
import {
  groupPanes,
  movePane,
  normalizePanePrefs,
  paneActiveTab,
  paneDropTarget,
  paneFlexGrow,
  paneOf,
  resizePanePair,
  togglePaneCollapsed,
} from "../src/features/work-tools/work-panes-model.ts";

// mc-agent work-panel panes (MC-ADR-0005).

test("tabs group into one pane per tool", () => {
  assert.equal(paneOf({ id: "terminal:1", kind: "terminal", resource: "/p" }), "terminal");
  assert.equal(paneOf({ id: "plugin:pi.browser/browser#a", kind: "plugin", resource: "pi.browser/browser" }), "browser");
  assert.equal(paneOf({ id: "plugin:pi.file-manager/manager", kind: "plugin", resource: "pi.file-manager/manager" }), "files");
  assert.equal(paneOf({ id: "file:/a.md", kind: "file", resource: "/a.md" }), "files");
  assert.equal(paneOf({ id: "review", kind: "review" }), "review");
  assert.equal(paneOf({ id: "subagent:d1", kind: "subagent", resource: "d1" }), "other");
  assert.equal(paneOf({ id: "plugin:x.y/v", kind: "plugin", resource: "x.y/v" }), "other");
});

test("only panes with tabs appear, in the user's order", () => {
  const tabs = [
    { id: "t1", kind: "terminal" },
    { id: "r", kind: "review" },
    { id: "t2", kind: "terminal" },
  ];
  const panes = groupPanes(tabs, ["review", "browser", "terminal", "files", "other"]);
  assert.deepEqual(panes.map((pane) => pane.id), ["review", "terminal"]);
  assert.deepEqual(panes[1].tabs.map((tab) => tab.id), ["t1", "t2"]);
});

test("a pane shows the tab last selected in it, else its newest", () => {
  const tabs = [{ id: "a", kind: "terminal" }, { id: "b", kind: "terminal" }];
  assert.equal(paneActiveTab(tabs, "a")?.id, "a");
  assert.equal(paneActiveTab(tabs, "gone")?.id, "b");
  assert.equal(paneActiveTab([], "a"), undefined);
});

test("stored layout is normalized", () => {
  const prefs = normalizePanePrefs({ order: ["files", "nope", "files"], collapsed: ["review", 3], sizes: { files: 900, bad: 1 } });
  assert.deepEqual(prefs.order, ["files", "terminal", "browser", "review", "other"]);
  assert.deepEqual(prefs.collapsed, ["review"]);
  assert.deepEqual(prefs.sizes, { files: 20 });
  assert.deepEqual(normalizePanePrefs("junk").order, ["terminal", "browser", "files", "review", "other"]);
});

test("panes move, collapse and drop by pointer position", () => {
  assert.deepEqual(movePane(["terminal", "browser", "files"], "files", "terminal", false), ["files", "terminal", "browser"]);
  assert.deepEqual(movePane(["terminal", "browser", "files"], "terminal", "files", true), ["browser", "files", "terminal"]);
  assert.deepEqual(togglePaneCollapsed(["review"], "review"), []);
  assert.deepEqual(togglePaneCollapsed([], "files"), ["files"]);
  const rects = [{ id: "terminal", top: 0, bottom: 100 }, { id: "files", top: 104, bottom: 300 }];
  assert.deepEqual(paneDropTarget(20, rects), { id: "terminal", after: false });
  assert.deepEqual(paneDropTarget(250, rects), { id: "files", after: true });
  assert.deepEqual(paneDropTarget(900, rects), { id: "files", after: true });
});

test("the divider trades height between two panes within limits", () => {
  const pair = { weightA: 1, weightB: 1, heightA: 300, heightB: 300 };
  const down = resizePanePair(pair, 100);
  assert.ok(Math.abs(down.weightA - 4 / 3) < 1e-9);
  assert.ok(Math.abs(down.weightA + down.weightB - 2) < 1e-9);
  // Never below the minimum pane height.
  const far = resizePanePair(pair, 1000);
  assert.ok(Math.abs(far.weightA - (2 * 504) / 600) < 1e-9);
});

test("open panes always fill the panel, whatever weights were stored", () => {
  // A pane left alone with a small stored weight must not leave empty space.
  assert.deepEqual(paneFlexGrow(["browser"], { browser: 0.3 }), { browser: 1 });
  const grows = paneFlexGrow(["browser", "files"], { browser: 3, files: 1 });
  assert.equal(grows.browser, 1.5);
  assert.equal(grows.files, 0.5);
  assert.deepEqual(paneFlexGrow([], {}), {});
});
