import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import { catalogs, flattenCatalog } from "@pi-desktop/i18n";
import { SessionTabs } from "../../src/features/session-tabs/SessionTabs";
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
window.usabilityProbe = async () => {
  await settle(); await select("b"); await settle(); await select("c"); await settle(); await select("a"); await settle();
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
  useAppStore.setState({ page: "settings" }); await settle();
  await menu("page:settings");
  check(!document.querySelector('[role="menu"]').textContent.includes("重命名任务"), "page menu must omit session actions");
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
  return { passed: true, thumbnails: 2, tabs: tabs() };
};
