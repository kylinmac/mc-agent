import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  MAIN_PANE_MIN_WIDTH,
  WORK_PANEL_MIN_WIDTH,
  WORK_PANEL_STACK_HYSTERESIS,
  clampWorkPanelDockShare,
  shouldStackWorkPanel,
} from "../src/lib/work-panel-resize.ts";

const base = { containerHeight: 800, sidebarWidth: 275, sidebarCollapsed: false, stacked: false };
const threshold = base.sidebarWidth + MAIN_PANE_MIN_WIDTH + WORK_PANEL_MIN_WIDTH;

test("a wide landscape window keeps the side layout", () => {
  assert.equal(shouldStackWorkPanel({ ...base, containerWidth: 1400 }), false);
});

test("a portrait window stacks the work panel", () => {
  assert.equal(shouldStackWorkPanel({ ...base, containerWidth: 1400, containerHeight: 1600 }), true);
});

test("a window that cannot fit the panel beside MainChat stacks it", () => {
  assert.equal(shouldStackWorkPanel({ ...base, containerWidth: threshold }), false);
  assert.equal(shouldStackWorkPanel({ ...base, containerWidth: threshold - 1 }), true);
});

test("a collapsed sidebar gives its width back to the side layout", () => {
  assert.equal(
    shouldStackWorkPanel({ ...base, containerWidth: threshold - 1, sidebarCollapsed: true }),
    false,
  );
});

test("returning to the side layout needs room beyond the threshold", () => {
  const stacked = { ...base, stacked: true };
  assert.equal(shouldStackWorkPanel({ ...stacked, containerWidth: threshold + 10 }), true);
  assert.equal(
    shouldStackWorkPanel({ ...stacked, containerWidth: threshold + WORK_PANEL_STACK_HYSTERESIS }),
    false,
  );
});

test("an unmeasured shell keeps the current layout", () => {
  assert.equal(shouldStackWorkPanel({ ...base, containerWidth: 0, stacked: true }), true);
  assert.equal(shouldStackWorkPanel({ ...base, containerWidth: 0 }), false);
});

test("the dock share stays within its bounds", () => {
  assert.equal(clampWorkPanelDockShare(0.05), 0.2);
  assert.equal(clampWorkPanelDockShare(0.95), 0.8);
  assert.equal(clampWorkPanelDockShare(0.5), 0.5);
});

test("the shell docks the panel under the conversation instead of at the right edge", () => {
  const shell = readFileSync(new URL("../src/features/app/AppShell.tsx", import.meta.url), "utf8");
  assert.match(shell, /stackedWorkPanel && workPanelOpen && activeSessionId \? <StackedWorkPanelDock \/>/);
  assert.match(shell, /!split && !stackedWorkPanel && \(presentedWorkPanelOpen \|\| workPanelExiting\)/);
  assert.match(shell, /!remoteActive && !workPanelMaximized/);
  const split = readFileSync(new URL("../src/features/split-view/SplitColumns.tsx", import.meta.url), "utf8");
  assert.match(split, /readWorkPanelDockShare/, "split and stacked layouts share one saved height");
});
