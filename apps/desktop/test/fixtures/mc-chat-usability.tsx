import { checkFastMode } from "./mc-fast-mode";
import { checkBuiltinPrompt } from "./mc-builtin-prompt";
import { checkNoticeCards } from "./mc-notice-cards";
import { checkCurrentContext } from "./mc-context-usage";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import { catalogs, flattenCatalog } from "@pi-desktop/i18n";
import { SessionTabs } from "../../src/features/session-tabs/SessionTabs";
import { ReviewChangeCard } from "../../src/components/ReviewChangeCard";
import { ReviewHistoryFile } from "../../src/components/workpanel/ReviewHistoryFile";
import { ReviewHistoryToolbar } from "../../src/components/workpanel/ReviewHistoryToolbar";
import { ReviewTab } from "../../src/components/workpanel/ReviewTab";
import { SidebarAttentionFeed } from "../../src/features/attention-feed/SidebarAttentionFeed";
import { useAttentionStore } from "../../src/features/attention-feed/attention-store";
import { SlotSessionProvider } from "../../src/plugins/renderer-slots/use-slots";
import { ChatReviewBatchDock, ReviewBatchBar } from "../../src/features/review-annotations/ReviewAnnotationWidgets";
import {
  sendBatchAnnotationsToSession,
  useReviewAnnotations,
} from "../../src/features/review-annotations/review-annotations";
import { useAppStore } from "../../src/stores/app-store";
import { setSplitColumns, useSplitView } from "../../src/lib/mc-split-view";
import { api } from "../../src/lib/api";
import { ComposerInput } from "../../src/features/chat/composer/ComposerInput";
import { useComposerDraft } from "../../src/features/chat/composer/hooks/useComposerDraft";
import { readEditorValue } from "../../src/features/chat/composer/editor";
import "tailwindcss/preflight.css";
import "../../src/styles/tokens.css";
import "../../src/styles/base.css";
import "../../src/styles/composer.css";
import "../../src/styles/app-rail.css";
import "../../src/styles/ui-kit.css";
import "../../src/styles/mc-session-tabs.css";
import "../../src/styles/mc-zen-orca.css";

const noop = () => {};
const settle = () => new Promise((resolve) => setTimeout(resolve, 30));
function check(ok, message) { if (!ok) throw new Error(message); }
async function until(predicate, label) {
  for (let n = 0; n < 150; n++) { if (predicate()) return; await settle(); }
  throw new Error(label);
}
await i18n.use(initReactI18next).init({ lng: "zh-CN", keySeparator: false,
  resources: { "zh-CN": { translation: flattenCatalog(catalogs["zh-CN"]) } }, interpolation: { escapeValue: false } });
