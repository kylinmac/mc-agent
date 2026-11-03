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

test("side and bottom placements pin the panel regardless of the window", () => {
  assert.equal(shouldStackWorkPanel({ ...base, containerWidth: 500, containerHeight: 1600, placement: "side" }), false);
  assert.equal(shouldStackWorkPanel({ ...base, containerWidth: 2400, placement: "bottom" }), true);
});

test("a wider conversation threshold moves the panel down sooner", () => {
  const collapsed = { ...base, sidebarCollapsed: true };
  assert.equal(shouldStackWorkPanel({ ...collapsed, containerWidth: 843, chatMinWidth: 600 }), true);
  assert.equal(shouldStackWorkPanel({ ...collapsed, containerWidth: 844, chatMinWidth: 600 }), false);
  // A threshold below MainChat's own floor cannot make room the panel does not have.
  assert.equal(shouldStackWorkPanel({ ...collapsed, containerWidth: 693, chatMinWidth: 300 }), true);
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
  assert.match(shell, /placement,\s*chatMinWidth: stackChatWidth/);
  const split = readFileSync(new URL("../src/features/split-view/SplitColumns.tsx", import.meta.url), "utf8");
  assert.match(split, /readWorkPanelDockShare/, "split and stacked layouts share one saved height");
});

test("the settings normalize unknown placements and out-of-range widths", async () => {
  const shared = await import("../../../packages/shared/src/work-panel-placement.ts");
  assert.equal(shared.resolveWorkPanelPlacement(undefined), "auto");
  assert.equal(shared.resolveWorkPanelPlacement("top"), "auto");
  assert.equal(shared.resolveWorkPanelPlacement("bottom"), "bottom");
  assert.equal(shared.resolveWorkPanelStackChatWidth(undefined), 450);
  assert.equal(shared.resolveWorkPanelStackChatWidth(100), 450);
  assert.equal(shared.resolveWorkPanelStackChatWidth(5000), 1200);
  assert.equal(shared.resolveWorkPanelStackChatWidth(612.4), 612);
});

test("the general settings page exposes the placement and threshold", () => {
  const page = readFileSync(new URL("../src/features/settings/SettingsPage.tsx", import.meta.url), "utf8");
  assert.match(page, /<WorkPanelPlacementRows settings=\{settings\} saveSettings=\{saveSettings\} \/>/);
  const rows = readFileSync(new URL("../src/features/settings/primitives.tsx", import.meta.url), "utf8");
  assert.match(rows, /disabled=\{placement !== "auto"\}/);
});
