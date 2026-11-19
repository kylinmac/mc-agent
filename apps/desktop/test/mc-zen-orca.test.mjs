import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { register } from "node:module";
import test from "node:test";
import { IPC } from "@pi-desktop/shared";
import {
  DEFAULT_ATTENTION_LIMIT,
  buildAttentionItems,
  isSessionVisibleOnScreen,
  normalizeAttentionProjectPath,
  reconcileUnreadCompleted,
  stepAttentionTrackerState,
  visibleAttentionSlice,
} from "../src/features/attention-feed/attention-model.ts";
import {
  annotationLineKey,
  countReviewedFiles,
  executeBatchAnnotationSend,
  formatDiffAnnotationsPrompt,
  isReviewFileViewed,
  pruneAnnotationsForExistingSessions,
  pruneSentAnnotations,
  removeAnnotationItem,
  resolveAnnotationRootIdentity,
  resolveDiffShiftRangeTarget,
  restoreSentAnnotations,
  reviewFileSignature,
  toggleReviewFileViewedMap,
  upsertAnnotationItem,
} from "../src/features/review-annotations/review-annotations-model.ts";
import { resolveComposerSmartStop } from "../src/lib/composer-smart-stop.ts";
import { numberedReviewHunks, reviewLineNumber } from "../src/lib/review-history.ts";
import { PAGE_TABS, activeTabKey, loadTabs, openTab } from "../src/features/session-tabs/tab-list.ts";