window.piDesktop = { platform: "win32" };
const sessions = ["a", "b", "c"].map((id) => ({ id, title: "会话 " + id, source: "local" }));
const pins = [];
const renames = [];
const select = async (id) => useAppStore.setState({ activeSessionId: id, page: "chat" });
useAppStore.setState({ sessions, activeSessionId: "a", page: "chat", workspace: { path: "/fixture", name: "fixture" },
  sessionMeta: {}, runningSessions: { c: true }, selectSession: select,
  toggleSessionPinned: (id) => {
    pins.push(id);
    useAppStore.setState({ sessionMeta: { [id]: { pinned: true } } });
  },
  renameSession: async (id, title) => {
    renames.push({ id, title });
    useAppStore.setState({ sessions: sessions.map((s) => s.id === id ? { ...s, title } : s) });
  },
});
const canvas = document.createElement("canvas");
canvas.width = 200; canvas.height = 120;
const ctx = canvas.getContext("2d");
ctx.fillStyle = "#416d96"; ctx.fillRect(0, 0, 200, 120);
ctx.fillStyle = "#e7bf6d"; ctx.fillRect(20, 20, 60, 80);
const src = canvas.toDataURL("image/png");
let pending;
let retryReads = 0;
api.fsReadImageDataUrl = async (path) => {
  if (path.includes("pending")) return new Promise((resolve) => { pending = resolve; });
  if (path.includes("retry") && retryReads++ === 0) throw new Error("fixture unavailable");
  return { kind: "image", dataUrl: src };
};
let draft;
let blocked = false;
function Fixture() {
  const activeSessionId = useAppStore((s) => s.activeSessionId);
  draft = useComposerDraft({ variant: "docked", activeSessionId, workspacePath: "/fixture", sessions,
    composerPrefill: null, clearComposerPrefill: noop, t: i18n.t, invalidateComposerTransforms: noop, inputBlocked: blocked });
  return <>
    <SessionTabs onNewTask={() => useAppStore.setState({ activeSessionId: null, page: "chat" })} />
    <div style={{ margin: "32px", padding: "20px", background: "var(--ds-bg-composer)", borderRadius: "20px" }}>
      <ComposerInput inputRef={draft.ref} value={draft.value} imagePreview={draft.imagePreview} onRemoveImage={draft.removeImage}
        placeholderText="输入消息" placeholderKey="fixture" inputBlocked={blocked} pasting={false} enterToSend={false} runActive={false}
        composerAc={{ open: false, hasItems: false, close: noop }} onPaste={noop} onAcceptCompletion={noop}
        onSubmit={noop} onInsertNewline={noop} onHistoryNavigate={() => false} onInput={draft.handleInput}
        onCompositionStart={noop} onCompositionEnd={noop} onSettledInput={noop} onFocus={noop} onBlur={noop} />
    </div>
  </>;
}
const root = createRoot(document.getElementById("root"));
const render = () => flushSync(() => root.render(<Fixture />));
render();
const tab = (id) => document.querySelector('[data-tab-key="' + id + '"]');
const tabs = () => [...document.querySelectorAll("[data-tab-key]")].map((e) => e.dataset.tabKey);
async function menu(id) {
  tab(id).dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 200, clientY: 45 }));
  await settle();
}
async function action(label) {
  const item = [...document.querySelectorAll('[role="menuitem"]')].find((e) => e.textContent === label);
  check(item, "menu item missing: " + label);
  item.click(); await settle();
}
function makeReviewMessage(id, snapshotId, path) {
  return {
    id,
    role: "tool",
    toolName: "Edit",
    toolStatus: "success",
    content: "",
    toolResult: {
      details: {
        root: "workspace",
        review: {
          version: 1,
          snapshotId,
          messageId: id,
          path,
          operation: "edit",
          status: "modified",
          state: "active",
          additions: 1,
          deletions: 0,
          reversible: false,
          hunks: [{ header: "@@ -10,1 +10,2 @@", lines: [{ type: "context", text: "const x = 1;" }, { type: "add", text: "const y = 2;" }] }],
        },
      },
    },
  };
}

async function checkSplitPaneAnnotationIsolation() {
  useReviewAnnotations.setState({ bySession: {} });
  useAppStore.setState({ activeSessionId: "a", page: "chat" });
  const host = document.createElement("div");
  document.body.appendChild(host);
  const splitRoot = createRoot(host);
  const msgA = makeReviewMessage("m-a", "snap-a", "src/a.ts");
  const msgB = makeReviewMessage("m-b", "snap-b", "src/b.ts");
  try {
    flushSync(() =>
      splitRoot.render(
        <div style={{ display: "flex", gap: "12px" }}>
          <div data-pane="a">
            <SlotSessionProvider sessionId="a">
              <ReviewChangeCard message={msgA} asToolRow openRequest={1} />
            </SlotSessionProvider>
          </div>
          <div data-pane="b">
            <SlotSessionProvider sessionId="b">
              <ReviewChangeCard message={msgB} asToolRow openRequest={1} />
            </SlotSessionProvider>
          </div>
        </div>,
      ),
    );
    await settle();
    check(useAppStore.getState().activeSessionId === "a", "focus stays on pane A");
    const paneB = host.querySelector('[data-pane="b"]');
    const addBtnB = paneB.querySelector(".mc-diff-annotate-btn");
    check(addBtnB, "pane B renders diff annotate button");
    addBtnB.focus();
    addBtnB.click();
    await settle();
    const textareaB = paneB.querySelector(".mc-diff-annotation-input");
    check(textareaB, "pane B opens inline annotation editor");
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(textareaB, "仅归属 B 会话的键盘批注");
    textareaB.dispatchEvent(new Event("input", { bubbles: true }));
    await settle();
    textareaB.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", metaKey: true, bubbles: true, cancelable: true }));
    await settle();
    check(useAppStore.getState().activeSessionId === "a", "keyboard save in B never steals global focus state");
    check(!useReviewAnnotations.getState().bySession.a, "pane A batch remains untouched");
    check(useReviewAnnotations.getState().bySession.b?.length === 1, "annotation saved exclusively to pane B batch");
    check(paneB.querySelector(".mc-diff-annotation-card")?.textContent.includes("仅归属 B 会话的键盘批注"), "annotation card rendered in pane B");
    // Switch focus to B and back to A: annotation stays pinned in B.
    useAppStore.setState({ activeSessionId: "b" });
    await settle();
    check(paneB.querySelector(".mc-diff-annotation-card")?.textContent.includes("仅归属 B 会话的键盘批注"), "annotation stays in B when B is focused");
    useAppStore.setState({ activeSessionId: "a" });
    await settle();
    check(paneB.querySelector(".mc-diff-annotation-card")?.textContent.includes("仅归属 B 会话的键盘批注"), "annotation stays in B after focus returns to A");
    check(!host.querySelector('[data-pane="a"] .mc-diff-annotation-card'), "pane A never shows B's annotation");
  } finally {
    flushSync(() => splitRoot.unmount());
    host.remove();
    useReviewAnnotations.setState({ bySession: {}, sendingBySession: {} });
  }
}

