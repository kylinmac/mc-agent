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
  SECTION_IDS,
} from "../src/features/session-info/session-info-model.ts";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");
const [card, shell, ipc] = await Promise.all([
  read("../src/features/session-info/SessionInfo.tsx"),
  read("../src/features/app/AppShell.tsx"),
  read("../electron/main/ipc/project-resources-ipc.ts"),
]);

test("the session info panel lives in the conversation and gathers existing data", () => {
  assert.match(shell, /page === "chat" \? <SessionInfo \/> : null/);
  assert.match(card, /latestTurnContextInspector\(messages, providerModels, providers, compactions\)/);
  assert.match(card, /summarizeReviewChanges\(reviewChangesFromMessages\(messages\)\)/);
  assert.match(card, /api\s*\.sessionContextBreakdown\(activeSessionId\)/);
  assert.match(card, /api\s*\.getSessionCollaboration\(activeSessionId\)/);
  assert.match(card, /api\s*\.listMcpServers\(\)/);
  assert.match(ipc, /sidecar\.call\("agent\.contextBreakdown", \{ sessionId \}\)/);
});

test("one button opens and closes it, docked or floating", () => {
  // No close button and no outside-click close: the toggle is the only control.
  assert.doesNotMatch(card, /sessionInfoClose/);
  assert.doesNotMatch(card, /open: false \}\)\)/);
  assert.match(card, /open: !current\.open/);
  assert.equal(panelMode(PANEL_DEFAULT_WIDTH + 560), "docked");
  assert.equal(panelMode(PANEL_DEFAULT_WIDTH + 559), "overlay");
  // A wider panel needs a wider pane before it docks.
  assert.equal(panelMode(PANEL_DEFAULT_WIDTH + 560, 400), "overlay");
  // Docked, the conversation and the floating composer narrow by the width.
  assert.match(card, /pane\.style\.setProperty\("--mc-info-width"/);
  assert.match(card, /compactContext\(\)/);
});

test("layout preferences are repaired, reordered and bounded", () => {
  const prefs = normalizePrefs({ open: true, width: 9999, order: ["workers", "bogus", "workers"], hidden: ["nope", "changes"] });
  assert.equal(prefs.open, true);
  assert.equal(prefs.width, PANEL_MAX_WIDTH);
  assert.deepEqual(prefs.order, ["workers", ...SECTION_IDS.filter((id) => id !== "workers")]);
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