test("R35: creative studio UI is retired while legacy page:creative tabs migrate cleanly", () => {
  assert.deepEqual(PAGE_TABS, []);
  assert.equal(activeTabKey("creative", "s1"), null);
  assert.deepEqual(openTab(["s1"], "page:creative"), ["s1"]);

  let saved = JSON.stringify(["page:creative", "s1", "s2"]);
  const prevWindow = globalThis.window;
  globalThis.window = {
    localStorage: {
      getItem: () => saved,
      setItem: (_key, value) => {
        saved = value;
      },
    },
  };
  try {
    assert.deepEqual(loadTabs(), ["s1", "s2"]);
    assert.deepEqual(JSON.parse(saved), ["s1", "s2"]);
  } finally {
    if (prevWindow === undefined) delete globalThis.window;
    else globalThis.window = prevWindow;
  }

  const appShell = readFileSync(new URL("../src/features/app/AppShell.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(appShell, /<AppRail\b/);
  assert.doesNotMatch(appShell, /CreativePage/);
});

test("R36: Zen 2-column shell keeps adaptive left-margin SessionInfo and wraps narrow 240px SidebarFooter", () => {
  const appShell = readFileSync(new URL("../src/features/app/AppShell.tsx", import.meta.url), "utf8");
  const sidebar = readFileSync(new URL("../src/components/Sidebar.tsx", import.meta.url), "utf8");
  const splitCols = readFileSync(new URL("../src/features/split-view/SplitColumns.tsx", import.meta.url), "utf8");
  const infoCss = readFileSync(new URL("../src/styles/mc-session-info.css", import.meta.url), "utf8");
  const railCss = readFileSync(new URL("../src/styles/app-rail.css", import.meta.url), "utf8");

  assert.doesNotMatch(appShell, /<AppRail\b/);
  assert.match(sidebar, /<SidebarFooter \/>/);
  assert.match(appShell, /page === "chat" && !split \? <SessionInfo \/> : null/);
  assert.match(appShell, /<AttentionFeedWatcher chatSurfaceVisible=\{!workPanelMaximized && page === "chat"\} \/>/);
  assert.match(splitCols, /<SessionInfo sessionId=\{id\} scope="column" \/>/);
  assert.match(infoCss, /overscroll-behavior:\s*contain/);
  assert.match(infoCss, /scrollbar-gutter:\s*stable/);

  const footerBlock = railCss.match(/\.mc-sidebar-footer\s*\{[^}]+\}/)?.[0] ?? "";
  assert.match(footerBlock, /flex-wrap:\s*wrap/);
  assert.match(railCss, /\.mc-sidebar-footer\s+\.footer-action\s*\{\s*flex:\s*0 0 32px;/);
});

test("R36: Settings and slot pages pin the left navigation sidebar, hiding collapse triggers and ignoring shortcuts", async () => {
  const { pagePinsSidebar } = await import("../src/features/sidebar-slot/sidebar-slot-model.ts");
  const runtimeSource = readFileSync(new URL("../src/features/app/useAppShellRuntime.tsx", import.meta.url), "utf8");
  const sidebar = readFileSync(new URL("../src/components/Sidebar.tsx", import.meta.url), "utf8");
  const winTitlebar = readFileSync(new URL("../src/features/app-rail/WindowsTitlebarActions.tsx", import.meta.url), "utf8");

  assert.equal(pagePinsSidebar("settings"), true);
  assert.equal(pagePinsSidebar("plugins"), true);
  assert.equal(pagePinsSidebar("scheduled"), true);
  assert.equal(pagePinsSidebar("chat"), false);
  assert.equal(pagePinsSidebar(undefined), false);

  assert.match(runtimeSource, /const toggleSidebar = useCallback\(\(\) => \{\s*if \(pagePinsSidebar\(useAppStore\.getState\(\)\.page\)\) return;/);
  assert.match(runtimeSource, /const handleSidebarResizeCollapse = useCallback\(\(\) => \{\s*if \(pagePinsSidebar\(useAppStore\.getState\(\)\.page\)\) return;/);
  assert.match(runtimeSource, /sidebarCollapsed:\s*sidebarPinned \? false : sidebarCollapsed/);
  assert.match(sidebar, /\{sidebarPinned \? null : \(\s*<TooltipButton[\s\S]*?data-nav="toggle-sidebar"/);
  assert.match(winTitlebar, /\{pagePinsSidebar\(page\) \? null : \(\s*<TooltipButton[\s\S]*?data-nav="toggle-sidebar"/);

  const mcChatCss = readFileSync(new URL("../src/styles/mc-chat.css", import.meta.url), "utf8");
  assert.match(mcChatCss, /\.subagent-topology-agents::before\s*\{\s*content:\s*none;/);
  assert.match(mcChatCss, /\.subagent-topology-node::before\s*\{[\s\S]*?top:\s*calc\(50% - 1px\);/);
  assert.match(mcChatCss, /\.subagent-topology-node:last-child:not\(:only-child\)::after\s*\{[\s\S]*?bottom:\s*calc\(50% - 1px\);/);
  assert.match(mcChatCss, /@container subagent-activity \(max-width: 520px\)[\s\S]*?margin-left:\s*24px;[\s\S]*?padding-left:\s*38px;/);
});

test("P1: ReviewChangeCard scopes annotations to pane SlotSessionProvider rather than global activeSessionId", () => {
  const cardSource = readFileSync(new URL("../src/components/ReviewChangeCard.tsx", import.meta.url), "utf8");
  const subagentSource = readFileSync(
    new URL("../src/components/workpanel/SubagentTranscriptTab.tsx", import.meta.url),
    "utf8",
  );

  const reviewTabSource = readFileSync(
    new URL("../src/components/workpanel/ReviewTab.tsx", import.meta.url),
    "utf8",
  );

  assert.match(cardSource, /const slotSessionId = useSlotSessionId\(\);/);
  assert.match(
    cardSource,
    /const targetSessionId = annotationSessionId \|\| sessionId \|\| slotSessionId \|\| activeSessionId;/,
  );
  // LegacyReviewTab (used by remote workspaces / pi-native) passes annotationSessionId, never sessionId.
  assert.match(reviewTabSource, /annotationSessionId=\{activeSessionId \?\? undefined\}/);
  assert.doesNotMatch(reviewTabSource, /<ReviewChangeCard[\s\S]*?\bsessionId=/);
  assert.match(subagentSource, /annotatable=\{false\}/);
});

test("P2: Changing diff context lines preserves line-anchored annotations without overwriting neighbours", () => {
  const hunksContext3 = numberedReviewHunks([
    {
      header: "@@ -8,5 +8,6 @@",
      lines: [
        { type: "context", text: "const a = 8;" }, // L8
        { type: "context", text: "const b = 9;" }, // L9
        { type: "add", text: "const c = 10;" }, // L10
        { type: "context", text: "const d = 11;" }, // L11
        { type: "context", text: "const e = 12;" }, // L12
      ],
    },
  ]);
  const hunksContext1 = numberedReviewHunks([
    {
      header: "@@ -9,3 +9,4 @@",
      lines: [
        { type: "context", text: "const b = 9;" }, // L9
        { type: "add", text: "const c = 10;" }, // L10
        { type: "context", text: "const d = 11;" }, // L11
      ],
    },
  ]);
  const hunksShifted = numberedReviewHunks([
    {
      header: "@@ -10,1 +10,2 @@",
      lines: [
        { type: "add", text: "const c = 10;" }, // L10 at lineIndex 0!
        { type: "context", text: "const d = 11;" }, // L11 at lineIndex 1!
      ],
    },
  ]);

  // 1. Annotate L9 in 3-line context (hunk 0, lineIndex 1).
  const line9In3 = hunksContext3[0].lines[1];
  assert.equal(reviewLineNumber(line9In3), 9);
  const keyL9 = annotationLineKey("snap-ctx", "new", reviewLineNumber(line9In3), 0, 1);

  // 2. Switch to 1-line / shifted context and annotate L10 (even when L10 sits at lineIndex 1 or 0).
  const line10In1 = hunksContext1[0].lines[1];
  const line10Shifted = hunksShifted[0].lines[0];
  assert.equal(reviewLineNumber(line10In1), 10);
  assert.equal(reviewLineNumber(line10Shifted), 10);
  const keyL10From1 = annotationLineKey("snap-ctx", "new", reviewLineNumber(line10In1), 0, 1);
  const keyL10FromShifted = annotationLineKey("snap-ctx", "new", reviewLineNumber(line10Shifted), 0, 0);

  assert.equal(keyL9, "snap-ctx:new:9");
  assert.equal(keyL10From1, "snap-ctx:new:10");
  assert.equal(keyL10FromShifted, "snap-ctx:new:10");
  assert.notEqual(keyL9, keyL10From1);

  let notes = [];
  notes = upsertAnnotationItem(notes, {
    id: "note-9",
    lineKey: keyL9,
    sessionId: "s1",
    snapshotId: "snap-ctx",
    path: "src/index.ts",
    side: "new",
    line: 9,
    lineType: "context",
    code: line9In3.text,
    note: "Keep L9 constant const",
  });
  notes = upsertAnnotationItem(notes, {
    id: "note-10",
    lineKey: keyL10From1,
    sessionId: "s1",
    snapshotId: "snap-ctx",
    path: "src/index.ts",
    side: "new",
    line: 10,
    lineType: "add",
    code: line10In1.text,
    note: "Rename c on L10",
  });

  assert.equal(notes.length, 2);
  assert.deepEqual(
    notes.map((n) => ({ line: n.line, note: n.note })),
    [
      { line: 9, note: "Keep L9 constant const" },
      { line: 10, note: "Rename c on L10" },
    ],
  );
});

test("P2: Async batch send preserves notes added or edited in flight and retains batch on send failure", async () => {
  const bySession = { "s-race": [] };
  const upsert = (item) => {
    bySession[item.sessionId] = upsertAnnotationItem(bySession[item.sessionId] ?? [], item);
  };
  const pruneSent = (id, sentBatch) => {
    bySession[id] = pruneSentAnnotations(bySession[id] ?? [], sentBatch);
  };

  upsert({
    id: "keep-unchanged",
    lineKey: "snap:new:1",
    sessionId: "s-race",
    snapshotId: "snap",
    path: "src/a.ts",
    side: "new",
    line: 1,
    lineType: "add",
    code: "const a = 1;",
    note: "Original note 1",
  });
  upsert({
    id: "will-edit",
    lineKey: "snap:new:2",
    sessionId: "s-race",
    snapshotId: "snap",
    path: "src/a.ts",
    side: "new",
    line: 2,
    lineType: "add",
    code: "const b = 2;",
    note: "Original note 2",
  });

  // 1. Failed send (returning false or throwing) keeps the entire batch intact.
  const failed = await executeBatchAnnotationSend({
    sessionId: "s-race",
    intro: "Intro:",
    getSessionItems: (id) => bySession[id] ?? [],
    pruneSent,
    isBusy: () => false,
    sendPrompt: async () => false,
    enqueuePrompt: async () => false,
  });
  assert.equal(failed.sent, false);
  assert.equal(bySession["s-race"].length, 2);

  const rejected = await executeBatchAnnotationSend({
    sessionId: "s-race",
    intro: "Intro:",
    getSessionItems: (id) => bySession[id] ?? [],
    pruneSent,
    isBusy: () => false,
    sendPrompt: async () => {
      throw new Error("IPC failed");
    },
    enqueuePrompt: async () => false,
  });
  assert.equal(rejected.sent, false);
  assert.equal(bySession["s-race"].length, 2);

  // 2. Delayed successful send: mutate one note and add a new one while in flight.
  let resolveSend;
  const sentPrompts = [];
  const inflight = executeBatchAnnotationSend({
    sessionId: "s-race",
    intro: "Intro:",
    getSessionItems: (id) => bySession[id] ?? [],
    pruneSent,
    isBusy: () => false,
    sendPrompt: (prompt) =>
      new Promise((resolve) => {
        sentPrompts.push(prompt);
        resolveSend = resolve;
      }),
    enqueuePrompt: async () => false,
  });

  // While send is awaiting confirmation:
  upsert({
    id: "will-edit",
    lineKey: "snap:new:2",
    sessionId: "s-race",
    snapshotId: "snap",
    path: "src/a.ts",
    side: "new",
    line: 2,
    lineType: "add",
    code: "const b = 2;",
    note: "Edited while sending!",
  });
  upsert({
    id: "added-inflight",
    lineKey: "snap:new:3",
    sessionId: "s-race",
    snapshotId: "snap",
    path: "src/a.ts",
    side: "new",
    line: 3,
    lineType: "add",
    code: "const c = 3;",
    note: "Added while sending!",
  });

  resolveSend(true);
  const ok = await inflight;
  assert.equal(ok.sent, true);
  assert.equal(ok.count, 2);
  assert.equal(sentPrompts.length, 1);
  assert.match(sentPrompts[0], /Original note 1/);
  assert.match(sentPrompts[0], /Original note 2/);

  assert.deepEqual(
    bySession["s-race"].map((item) => ({ id: item.id, note: item.note })),
    [
      { id: "will-edit", note: "Edited while sending!" },
      { id: "added-inflight", note: "Added while sending!" },
    ],
  );
});

test("P2: Annotations on same relative path across main and delegated worktrees stay separated", () => {
  let list = [];
  list = upsertAnnotationItem(list, {
    id: "wt-main",
    lineKey: annotationLineKey("snap-main", "new", 12),
    sessionId: "s1",
    snapshotId: "snap-main",
    path: "src/a.ts",
    root: "/repo/main",
    rootIdentity: resolveAnnotationRootIdentity("/repo/main", undefined),
    side: "new",
    line: 12,
    lineType: "add",
    code: "export const source = 'main';",
    note: "Main worktree fix.",
  });
  list = upsertAnnotationItem(list, {
    id: "wt-sub",
    lineKey: annotationLineKey("snap-sub", "new", 12),
    sessionId: "s1",
    snapshotId: "snap-sub",
    path: "src/a.ts",
    root: "/repo/.worktrees/worker-1",
    rootIdentity: resolveAnnotationRootIdentity("/repo/.worktrees/worker-1", "call_1"),
    side: "new",
    line: 12,
    lineType: "add",
    code: "export const source = 'worker';",
    note: "Delegated worktree fix.",
  });
  list = upsertAnnotationItem(list, {
    id: "wt-legacy",
    lineKey: annotationLineKey("snap-leg", "old", 5),
    sessionId: "s1",
    snapshotId: "snap-leg",
    path: "src/a.ts",
    rootIdentity: resolveAnnotationRootIdentity(undefined, "call_legacy"),
    side: "old",
    line: 5,
    lineType: "del",
    code: "legacyCall();",
    note: "Legacy delegate fix.",
  });

  const prompt = formatDiffAnnotationsPrompt("请按以下逐行代码审查批注一并修改：", list);
  assert.match(prompt, /### `src\/a\.ts` \(`\/repo\/main`\)\n- \*\*L12\*\* \(`\+\s*export const source = 'main';`\): Main worktree fix\./);
  assert.match(prompt, /### `src\/a\.ts` \(`\/repo\/\.worktrees\/worker-1`\)\n- \*\*L12\*\* \(`\+\s*export const source = 'worker';`\): Delegated worktree fix\./);
  assert.match(prompt, /### `src\/a\.ts` \(`delegated:call_legacy`\)\n- \*\*old L5\*\* \(`-legacyCall\(\);`\): Legacy delegate fix\./);

  const afterRemove = removeAnnotationItem(list, "wt-legacy");
  assert.equal(afterRemove.length, 2);
});

test("R37 & P2: Persistent attention tracker records completions while sidebar is collapsed, respects maximized work panel, and filters non-success endings", () => {
  const known = new Set(["A", "B", "fail-sess", "abort-sess", "compact-sess"]);

  // 1. Visibility rules: maximized work panel (`chatSurfaceVisible: false`) occludes chat!
  assert.equal(
    isSessionVisibleOnScreen("A", {
      page: "chat",
      chatSurfaceVisible: false,
      activeSessionId: "A",
      splitColumns: [],
    }),
    false,
  );
  assert.equal(
    isSessionVisibleOnScreen("B", {
      page: "chat",
      chatSurfaceVisible: true,
      activeSessionId: "A",
      splitColumns: ["A", "B"],
    }),
    true,
  );

  // 2. B starts running while sidebar is collapsed; persistent shell tracker still records it.
  let tracker = { unreadCompleted: {}, prevRunning: {} };
  tracker = stepAttentionTrackerState(tracker, {
    liveRunning: { B: true },
    visible: { page: "chat", chatSurfaceVisible: true, activeSessionId: "A", splitColumns: [] },
    existingSessionIds: known,
    latestTurnResults: {},
    now: 1000,
  });
  // B finishes while sidebar is still collapsed -> recorded in persistent state!
  tracker = stepAttentionTrackerState(tracker, {
    liveRunning: {},
    visible: { page: "chat", chatSurfaceVisible: true, activeSessionId: "A", splitColumns: [] },
    existingSessionIds: known,
    latestTurnResults: { B: { status: "completed" } },
    now: 2000,
  });
  assert.deepEqual(tracker.unreadCompleted, { B: 2000 });

  // 3. User switches activeSessionId to B while workPanelMaximized (`chatSurfaceVisible: false`):
  //    B is still occluded, so unread badge MUST remain!
  tracker = stepAttentionTrackerState(tracker, {
    liveRunning: {},
    visible: { page: "chat", chatSurfaceVisible: false, activeSessionId: "B", splitColumns: [] },
    existingSessionIds: known,
    latestTurnResults: { B: { status: "completed" } },
    now: 2500,
  });
  assert.deepEqual(tracker.unreadCompleted, { B: 2000 });

  // 4. Un-maximizing work panel (`chatSurfaceVisible: true`) reveals B and auto-clears unread!
  tracker = stepAttentionTrackerState(tracker, {
    liveRunning: {},
    visible: { page: "chat", chatSurfaceVisible: true, activeSessionId: "B", splitColumns: [] },
    existingSessionIds: known,
    latestTurnResults: { B: { status: "completed" } },
    now: 3000,
  });
  assert.deepEqual(tracker.unreadCompleted, {});

  // 5. Outcome filtering: normal completion vs model error vs user abort vs manual compaction.
  const filteredUnread = reconcileUnreadCompleted({
    prevRunning: {
      B: true,
      "fail-sess": true,
      "abort-sess": true,
      "compact-sess": true,
    },
    nextRunning: {},
    currentUnread: {},
    visible: { page: "chat", chatSurfaceVisible: true, activeSessionId: "A", splitColumns: [] },
    existingSessionIds: known,
    latestTurnResults: {
      B: { status: "completed" },
      "fail-sess": { status: "failed" },
      // abort-sess (`TURN_ABORTED`) and compact-sess (`compaction_end` manual) leave latestTurnResults undefined
    },
    sessionOutcomes: {
      "fail-sess": "failed",
    },
    now: 4000,
  });
  assert.deepEqual(filteredUnread, { B: 4000 });

  // Priority ordering: needs_action > running > completed
  const items = buildAttentionItems({
    sessions: [
      { id: "B", title: "Build release", projectPath: "/work/mc-agent", updatedAt: 500 },
      { id: "A", title: "Benchmark", projectPath: "/work/vpn", updatedAt: 800 },
      { id: "fail-sess", title: "", projectPath: "/work/doris", updatedAt: 300 },
    ],
    runningSessions: { A: true, "fail-sess": true },
    activeSessionId: "A",
    isRunning: true,
    pendingPermissions: { "fail-sess": [{ id: "p1" }] },
    pendingAsks: {},
    unreadCompleted: filteredUnread,
    projectMeta: { "/work/doris": { name: "Doris DB" } },
    untitledLabel: "Untitled task",
  });
  assert.deepEqual(
    items.map((item) => ({ id: item.sessionId, kind: item.kind })),
    [
      { id: "fail-sess", kind: "needs_action" },
      { id: "A", kind: "running" },
      { id: "B", kind: "completed" },
    ],
  );
});

test("Round-2 P2: Per-session send lock prevents double-send across session switches and blocks while plan approval is pending", async () => {
  const bySession = {
    sA: [
      {
        id: "n1",
        lineKey: "snap:new:1",
        sessionId: "sA",
        snapshotId: "snap",
        path: "src/a.ts",
        side: "new",
        line: 1,
        lineType: "add",
        code: "const x = 1;",
        note: "Fix x",
        createdAt: 1,
      },
    ],
    sB: [
      {
        id: "n2",
        lineKey: "snap:new:2",
        sessionId: "sB",
        snapshotId: "snap",
        path: "src/b.ts",
        side: "new",
        line: 2,
        lineType: "add",
        code: "const y = 2;",
        note: "Fix y",
        createdAt: 2,
      },
    ],
  };
  const sendingMap = {};
  let planPendingForA = true;
  let sendCallsA = 0;
  let sendCallsB = 0;
  let resolveA;

  // 1. Plan awaiting approval blocks send with explicit reason and preserves batch.
  const blockedPlan = await executeBatchAnnotationSend({
    sessionId: "sA",
    intro: "Intro:",
    getSessionItems: (id) => bySession[id] ?? [],
    pruneSent: (id, batch) => {
      bySession[id] = pruneSentAnnotations(bySession[id] ?? [], batch);
    },
    isSending: (id) => Boolean(sendingMap[id]),
    setSending: (id, v) => {
      sendingMap[id] = v;
    },
    isPlanPending: (id) => id === "sA" && planPendingForA,
    isBusy: () => false,
    sendPrompt: async () => true,
    enqueuePrompt: async () => true,
  });
  assert.equal(blockedPlan.sent, false);
  assert.equal(blockedPlan.blockedReason, "plan_pending");
  assert.equal(bySession.sA.length, 1);

  // 2. Start sending sA, switch to sB (sB can send freely), switch back to sA and click again -> rejected!
  planPendingForA = false;
  const inflightA = executeBatchAnnotationSend({
    sessionId: "sA",
    intro: "Intro:",
    getSessionItems: (id) => bySession[id] ?? [],
    pruneSent: (id, batch) => {
      bySession[id] = pruneSentAnnotations(bySession[id] ?? [], batch);
    },
    isSending: (id) => Boolean(sendingMap[id]),
    setSending: (id, v) => {
      sendingMap[id] = v;
    },
    isBusy: () => false,
    sendPrompt: () =>
      new Promise((resolve) => {
        sendCallsA += 1;
        resolveA = resolve;
      }),
    enqueuePrompt: async () => true,
  });
  assert.equal(sendingMap.sA, true);

  // Duplicate attempt on sA after switching back while still in flight:
  const duplicateA = await executeBatchAnnotationSend({
    sessionId: "sA",
    intro: "Intro:",
    getSessionItems: (id) => bySession[id] ?? [],
    pruneSent: (id, batch) => {
      bySession[id] = pruneSentAnnotations(bySession[id] ?? [], batch);
    },
    isSending: (id) => Boolean(sendingMap[id]),
    setSending: (id, v) => {
      sendingMap[id] = v;
    },
    isBusy: () => false,
    sendPrompt: async () => {
      sendCallsA += 1;
      return true;
    },
    enqueuePrompt: async () => true,
  });
  assert.equal(duplicateA.sent, false);
  assert.equal(duplicateA.blockedReason, "sending");
  assert.equal(sendCallsA, 1);

  // Meanwhile sB is unaffected by sA's lock:
  const sentB = await executeBatchAnnotationSend({
    sessionId: "sB",
    intro: "Intro:",
    getSessionItems: (id) => bySession[id] ?? [],
    pruneSent: (id, batch) => {
      bySession[id] = pruneSentAnnotations(bySession[id] ?? [], batch);
    },
    isSending: (id) => Boolean(sendingMap[id]),
    setSending: (id, v) => {
      sendingMap[id] = v;
    },
    isBusy: () => false,
    sendPrompt: async () => {
      sendCallsB += 1;
      return true;
    },
    enqueuePrompt: async () => true,
  });
  assert.equal(sentB.sent, true);
  assert.equal(sendCallsB, 1);

  resolveA(true);
  const finishedA = await inflightA;
  assert.equal(finishedA.sent, true);
  assert.equal(sendingMap.sA, false);
  assert.equal(bySession.sA.length, 0);
});

test("Round-2 P2: Reload hydration from unread notifications, minimized window visibility, and 7+ item true count & expand", () => {
  const known = new Set(["s1", "s2", "s3", "s4", "s5", "s6", "s7"]);

  // 1. Window reload hydration:
  //    - s2 completed during reload (unread task.completed) -> hydrated!
  //    - s3 already read -> NOT hydrated!
  //    - s4 had older unread task.completed but latest is task.failed -> NOT hydrated!
  let tracker = { unreadCompleted: {}, prevRunning: {}, seenNotificationIds: new Set() };
  const bootNotifications = [
    { id: "n-s2", kind: "task.completed", sessionId: "s2", createdAt: "2026-11-18T03:00:00Z", readAt: null },
    { id: "n-s3-read", kind: "task.completed", sessionId: "s3", createdAt: "2026-11-18T02:00:00Z", readAt: "2026-11-18T02:05:00Z" },
    { id: "n-s4-fail", kind: "task.failed", sessionId: "s4", createdAt: "2026-11-18T03:10:00Z", readAt: null },
    { id: "n-s4-old-ok", kind: "task.completed", sessionId: "s4", createdAt: "2026-11-18T01:00:00Z", readAt: null },
  ];
  tracker = stepAttentionTrackerState(tracker, {
    liveRunning: {},
    visible: { page: "chat", chatSurfaceVisible: true, activeSessionId: "s1", splitColumns: [] },
    existingSessionIds: known,
    sessionOutcomes: { s2: "completed", s4: "failed" },
    notifications: bootNotifications,
    now: 5000,
  });
  assert.deepEqual(Object.keys(tracker.unreadCompleted), ["s2"]);

  // 2. After user clicks Mark Read (clearing unreadCompleted), re-running with the same
  //    notifications list NEVER resurrects n-s2!
  tracker = { ...tracker, unreadCompleted: {} };
  tracker = stepAttentionTrackerState(tracker, {
    liveRunning: {},
    visible: { page: "chat", chatSurfaceVisible: true, activeSessionId: "s1", splitColumns: [] },
    existingSessionIds: known,
    sessionOutcomes: {},
    notifications: bootNotifications,
    now: 6000,
  });
  assert.deepEqual(tracker.unreadCompleted, {});

  // 3. Minimized window (`chatSurfaceVisible: false` when document.visibilityState === "hidden"):
  //    s1 is activeSessionId and finishes while minimized -> MUST be recorded unread, then
  //    restoring window (`chatSurfaceVisible: true`) acknowledges s1 and emits `acknowledgedSessionIds: ["s1"]`!
  tracker = stepAttentionTrackerState(tracker, {
    liveRunning: { s1: true },
    visible: { page: "chat", chatSurfaceVisible: false, activeSessionId: "s1", splitColumns: [] },
    existingSessionIds: known,
    now: 7000,
  });
  tracker = stepAttentionTrackerState(tracker, {
    liveRunning: {},
    visible: { page: "chat", chatSurfaceVisible: false, activeSessionId: "s1", splitColumns: [] },
    existingSessionIds: known,
    latestTurnResults: { s1: { status: "completed" } },
    sessionOutcomes: { s1: "completed" },
    now: 8000,
  });
  assert.deepEqual(tracker.unreadCompleted, { s1: 8000 });

  const restored = stepAttentionTrackerState(tracker, {
    liveRunning: {},
    visible: { page: "chat", chatSurfaceVisible: true, activeSessionId: "s1", splitColumns: [] },
    existingSessionIds: known,
    latestTurnResults: { s1: { status: "completed" } },
    sessionOutcomes: { s1: "completed" },
    now: 9000,
  });
  assert.deepEqual(restored.unreadCompleted, {});
  assert.deepEqual(restored.acknowledgedSessionIds, ["s1"]);

  // 4. 7 simultaneous needs_action sessions: buildAttentionItems returns all 7,
  //    visibleAttentionSlice reports totalCount = 7, shows 6 collapsed (hiddenCount = 1), and all 7 expanded!
  const sevenSessions = Array.from({ length: 7 }, (_, idx) => ({
    id: `s${idx + 1}`,
    title: `Task ${idx + 1}`,
    projectPath: "/work/mc-agent",
    updatedAt: 1000 + idx,
  }));
  const sevenPerms = Object.fromEntries(sevenSessions.map((s) => [s.id, [{ id: `perm-${s.id}` }]]));
  const allSeven = buildAttentionItems({
    sessions: sevenSessions,
    runningSessions: {},
    pendingPermissions: sevenPerms,
    pendingAsks: {},
    unreadCompleted: {},
    projectMeta: {},
    untitledLabel: "Untitled",
  });
  assert.equal(allSeven.length, 7);

  const collapsedSlice = visibleAttentionSlice(allSeven, false, DEFAULT_ATTENTION_LIMIT);
  assert.equal(collapsedSlice.totalCount, 7);
  assert.equal(collapsedSlice.visibleItems.length, 6);
  assert.equal(collapsedSlice.hiddenCount, 1);

  const expandedSlice = visibleAttentionSlice(allSeven, true, DEFAULT_ATTENTION_LIMIT);
  assert.equal(expandedSlice.totalCount, 7);
  assert.equal(expandedSlice.visibleItems.length, 7);
  assert.equal(expandedSlice.hiddenCount, 0);
});

test("Round-3 P1/P2/P3: Smart-stop undo restores annotations without clobbering edits, Markdown fences backticks/newlines, and deleted sessions prune", async () => {
  let bySession = {
    s1: [
      {
        id: "a1",
        lineKey: "snap:new:4",
        sessionId: "s1",
        snapshotId: "snap",
        path: "src/tpl.ts",
        side: "new",
        line: 4,
        lineType: "add",
        code: "const tpl = `hello ``world```;",
        note: "Line 1 of note\nLine 2 of note",
        createdAt: 1,
      },
      {
        id: "a2",
        lineKey: "snap:new:8",
        sessionId: "s1",
        snapshotId: "snap",
        path: "src/tpl.ts",
        side: "new",
        line: 8,
        lineType: "add",
        code: "return tpl;",
        note: "Original L8 note",
        createdAt: 2,
      },
    ],
    "deleted-session": [
      {
        id: "old",
        lineKey: "snap:new:1",
        sessionId: "deleted-session",
        snapshotId: "snap",
        path: "src/old.ts",
        side: "new",
        line: 1,
        lineType: "add",
        code: "x",
        note: "stale",
        createdAt: 0,
      },
    ],
  };

  // #9: Backticks in code snippet (containing ```) use a 4-backtick fence (````) and multiline notes indent continuation lines.
  const formatted = formatDiffAnnotationsPrompt("Intro:", bySession.s1);
  assert.match(formatted, /````\+const tpl = `hello ``world```;````/);
  assert.match(formatted, /: Line 1 of note\n  Line 2 of note\n- \*\*L8\*\*/);

  // #1: Send succeeds (pruning a1 & a2), user adds a new note on L8, then clicks Stop before assistant replies:
  //     `onSmartStopUndo` restores a1 while keeping the newer L8 note untouched, and smart-stop carries `onSmartStopUndo`.
  let capturedDraft;
  const sent = await executeBatchAnnotationSend({
    sessionId: "s1",
    intro: "Intro:",
    getSessionItems: (id) => bySession[id] ?? [],
    pruneSent: (id, batch) => {
      bySession[id] = pruneSentAnnotations(bySession[id] ?? [], batch);
    },
    restoreSent: (id, batch) => {
      bySession[id] = restoreSentAnnotations(bySession[id] ?? [], batch);
    },
    isBusy: () => false,
    sendPrompt: async (prompt, _id, onUndo) => {
      capturedDraft = { text: prompt, fileReferences: [], onSmartStopUndo: onUndo };
      return true;
    },
    enqueuePrompt: async () => false,
  });
  assert.equal(sent.sent, true);
  assert.equal(bySession.s1.length, 0);

  // User writes a fresh note on L8 before clicking Stop:
  bySession.s1 = upsertAnnotationItem(bySession.s1, {
    id: "a2-newer",
    lineKey: "snap:new:8",
    sessionId: "s1",
    snapshotId: "snap",
    path: "src/tpl.ts",
    side: "new",
    line: 8,
    lineType: "add",
    code: "return tpl;",
    note: "Newer L8 note after send",
  });

  const smartStop = resolveComposerSmartStop(
    [{ role: "user", content: capturedDraft.text }],
    { messageCountBeforeSend: 0, draft: capturedDraft },
  );
  assert.equal(smartStop.kind, "restore");
  assert.equal(typeof smartStop.draft.onSmartStopUndo, "function");
  smartStop.draft.onSmartStopUndo();

  assert.deepEqual(
    bySession.s1.map((item) => ({ id: item.id, line: item.line, note: item.note })),
    [
      { id: "a1", line: 4, note: "Line 1 of note\nLine 2 of note" },
      { id: "a2-newer", line: 8, note: "Newer L8 note after send" },
    ],
  );

  // #11: Pruning deleted sessions drops `deleted-session` while keeping active `s1`.
  bySession = pruneAnnotationsForExistingSessions(bySession, new Set(["s1"]));
  assert.deepEqual(Object.keys(bySession), ["s1"]);
});

test("Round-3 P2/P3: NotificationCenter read/clear sync, Windows C:\\ & ProjectFolderIndex, planCheckpoints/planningStates, and Scheme A cleanup", () => {
  const known = new Set(["s1", "s2"]);

  // 1. Focused background completion (`running -> idle` before notifications arrive) keeps unread badge,
  //    then once NotificationCenter marks it read or clears all notifications, unreadCompleted[s2] clears too!
  let tracker = { unreadCompleted: {}, prevRunning: { s2: true } };
  tracker = stepAttentionTrackerState(tracker, {
    liveRunning: {},
    visible: { page: "chat", chatSurfaceVisible: true, activeSessionId: "s1", splitColumns: [] },
    existingSessionIds: known,
    latestTurnResults: { s2: { status: "completed" } },
    notifications: [],
    sessionOutcomes: {},
    now: 1000,
  });
  assert.deepEqual(tracker.unreadCompleted, { s2: 1000 });

  // Host notification arrives unread:
  tracker = stepAttentionTrackerState(tracker, {
    liveRunning: {},
    visible: { page: "chat", chatSurfaceVisible: true, activeSessionId: "s1", splitColumns: [] },
    existingSessionIds: known,
    latestTurnResults: { s2: { status: "completed" } },
    sessionOutcomes: { s2: "completed" },
    notifications: [
      { id: "n-s2", kind: "task.completed", sessionId: "s2", createdAt: "2026-11-18T05:00:00Z", readAt: null },
    ],
    now: 1100,
  });
  assert.deepEqual(tracker.unreadCompleted, { s2: 1000 });

  // User clicks "Mark read" in NotificationCenter (`readAt` populated, `sessionOutcomes` cleared):
  const afterMarkRead = stepAttentionTrackerState(tracker, {
    liveRunning: {},
    visible: { page: "chat", chatSurfaceVisible: true, activeSessionId: "s1", splitColumns: [] },
    existingSessionIds: known,
    latestTurnResults: { s2: { status: "completed" } },
    sessionOutcomes: {},
    notifications: [
      { id: "n-s2", kind: "task.completed", sessionId: "s2", createdAt: "2026-11-18T05:00:00Z", readAt: "2026-11-18T05:01:00Z" },
    ],
    now: 1200,
  });
  assert.deepEqual(afterMarkRead.unreadCompleted, {});

  // User clicks "Clear" in NotificationCenter (`notifications: []`, `sessionOutcomes: {}`):
  const afterClearAll = stepAttentionTrackerState(tracker, {
    liveRunning: {},
    visible: { page: "chat", chatSurfaceVisible: true, activeSessionId: "s1", splitColumns: [] },
    existingSessionIds: known,
    latestTurnResults: { s2: { status: "completed" } },
    sessionOutcomes: {},
    notifications: [],
    now: 1200,
  });
  assert.deepEqual(afterClearAll.unreadCompleted, {});

  // 2. Windows drive root `C:\`, `projectFolderIndex` group name, and `planCheckpoints` / `planningStates`.
  assert.equal(normalizeAttentionProjectPath("C:\\"), "C:/");
  assert.equal(normalizeAttentionProjectPath("\\\\?\\C:\\repo\\sub\\"), "C:/repo/sub");

  const folderIndex = new Map([
    ["/repo/docs-root/worktree-a", { groupName: "Unified Project", primaryKey: "/repo/docs-root" }],
  ]);
  const attention = buildAttentionItems({
    sessions: [
      { id: "win", title: "Win root", projectPath: "C:\\", updatedAt: 100 },
      { id: "grp", title: "Sub worktree", projectPath: "/repo/docs-root/worktree-a", updatedAt: 200 },
    ],
    runningSessions: {},
    pendingPermissions: {},
    pendingAsks: {},
    planCheckpoints: { win: { status: "pending" } },
    planningStates: { grp: "awaiting_approval" },
    unreadCompleted: {},
    projectMeta: { "C:/": { name: "System Drive" } },
    projectFolderIndex: folderIndex,
    untitledLabel: "Untitled",
  });
  assert.deepEqual(
    attention.map((item) => ({ id: item.sessionId, kind: item.kind, project: item.projectLabel })),
    [
      { id: "grp", kind: "needs_action", project: "Unified Project" },
      { id: "win", kind: "needs_action", project: "System Drive" },
    ],
  );

  // 3. Structural checks: `data-slot="app-rail-plugins"` wraps `railViews`, Windows inset is 112px,
  //    `ChatReviewBatchDock` is mounted in `ChatSurface` & `SplitColumns`, and dead `AppRail`/`CreativePage` are gone.
  const footerSource = readFileSync(new URL("../src/features/app-rail/SidebarFooter.tsx", import.meta.url), "utf8");
  const railCss = readFileSync(new URL("../src/styles/app-rail.css", import.meta.url), "utf8");
  const chatSurface = readFileSync(new URL("../src/components/ChatSurface.tsx", import.meta.url), "utf8");
  const splitColumns = readFileSync(new URL("../src/features/split-view/SplitColumns.tsx", import.meta.url), "utf8");
  const cardSource = readFileSync(new URL("../src/components/ReviewChangeCard.tsx", import.meta.url), "utf8");
  const attnWatcher = readFileSync(new URL("../src/features/attention-feed/attention-store.ts", import.meta.url), "utf8");

  assert.match(footerSource, /data-slot="app-rail-plugins">\s*\{railViews\.map/);
  assert.doesNotMatch(footerSource, /mc-sidebar-footer-end"[^>]*data-slot="app-rail-plugins"/);
  assert.match(railCss, /inset-inline-start:\s*112px/);
  assert.doesNotMatch(railCss, /108px\s*;/);
  assert.match(chatSurface, /<ChatReviewBatchDock sessionId=\{visibleSessionId\} \/>/);
  assert.match(splitColumns, /<ChatReviewBatchDock sessionId=\{id\} \/>/);
  assert.match(cardSource, /\(isEditingLine \|\| Boolean\(existingNote\)\)\s*\?\s*\(\s*<DiffLineAnnotationSlot/);
  assert.match(attnWatcher, /document\.hasFocus\(\)/);
  assert.match(attnWatcher, /listableSessions\(sessions\)/);
  assert.equal(existsSync(new URL("../src/features/app-rail/AppRail.tsx", import.meta.url)), false);
  assert.equal(existsSync(new URL("../src/features/creative/CreativePage.tsx", import.meta.url)), false);
});

test("R37 UX: Left-gutter speech-bubble morph, Shift-range prompt formatting, and snapshot-bound file Viewed progress", () => {
  // 1. Multi-line Shift-range formatting (`L5–L8` and `old L12–L16`).
  let list = [];
  list = upsertAnnotationItem(list, {
    id: "range-new",
    lineKey: "snap-1:new:8",
    sessionId: "s1",
    snapshotId: "snap-1",
    path: "src/query.ts",
    side: "new",
    startLine: 5,
    line: 8,
    lineType: "add",
    code: "return query();",
    note: "Extract lines 5-8 into helper",
  });
  list = upsertAnnotationItem(list, {
    id: "range-old",
    lineKey: "snap-1:old:16",
    sessionId: "s1",
    snapshotId: "snap-1",
    path: "src/query.ts",
    side: "old",
    startLine: 12,
    line: 16,
    lineType: "del",
    code: "oldQuery();",
    note: "Keep fallback error code from old block",
  });
  const prompt = formatDiffAnnotationsPrompt("请修改：", list);
  assert.match(prompt, /- \*\*L5–L8\*\* \(`\+return query\(\);`\): Extract lines 5-8 into helper/);
  assert.match(prompt, /- \*\*old L12–L16\*\* \(`-oldQuery\(\);`\): Keep fallback error code from old block/);

  // 2. Per-file `Viewed` progress tracks `(snapshotId, state)` signature and auto-resets when re-edited.
  const filesRound1 = [
    { id: "workspace:a.ts", entries: [{ change: { snapshotId: "s-a1", state: "active" } }] },
    { id: "workspace:b.ts", entries: [{ change: { snapshotId: "s-b1", state: "active" } }] },
  ];
  const sigA1 = reviewFileSignature(filesRound1[0].entries);
  const toggledOn = toggleReviewFileViewedMap(undefined, "workspace:a.ts", sigA1);
  assert.equal(toggledOn.viewed, true);
  assert.equal(isReviewFileViewed(toggledOn.next, "workspace:a.ts", sigA1), true);
  assert.equal(countReviewedFiles(filesRound1, toggledOn.next), 1);

  // Agent edits `a.ts` again in Round 2 (new snapshot `s-a2`): Viewed automatically resets to 0/2!
  const filesRound2 = [
    { id: "workspace:a.ts", entries: [{ change: { snapshotId: "s-a1", state: "active" } }, { change: { snapshotId: "s-a2", state: "active" } }] },
    { id: "workspace:b.ts", entries: [{ change: { snapshotId: "s-b1", state: "active" } }] },
  ];
  assert.equal(countReviewedFiles(filesRound2, toggledOn.next), 0);

  // Unchecking toggles off cleanly:
  const toggledOff = toggleReviewFileViewedMap(toggledOn.next, "workspace:a.ts", sigA1);
  assert.equal(toggledOff.viewed, false);
  assert.deepEqual(toggledOff.next, {});

  // 3. CSS & DOM contracts for left-gutter bubble swap and Forced Colors safety.
  const zenCss = readFileSync(new URL("../src/styles/mc-zen-orca.css", import.meta.url), "utf8");
  const cardSource = readFileSync(new URL("../src/components/ReviewChangeCard.tsx", import.meta.url), "utf8");
  assert.match(zenCss, /--mc-icon-bubble-add:/);
  assert.match(zenCss, /--mc-icon-bubble-saved:/);
  assert.match(zenCss, /forced-color-adjust:\s*none/);
  assert.match(cardSource, /className="mc-diff-gutter-text"/);
  assert.match(cardSource, /aria-expanded=\{isEditingLine\}/);
});

test("Bugfix #160/#161 (1/3): Reverse Shift+Click (L8 -> Shift+L5) resolves canonical L5–L8 range", () => {
  const rendered = new Set(["snap:new:5", "snap:new:6", "snap:new:7", "snap:new:8"]);

  const forward = resolveDiffShiftRangeTarget({
    snapshotId: "snap",
    side: "new",
    anchorLine: 5,
    clickedLine: 8,
    clickedLineKey: "snap:new:8",
    hasLineKey: (k) => rendered.has(k),
  });
  assert.deepEqual(forward, {
    lineKey: "snap:new:8",
    side: "new",
    startLine: 5,
    endLine: 8,
  });

  const reverse = resolveDiffShiftRangeTarget({
    snapshotId: "snap",
    side: "new",
    anchorLine: 8,
    clickedLine: 5,
    clickedLineKey: "snap:new:5",
    hasLineKey: (k) => rendered.has(k),
  });
  assert.deepEqual(reverse, {
    lineKey: "snap:new:8",
    side: "new",
    startLine: 5,
    endLine: 8,
  });

  const singleLine = resolveDiffShiftRangeTarget({
    snapshotId: "snap",
    side: "new",
    anchorLine: 8,
    clickedLine: 8,
    clickedLineKey: "snap:new:8",
    hasLineKey: (k) => rendered.has(k),
  });
  assert.deepEqual(singleLine, {
    lineKey: "snap:new:8",
    side: "new",
    startLine: null,
    endLine: 8,
  });

  // Fallback when anchor's lineKey was scrolled/collapsed out of rendered hunks:
  const fallback = resolveDiffShiftRangeTarget({
    snapshotId: "snap",
    side: "new",
    anchorLine: 8,
    clickedLine: 5,
    clickedLineKey: "snap:new:5",
    hasLineKey: (k) => k === "snap:new:5",
  });
  assert.deepEqual(fallback, {
    lineKey: "snap:new:5",
    side: "new",
    startLine: 8,
    endLine: 5,
  });

  // Top-down fallback (e.g. raw unnumbered key) preserves startLine=5, endLine=8 instead of collapsing 8..8:
  const topDownFallback = resolveDiffShiftRangeTarget({
    snapshotId: "snap",
    side: "new",
    anchorLine: 5,
    clickedLine: 8,
    clickedLineKey: "snap:raw:0:3",
    hasLineKey: () => false,
  });
  assert.deepEqual(topDownFallback, {
    lineKey: "snap:raw:0:3",
    side: "new",
    startLine: 5,
    endLine: 8,
  });
});

test("Bugfix #160/#161 (2/3): Editing startLine (L5–L8 -> L3–L8 or single-line) while send is in flight is preserved by pruneSentAnnotations", async () => {
  const bySession = {
    s1: [
      {
        id: "unchanged-range",
        lineKey: "snap:new:12",
        sessionId: "s1",
        snapshotId: "snap",
        path: "src/bounds.ts",
        side: "new",
        startLine: 10,
        line: 12,
        lineType: "add",
        code: "return total;",
        note: "Extract lines 10-12",
        createdAt: 1,
      },
      {
        id: "edited-range",
        lineKey: "snap:new:8",
        sessionId: "s1",
        snapshotId: "snap",
        path: "src/bounds.ts",
        side: "new",
        startLine: 5,
        line: 8,
        lineType: "add",
        code: "const limit = max;",
        note: "Check upper bound",
        createdAt: 2,
      },
    ],
  };

  let resolveSend;
  const sentPrompts = [];
  const pendingSend = executeBatchAnnotationSend({
    sessionId: "s1",
    intro: "请修改：",
    getSessionItems: (id) => bySession[id] ?? [],
    pruneSent: (id, sentBatch) => {
      bySession[id] = pruneSentAnnotations(bySession[id] ?? [], sentBatch);
    },
    isBusy: () => false,
    sendPrompt: (prompt) =>
      new Promise((resolve) => {
        sentPrompts.push(prompt);
        resolveSend = resolve;
      }),
    enqueuePrompt: async () => false,
  });

  // While sendPrompt is awaiting IPC, user widens L5–L8 to L3–L8 without changing note text:
  bySession.s1 = upsertAnnotationItem(bySession.s1, {
    id: "edited-range",
    lineKey: "snap:new:8",
    sessionId: "s1",
    snapshotId: "snap",
    path: "src/bounds.ts",
    side: "new",
    startLine: 3,
    line: 8,
    lineType: "add",
    code: "const limit = max;",
    note: "Check upper bound",
  });

  resolveSend(true);
  const res = await pendingSend;
  assert.equal(res.sent, true);
  assert.match(sentPrompts[0], /- \*\*L5–L8\*\*/);
  assert.doesNotMatch(sentPrompts[0], /L3–L8/);

  // `unchanged-range` was sent as-is and pruned; `edited-range` (now L3–L8) MUST survive!
  assert.deepEqual(
    bySession.s1.map((item) => ({ id: item.id, startLine: item.startLine, line: item.line })),
    [{ id: "edited-range", startLine: 3, line: 8 }],
  );

  // Shrinking L3–L8 back to single-line L8 (`startLine: null`) during a second send also survives:
  const shrunk = pruneSentAnnotations(
    [{ ...bySession.s1[0], startLine: null }],
    bySession.s1,
  );
  assert.equal(shrunk.length, 1);
  assert.equal(shrunk[0].startLine, null);
});

test("Bugfix #160/#161 (3/3): Stopping a queued diff-annotation batch right after dequeue restores annotations instead of overwriting composerPrefill", async () => {
  register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
  const [{ createSessionRuntime }, { createQueueSlice }, { createTranscriptSlice }] =
    await Promise.all([
      import("../src/stores/runtime/session-runtime.ts"),
      import("../src/stores/slices/queue-slice.ts"),
      import("../src/stores/slices/transcript-slice.ts"),
    ]);

  const previousWindow = globalThis.window;
  let hostQueue = [];
  let hostMessages = [];
  let replacedMessages = null;
  globalThis.window = {
    piDesktop: {
      invoke: async (channel, ...args) => {
        const payload = args[0];
        if (channel === IPC.invoke.agentQueuePush) {
          const entry = {
            id: `q-${hostQueue.length + 1}`,
            sessionId: payload.sessionId,
            content: payload.content,
            position: hostQueue.length + 1,
            createdAt: "2026-11-18T14:00:00Z",
          };
          hostQueue = [...hostQueue, entry];
          return { ok: true, data: entry };
        }
        if (channel === IPC.invoke.agentQueueList) {
          return { ok: true, data: { entries: hostQueue } };
        }
        if (channel === IPC.invoke.agentQueueRemove) {
          hostQueue = hostQueue.filter((item) => item.id !== payload.turnId);
          return { ok: true, data: {} };
        }
        if (channel === IPC.invoke.agentStop) {
          return { ok: true, data: { requested: true } };
        }
        if (channel === IPC.invoke.sessionGet) {
          return {
            ok: true,
            data: {
              session: {
                id: typeof payload === "string" ? payload : payload.id,
                title: "Session A",
                source: "desktop",
                messages: hostMessages,
                messageStart: 0,
                hasMoreBefore: false,
              },
            },
          };
        }
        if (channel === IPC.invoke.sessionReplaceMessages) {
          replacedMessages = payload.messages;
          hostMessages = payload.messages;
          return { ok: true, data: {} };
        }
        throw new Error(`Unexpected IPC: ${channel}`);
      },
    },
  };

  try {
    let bySession = {
      "session-a": [
        {
          id: "queued-note-1",
          lineKey: "snap-q:new:6",
          sessionId: "session-a",
          snapshotId: "snap-q",
          path: "src/queued.ts",
          side: "new",
          startLine: 4,
          line: 6,
          lineType: "add",
          code: "return queued();",
          note: "Restore me on smart-stop after dequeue",
          createdAt: 10,
        },
      ],
    };

    const turn1Messages = [
      { id: "u1", role: "user", content: "Run turn 1", createdAt: "2026-11-18T13:59:00Z" },
      {
        id: "a1",
        role: "assistant",
        content: "Turn 1 finished.",
        status: "complete",
        createdAt: "2026-11-18T13:59:10Z",
      },
    ];
    hostMessages = [...turn1Messages];

    let state = {
      page: "chat",
      activeSessionId: "session-a",
      sessions: [{ id: "session-a", title: "Session A", source: "desktop" }],
      messages: [...turn1Messages],
      retainedTranscripts: {},
      sessionHistory: {},
      pendingPlans: {},
      pendingPermissions: {},
      queuedPrompts: {},
      isRunning: true,
      runningSessions: { "session-a": true },
      latestTurnResults: {},
      sessionOutcomes: {},
      composerPrefill: undefined,
      showToast: assert.fail,
      rememberModel() {},
      refreshSessions: async () => {},
    };
    const access = {
      get: () => state,
      set: (patch) => {
        const next = typeof patch === "function" ? patch(state) : patch;
        state = { ...state, ...next };
      },
    };
    const runtime = createSessionRuntime(access);
    const queueSlice = createQueueSlice({
      ...access,
      runtime,
      promptAttachmentsFromDraft: () => [],
      withoutRecordKey: (record, key) => {
        const next = { ...record };
        delete next[key];
        return next;
      },
      viewingSessionIdForPrompt: () => "session-a",
      messageErrorFromUnknown: (error) => ({ code: "FAILED", message: String(error) }),
      assistantErrorMessage: () => ({ id: "err", role: "assistant", content: "failed", createdAt: "" }),
      materializeDraftSession: async () => null,
    });
    const transcriptSlice = createTranscriptSlice({
      ...access,
      runtime,
      promptAttachmentsFromMessage: () => [],
      viewingSessionIdForPrompt: () => "session-a",
      flushPendingSessionConfiguration: async () => {},
    });
    Object.assign(state, queueSlice, transcriptSlice);

    // 1. Enqueue the diff-annotation batch while Turn 1 is still running:
    const queuedResult = await executeBatchAnnotationSend({
      sessionId: "session-a",
      intro: "请按以下逐行代码审查批注一并修改：",
      getSessionItems: (id) => bySession[id] ?? [],
      pruneSent: (id, batch) => {
        bySession[id] = pruneSentAnnotations(bySession[id] ?? [], batch);
      },
      restoreSent: (id, batch) => {
        bySession[id] = restoreSentAnnotations(bySession[id] ?? [], batch);
      },
      isBusy: (id) => Boolean(state.runningSessions[id]),
      sendPrompt: (prompt, id, onUndo) =>
        state.sendPrompt(prompt, { text: prompt, fileReferences: [], onSmartStopUndo: onUndo }, id),
      enqueuePrompt: (prompt, id, onUndo) =>
        state.enqueuePrompt(prompt, { text: prompt, fileReferences: [], onSmartStopUndo: onUndo }, id),
    });
    assert.equal(queuedResult.sent, true);
    assert.equal(queuedResult.queued, true);
    assert.equal(bySession["session-a"].length, 0);
    await state.refreshQueuedPrompts("session-a");
    assert.equal(state.queuedPrompts["session-a"].length, 1);

    // 2. Turn 1 finishes (`submittedComposerDrafts` cleared) and Host dequeues `q-1` into Turn 2:
    const dequeuedEntry = hostQueue[0];
    hostQueue = [];
    runtime.submittedComposerDrafts.delete("session-a");
    state.applyQueueChanged({ sessionId: "session-a", entries: [] });
    assert.equal(state.queuedPrompts["session-a"], undefined);

    const turn2User = {
      id: "u2-batch",
      role: "user",
      content: dequeuedEntry.content,
      createdAt: "2026-11-18T14:00:01Z",
    };
    hostMessages = [...turn1Messages, turn2User];
    // Even if `state.messages` hasn't received `user_message_persisted` yet (worst-case IPC race),
    // `abort()` checks `runtime.hasQueuedDraft("session-a")`, loads fullMessages, restores annotations,
    // and leaves `composerPrefill` untouched!
    state.isRunning = true;
    state.runningSessions = { "session-a": true };

    await state.abort();

    assert.equal(
      state.composerPrefill,
      undefined,
      "stopping dequeued annotation batch must NOT overwrite chat composer draft/attachments",
    );
    assert.equal(bySession["session-a"].length, 1);
    assert.equal(bySession["session-a"][0].id, "queued-note-1");
    assert.deepEqual(
      replacedMessages?.map((m) => m.id),
      ["u1", "a1"],
      "Turn 2 user message retracted from durable transcript",
    );

    // 3. Cancellation cleanup: if user queues a batch and explicitly deletes it from the queue,
    //    `removeQueuedDraft` clears its `onSmartStopUndo` so a later plain turn never misfires.
    let undoMisfired = false;
    await state.enqueuePrompt(
      "Same text later",
      {
        text: "Same text later",
        fileReferences: [],
        onSmartStopUndo: () => {
          undoMisfired = true;
        },
      },
      "session-a",
    );
    await state.refreshQueuedPrompts("session-a");
    const cancelledId = state.queuedPrompts["session-a"][0].id;
    await state.removeQueuedPrompt(cancelledId);
    assert.equal(state.queuedPrompts["session-a"], undefined);

    const turn3PlainUser = {
      id: "u3-plain",
      role: "user",
      content: "Same text later",
      createdAt: "2026-11-18T14:01:00Z",
    };
    hostMessages = [...turn1Messages, turn3PlainUser];
    state.messages = [...hostMessages];
    state.isRunning = true;
    state.runningSessions = { "session-a": true };

    await state.abort();
    assert.equal(undoMisfired, false);
    assert.equal(state.composerPrefill?.text, "Same text later");
  } finally {
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
  }
});