async function checkRound2ReviewAndAttentionEdgeCases() {
  const prevState = useAppStore.getState();
  const prevContextApi = api.workspaceReviewContext;
  const host = document.createElement("div");
  document.body.appendChild(host);
  const subRoot = createRoot(host);
  let contextCalls = 0;
  const acknowledged = [];
  try {
    // 1. Remote workspace LegacyReviewTab expanding inline diff MUST NOT call workspaceReviewContext or show contextError.
    api.workspaceReviewContext = async () => {
      contextCalls += 1;
      throw new Error("remote workspace has no local review context");
    };
    const remoteMsg = makeReviewMessage("m-rem", "snap-rem", "src/remote.ts");
    useAppStore.setState({
      sessions: [
        ...sessions,
        { id: "rem-ws", title: "Remote WS", source: "local", remoteWorkspace: { hostKey: "box", path: "/srv/app" } },
      ],
      activeSessionId: "rem-ws",
      messages: [remoteMsg],
    });
    flushSync(() => subRoot.render(<ReviewTab />));
    await settle();
    const headerBtn = host.querySelector(".review-change-card-header");
    check(headerBtn, "remote workspace LegacyReviewTab renders ReviewChangeCard");
    headerBtn.click();
    await settle();
    check(contextCalls === 0, "LegacyReviewTab never calls workspaceReviewContext on remote workspace");
    check(!host.querySelector('[role="alert"]'), "remote workspace diff shows no contextError alert");
    check(host.querySelector(".review-change-diff")?.textContent.includes("const y = 2;"), "remote workspace inline diff renders cleanly");

    // 2. Plan approval pending disables batch send button with clear reason, and mid-send session switch blocks double-send.
    useReviewAnnotations.setState({
      bySession: {
        a: [{
          id: "n-plan",
          lineKey: "snap-a:new:10",
          sessionId: "a",
          snapshotId: "snap-a",
          path: "src/a.ts",
          side: "new",
          line: 10,
          lineType: "add",
          code: "const y = 2;",
          note: "Check plan lock",
          createdAt: 1,
        }],
      },
      sendingBySession: {},
    });
    useAppStore.setState({
      sessions,
      activeSessionId: "a",
      messages: [],
      pendingPlans: { a: { id: "plan-1", sessionId: "a", status: "pending", kind: "plan", title: "Plan", createdAt: "" } },
    });
    flushSync(() => subRoot.render(<ReviewBatchBar sessionId="a" />));
    await settle();
    check(host.querySelector(".mc-review-batch-hint")?.textContent.includes("请先审批当前计划"), "batch bar explains pending plan lock");
    const primarySendBtn = [...host.querySelectorAll(".mc-review-batch-actions button")].at(-1);
    check(primarySendBtn?.disabled === true, "send button disabled while plan approval is pending");

    // Clear pending plan, start delayed send on "a", remount ReviewBatchBar as if switching a -> b -> a, verify still locked.
    let resolvePrompt;
    let promptCount = 0;
    useAppStore.setState({
      pendingPlans: {},
      sendPrompt: () => new Promise((resolve) => { promptCount += 1; resolvePrompt = resolve; }),
    });
    flushSync(() => subRoot.render(<ReviewBatchBar key="mount-1" sessionId="a" />));
    await settle();
    host.querySelectorAll(".mc-review-batch-actions button")[1].click();
    await settle();
    flushSync(() => subRoot.render(<ReviewBatchBar key="mount-2" sessionId="b" />));
    await settle();
    flushSync(() => subRoot.render(<ReviewBatchBar key="mount-3" sessionId="a" />));
    await settle();
    const remountedSendBtn = host.querySelectorAll(".mc-review-batch-actions button")[1];
    check(remountedSendBtn?.disabled === true, "remounted ReviewBatchBar keeps send button disabled while in flight");
    const secondTry = await sendBatchAnnotationsToSession("a", "Intro:");
    check(secondTry.sent === false && secondTry.blockedReason === "sending" && promptCount === 1, "switching sessions cannot send same batch twice");
    resolvePrompt(true);
    await settle();

    // 3. SidebarAttentionFeed with 7 items shows true count 7, expands 7th item, and Mark Read syncs acknowledgeSessionOutcome.
    const seven = Array.from({ length: 7 }, (_, i) => ({ id: `att-${i + 1}`, title: `任务 ${i + 1}`, source: "local" }));
    const perms = Object.fromEntries(seven.slice(0, 6).map((s) => [s.id, [{ id: `p-${s.id}` }]]));
    useAttentionStore.setState({ unreadCompleted: { "att-7": 9999 } });
    useAppStore.setState({
      sessions: seven,
      activeSessionId: "att-1",
      page: "chat",
      pendingPermissions: perms,
      sessionOutcomes: { "att-7": "completed" },
      acknowledgeSessionOutcome: async (id) => {
        acknowledged.push(id);
        useAppStore.setState({ sessionOutcomes: {} });
      },
    });
    flushSync(() => subRoot.render(<SidebarAttentionFeed />));
    await settle();
    check(host.querySelector(".mc-attention-count")?.textContent === "7", "attention header shows true total 7 instead of truncated 6");
    check(host.querySelectorAll(".mc-attention-row").length === 6, "collapsed attention feed renders 6 rows");
    const moreBtn = host.querySelector("[data-attention-toggle-more]");
    check(moreBtn, "overflow toggle button rendered when > 6 items");
    moreBtn.click();
    await settle();
    check(host.querySelectorAll(".mc-attention-row").length === 7, "expanding reveals the 7th item");
    host.querySelector(".mc-attention-clear").click();
    await settle();
    check(acknowledged.includes("att-7"), "Mark Read synchronizes acknowledgeSessionOutcome for completed sessions");
    check(!useAppStore.getState().sessionOutcomes["att-7"], "sidebar sessionOutcome cleared together with attention feed");

    // 4. Round-3: stray scheduledRun unread key does NOT expose "Mark read" when only needs_action/running rows exist,
    //    and selectSession rejection surfaces an error toast instead of unhandled rejection.
    const toastMessages = [];
    useAttentionStore.setState({ unreadCompleted: { "sched-hidden": 9999 } });
    useAppStore.setState({
      sessions: [
        ...seven.slice(0, 2),
        { id: "sched-hidden", title: "Cron", source: "local", scheduledRun: true },
      ],
      pendingPermissions: { "att-1": [{ id: "p-1" }] },
      selectSession: async () => {
        throw new Error("项目文件夹已移走");
      },
      showToast: (msg) => {
        toastMessages.push(msg);
      },
    });
    flushSync(() => subRoot.render(<SidebarAttentionFeed />));
    await settle();
    check(!host.querySelector(".mc-attention-clear"), "scheduledRun unread key must not show Mark read when no completed row is visible");
    host.querySelector('[data-attention-session="att-2"]')?.click();
    useAppStore.setState({ pendingPermissions: { "att-1": [{ id: "p-1" }], "att-2": [{ id: "p-2" }] } });
    flushSync(() => subRoot.render(<SidebarAttentionFeed />));
    await settle();
    host.querySelector('[data-attention-session="att-2"]').click();
    await settle();
    check(toastMessages.includes("项目文件夹已移走"), "selectSession error surfaces toast in SidebarAttentionFeed");

    // 5. Round-3: ChatReviewBatchDock renders when WorkPanel is closed and hides when active session's Review pane is open;
    //    and mid-send re-editing a diff note preserves the user's in-progress textarea draft when pruneSent fires.
    const localDiffMessage = makeReviewMessage("m-local-diff", "snap-local-1", "src/local.ts");
    useReviewAnnotations.setState({
      bySession: {
        a: [{
          id: "n-edit-race",
          lineKey: "snap-local-1:new:10",
          sessionId: "a",
          snapshotId: "snap-local-1",
          path: "src/local.ts",
          side: "new",
          line: 10,
          lineType: "context",
          code: "const x = 1;",
          note: "旧批注内容",
          createdAt: 1,
        }],
      },
      sendingBySession: {},
    });
    useAppStore.setState({
      sessions,
      activeSessionId: "a",
      workPanelOpen: false,
      workPanelTabs: [],
    });
    flushSync(() =>
      subRoot.render(
        <SlotSessionProvider sessionId="a">
          <ReviewChangeCard message={localDiffMessage} asToolRow openRequest={1} />
          <ChatReviewBatchDock sessionId="a" />
        </SlotSessionProvider>,
      ),
    );
    await settle();
    check(Boolean(host.querySelector(".mc-chat-review-batch-dock .mc-review-batch-bar")), "ChatReviewBatchDock visible when WorkPanel is closed");

    // Open Edit on the saved annotation, type new draft, then simulate in-flight send pruneSent deleting `n-edit-race`:
    const editBtn = [...host.querySelectorAll(".mc-diff-annotation-card-actions button")][0];
    check(editBtn, "saved annotation card renders Edit button");
    flushSync(() => editBtn.click());
    await settle();
    const noteTextarea = host.querySelector(".mc-diff-annotation-input");
    check(noteTextarea, "annotation editor textarea opened");
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(noteTextarea, "正在重新输入的草稿");
    noteTextarea.dispatchEvent(new Event("input", { bubbles: true }));
    await settle();
    flushSync(() => {
      useReviewAnnotations.getState().pruneSent("a", [{ id: "n-edit-race", lineKey: "snap-local-1:new:10", note: "旧批注内容" }]);
    });
    await settle();
    check(
      host.querySelector(".mc-diff-annotation-input")?.value === "正在重新输入的草稿",
      "in-flight pruneSent must not clear active re-edit textarea draft",
    );

    // Save the new draft and verify ChatReviewBatchDock hides once WorkPanel opens Review tab for session "a":
    flushSync(() => {
      useReviewAnnotations.getState().upsert({
        lineKey: "snap-local-1:new:10",
        sessionId: "a",
        snapshotId: "snap-local-1",
        path: "src/local.ts",
        side: "new",
        line: 10,
        lineType: "context",
        code: "const x = 1;",
        note: "正在重新输入的草稿",
      });
      useAppStore.setState({
        workPanelOpen: true,
        workPanelTabs: [{ id: "review", kind: "review" }],
      });
    });
    await settle();
    check(!host.querySelector(".mc-chat-review-batch-dock"), "ChatReviewBatchDock hides when active session Review pane is open");

    // 6. R37 UX: Left-gutter button sits before `.diff-line-text`, supports Shift+Click multi-line range (`L10–L11`),
    //    and `ReviewHistoryFile` "已阅" button auto-collapses an open file while updating `ReviewHistoryToolbar` progress.
    const gutterBtns = [...host.querySelectorAll(".mc-diff-annotate-btn")];
    check(gutterBtns.length === 2, "each diff line renders its left-gutter bubble button");
    check(
      gutterBtns[0].nextElementSibling?.classList.contains("diff-line-text"),
      "annotate bubble button sits in the left gutter right before code text",
    );
    flushSync(() => gutterBtns[0].click()); // anchor at L10 (and closes or opens L10)
    await settle();
    if (!host.querySelector(".mc-diff-annotation-input")) {
      flushSync(() => gutterBtns[0].click());
      await settle();
    }
    flushSync(() => {
      gutterBtns[1].dispatchEvent(new MouseEvent("click", { bubbles: true, shiftKey: true }));
    });
    await settle();
    check(
      host.querySelector(".mc-diff-annotation-line-pill")?.textContent === "L10–L11",
      "Shift+Click selects multi-line range L10–L11",
    );
    // Reverse Shift+Click: click L11 first to anchor at bottom, then Shift+Click L10 upward -> still selects L10–L11!
    flushSync(() => gutterBtns[1].click());
    await settle();
    if (!host.querySelector(".mc-diff-annotation-input")) {
      flushSync(() => gutterBtns[1].click());
      await settle();
    }
    flushSync(() => {
      gutterBtns[0].dispatchEvent(new MouseEvent("click", { bubbles: true, shiftKey: true }));
    });
    await settle();
    check(
      host.querySelector(".mc-diff-annotation-line-pill")?.textContent === "L10–L11",
      "Reverse Shift+Click (L11 -> Shift+L10) selects multi-line range L10–L11",
    );
    check(
      host.querySelectorAll(".diff-line.is-in-range").length === 2,
      "Reverse Shift+Click highlights both L10 and L11 in range",
    );

    const fileGroup = {
      id: "workspace:src/local.ts",
      path: "src/local.ts",
      additions: 1,
      deletions: 0,
      entries: [{ message: localDiffMessage, change: localDiffMessage.toolResult.details.review }],
    };
    flushSync(() =>
      subRoot.render(
        <div>
          <ReviewHistoryToolbar
            history={false}
            onHistory={() => {}}
            count={2}
            additions={4}
            deletions={1}
            context={3}
            onContext={() => {}}
            wrap={true}
            onWrap={() => {}}
            reviewedCount={0}
            showAnnotateHint={true}
          />
          <ReviewHistoryFile
            file={fileGroup}
            sessionId="a"
            context={3}
            disabled={false}
            onChanged={() => {}}
          />
        </div>,
      ),
    );
    await settle();
    check(host.querySelector(".mc-review-progress-pill")?.textContent.includes("已阅 0/2"), "toolbar displays Viewed 0/2 progress");
    check(host.querySelector(".mc-review-toolbar-hint")?.textContent.includes("气泡"), "toolbar displays hover bubble hint when 0 notes");
    // Open file, then click "已阅" -> file auto-collapses and aria-pressed becomes "true"!
    flushSync(() => host.querySelector(".review-history-file-header").click());
    await settle();
    check(host.querySelector(".review-history-file.open"), "file expanded before clicking Viewed");
    const viewedBtn = host.querySelector(".mc-review-viewed-btn");
    check(viewedBtn?.getAttribute("aria-pressed") === "false", "Viewed button starts unpressed");
    flushSync(() => viewedBtn.click());
    await settle();
    check(!host.querySelector(".review-history-file.open"), "clicking Viewed auto-collapses open file");
    check(host.querySelector(".mc-review-viewed-btn")?.getAttribute("aria-pressed") === "true", "Viewed button updates aria-pressed=true");
  } finally {
    api.workspaceReviewContext = prevContextApi;
    flushSync(() => subRoot.unmount());
    host.remove();
    useReviewAnnotations.setState({ bySession: {}, sendingBySession: {}, reviewedBySession: {} });
    useAttentionStore.setState({ unreadCompleted: {} });
    useAppStore.setState({
      sessions: prevState.sessions,
      activeSessionId: prevState.activeSessionId,
      page: prevState.page,
      messages: prevState.messages,
      pendingPlans: prevState.pendingPlans,
      pendingPermissions: prevState.pendingPermissions,
      sessionOutcomes: prevState.sessionOutcomes,
      sendPrompt: prevState.sendPrompt,
      selectSession: prevState.selectSession,
      showToast: prevState.showToast,
      workPanelOpen: prevState.workPanelOpen,
      workPanelTabs: prevState.workPanelTabs,
      acknowledgeSessionOutcome: prevState.acknowledgeSessionOutcome,
    });
  }
}

