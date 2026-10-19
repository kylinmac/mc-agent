import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  breakdownRows,
  clampPanelWidth,
  normalizePrefs,
  panelMode,
  PANEL_DEFAULT_WIDTH,
  PANEL_MAX_WIDTH,
  PANEL_MIN_WIDTH,
  reorderSections,
  SECTION_IDS, conversationOffset, DOCK_GAP } from "../src/features/session-info/session-info-model.ts";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");
const [card, shell, ipc] = await Promise.all([
  read("../src/features/session-info/SessionInfo.tsx"),
  read("../src/features/app/AppShell.tsx"),
  read("../electron/main/ipc/project-resources-ipc.ts"),
]);

test("the session info panel lives in the conversation and gathers existing data", () => {
  assert.match(shell, /page === "chat" && !split \? <SessionInfo \/> : null/);
  assert.match(card, /latestTurnContextInspector\(messages, providerModels, providers, compactions\)/);
  assert.match(card, /summarizeReviewChanges\(reviewChangesFromMessages\(messages\)\)/);
  assert.match(card, /api\s*\.sessionContextBreakdown\(sessionId\)/);
  assert.match(card, /api\s*\.getSessionCollaboration\(sessionId\)/);
  assert.match(card, /api\s*\.listMcpServers\(\)/);
  assert.match(ipc, /sidecar\.call\("agent\.contextBreakdown", \{ sessionId \}\)/);
});

test("one button opens and closes it, docked or floating", () => {
  // No close button and no outside-click close: the toggle is the only control.
  assert.doesNotMatch(card, /sessionInfoClose/);
  assert.doesNotMatch(card, /open: false \}\)\)/);
  // Open or closed per conversation (MC-ADR-0007).
  assert.match(card, /setOpen\(!open\)/);
  assert.equal(panelMode(PANEL_DEFAULT_WIDTH + 560), "docked");
  assert.equal(panelMode(PANEL_DEFAULT_WIDTH + 559), "overlay");
  // A wider panel needs a wider pane before it docks.
  assert.equal(panelMode(PANEL_DEFAULT_WIDTH + 560, 400), "overlay");
  // Docked, the conversation and the floating composer move aside only by
  // what the panel overlaps.
  assert.match(card, /pane\.style\.setProperty\("--mc-info-offset"/);
  assert.match(card, /compactContext\(\)/);
});

test("layout preferences are repaired, reordered and bounded", () => {
  const prefs = normalizePrefs({ open: true, width: 9999, order: ["workers", "bogus", "workers"], hidden: ["nope", "changes"] });
  assert.equal(prefs.open, true);
  assert.equal(prefs.width, PANEL_MAX_WIDTH);
  // Missing sections return to their default place relative to the others.
  assert.deepEqual(prefs.order, ["environment", "context", "changes", "workers", "background", "connectors"]);
  // A section added later (background) lands after the one it follows by
  // default, keeping the user's own order for the rest.
  assert.deepEqual(
    normalizePrefs({ order: ["connectors", "workers", "environment", "context", "changes"] }).order,
    ["connectors", "workers", "background", "environment", "context", "changes"],
  );
  assert.deepEqual(prefs.hidden, ["changes"]);
  assert.equal(normalizePrefs(null).open, false);
  assert.equal(clampPanelWidth(10), PANEL_MIN_WIDTH);
  const order = ["environment", "context", "changes", "workers", "connectors"];
  assert.deepEqual(reorderSections(order, "environment", "changes"), ["context", "changes", "environment", "workers", "connectors"]);
  assert.deepEqual(reorderSections(order, "connectors", "context"), ["environment", "connectors", "context", "changes", "workers"]);
});

test("context rows are shares of the window with buffer and free space", () => {
  const rows = breakdownRows({
    contextWindow: 1000,
    autoCompactAt: 900,
    categories: { systemPrompt: 50, projectInstructions: 10, memory: 0, skills: 20, tools: 40, mcpTools: 30, messages: 150 },
    usedTokens: 300,
    toolCount: 5,
    mcpToolCount: 2,
    skillCount: 3,
    messageCount: 12,
    toolNames: [],
    mcpToolNames: [],
    skillNames: [],
  });
  const byKey = Object.fromEntries(rows.map((row) => [row.key, row]));
  assert.equal(byKey.messages.percent, 15);
  assert.equal(byKey.messages.count, 12);
  assert.equal(byKey.mcpTools.count, 2);
  assert.equal(byKey.buffer.tokens, 100);
  assert.equal(byKey.free.tokens, 600);
  assert.equal(rows.at(-1).key, "free");
});

test("the docked panel sits in the margin and moves the conversation only by its overlap", () => {
  // Wide pane: the margin already fits the panel, nothing moves.
  assert.equal(conversationOffset(1800, 300, 760), 0);
  // The margin is short by some amount: the band moves right just enough,
  // keeping its width (its left edge lands panel + gap from the pane edge).
  const offset = conversationOffset(1107, 285, 760);
  assert.equal(offset, 255);
  assert.equal((1107 + offset - 760) / 2, 285 + DOCK_GAP);
  // Narrow pane: never more than the panel's own width plus the gap.
  assert.equal(conversationOffset(900, 300, 760), 300 + DOCK_GAP);
});