window.usabilityProbe = async () => {
  await settle();
  const initialStoredTabs = JSON.parse(localStorage.getItem("mc.sessionTabs") ?? "[]");
  check(!initialStoredTabs.includes("page:creative") && !tab("page:creative"), "legacy page:creative tab must be pruned on load");
  await select("b"); await settle(); await select("c"); await settle(); await select("a"); await settle();
  await menu("b"); await action("置顶"); check(pins[0] === "b", "pin must target clicked tab");
  await menu("b"); await action("重命名任务");
  const input = document.querySelector("#session-rename-input");
  check(input, "rename dialog");
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, "新的标题");
  input.dispatchEvent(new Event("input", { bubbles: true })); await settle();
  input.closest("form").dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); await settle();
  check(renames[0]?.id === "b", "rename target");
  check(renames[0]?.title === "新的标题", "rename value");
  await menu("b"); await action("向左移动标签"); check(tabs()[0] === "b", "move left");
  setSplitColumns(["a", "b", "c"]);
  await menu("b"); await action("关闭其他标签");
  check(tabs().join() === "b" && useAppStore.getState().activeSessionId === "b", "batch close focus");
  check(useSplitView.getState().columns.length === 0, "closed split columns");
  check(useAppStore.getState().runningSessions.c && useAppStore.getState().sessions.length === 3, "close must retain tasks");
  await select("a"); await settle(); await select("c"); await settle();
  await menu("a"); await action("关闭右侧标签");
  check(tabs().join() === "b,a" && useAppStore.getState().activeSessionId === "a", "close right");
  for (const page of ["settings", "scheduled", "plugins"]) {
    useAppStore.setState({ page }); await settle();
    check(tabs().join() === "b,a", "rail page added a tab: " + page);
    check(!document.querySelector('[role="tab"][aria-selected="true"]'), "rail page highlights a conversation tab");
  }
  useAppStore.setState({ page: "chat" }); await settle();
  await menu("a");
  await action("关闭全部标签"); check(tabs().length === 0, "close all");
  await select("a"); await settle();
  const images = [1, 2].map((i) => ({ id: "image-" + i, path: "/image" + i + ".png", name: "图片 " + i + ".png", kind: "image", mimeType: "image/png", sessionId: "a", token: String.fromCharCode(0xe000 + i) }));
  flushSync(() => draft.applyEditorDraft("请看图片" + images.map((r) => r.token).join(""), images));
  await until(() => document.querySelectorAll(".composer-image-thumbnail img").length === 2, "inline thumbnails");
  const thumbnails = [...document.querySelectorAll(".composer-image-thumbnail img")];
  await Promise.all(thumbnails.map((img) => img.decode()));
  check(thumbnails.every((img) => img.getBoundingClientRect().height > 50), "thumbnails visible without hover");
  const previewButton = document.querySelector(".composer-image-thumbnail-open");
  previewButton.focus(); previewButton.click();
  await until(() => document.querySelector("dialog[open]"), "preview modal");
  document.querySelector("dialog").dispatchEvent(new Event("cancel", { cancelable: true })); await settle();
  check(document.activeElement === previewButton, "preview restores thumbnail focus");
  blocked = true; render(); check(document.querySelector(".composer-image-thumbnail-remove").disabled, "blocked deletion");
  blocked = false; render();
  document.querySelector(".composer-image-thumbnail-remove").click(); await settle();
  check(document.querySelectorAll(".composer-image-thumbnail img").length === 1, "remove thumbnail");
  check(!readEditorValue(draft.ref.current).includes(images[0].token), "remove must clear token");
  check(readEditorValue(draft.ref.current).includes(images[1].token), "other image retained");
  const delayed = { ...images[0], id: "pending", path: "/pending.png" };
  flushSync(() => draft.applyEditorDraft(delayed.token, [delayed]));
  await until(() => pending, "pending image read");
  await select("b"); await settle(); pending({ kind: "image", dataUrl: src }); await settle();
  check(!document.querySelector(".composer-image-thumbnail"), "late image leaked into another session");
  await select("a"); await settle();
  check(draft.value.includes(delayed.token), "restore image draft after switching back");
  const retryImage = { ...images[0], id: "retry", path: "/retry.png" };
  flushSync(() => draft.applyEditorDraft(retryImage.token, [retryImage]));
  await until(() => document.querySelector(".composer-image-thumbnail-open")?.textContent.includes("重试"), "failed image status");
  document.querySelector(".composer-image-thumbnail-open").click();
  await until(() => document.querySelector(".composer-image-thumbnail img"), "retry image");
  check(retryReads === 2, "retry authorized image read");
  flushSync(() => draft.applyEditorDraft("对照这两张图片" + images.map((r) => r.token).join(""), images));
  await until(() => document.querySelectorAll(".composer-image-thumbnail img").length === 2, "final screenshot");
  await menu("a");
  await checkNoticeCards();
  await checkCurrentContext();
  await checkFastMode();
  await checkBuiltinPrompt();
  await checkSplitPaneAnnotationIsolation();
  await checkRound2ReviewAndAttentionEdgeCases();
  return { passed: true, thumbnails: 2, tabs: tabs() };
};
