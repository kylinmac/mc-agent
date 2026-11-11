import React from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import { catalogs, flattenCatalog } from "@pi-desktop/i18n";
import { AppRail } from "../../apps/desktop/src/features/app-rail/AppRail";
import { Sidebar } from "../../apps/desktop/src/components/Sidebar";
import { ConversationTopbar } from "../../apps/desktop/src/components/ConversationTopbar";
import { SessionHoverCard } from "../../apps/desktop/src/features/sessions/SessionHoverCard";
import { PluginViewTab } from "../../apps/desktop/src/components/workpanel/PluginViewTab";
import { useBlockingOverlayActive } from "../../apps/desktop/src/lib/blocking-overlay";
import { useAppStore } from "../../apps/desktop/src/stores/app-store";
import { setSplitColumns, useSplitView } from "../../apps/desktop/src/lib/mc-split-view";

await i18n.use(initReactI18next).init({ lng: "zh-CN", keySeparator: false,
  resources: { "zh-CN": { translation: flattenCatalog(catalogs["zh-CN"]) } } });
const sessions = Array.from({ length: 18 }, (_, i) => ({ id: `s${i}`, title: `会话 ${i}：检查项目标签和窗口拖动`,
  projectPath: i < 8 ? (i % 2 ? "/alpha/code" : "/alpha/resources") : i < 16 ? "/beta" : undefined,
  createdAt: "2026-11-11T00:00:00Z", updatedAt: "2026-11-11T00:00:00Z", mode: "agent", permissionMode: "auto", messageCount: 0 }));
let nativeVisible = false;
window.piDesktop = { platform: "darwin", on() { return () => {}; }, async invoke(method, args) {
  if (method.endsWith("project-group/list")) return { ok: true, data: { groups: [{ id: "alpha", name: "Alpha 项目", roots: [
    { path: "/alpha/code", kind: "workspace" }, { path: "/alpha/resources", kind: "resources" },
  ] }] } };
  if (method.endsWith("missing-folders")) return { ok: true, data: { folders: [] } };
  if (method.endsWith("/setVisible")) nativeVisible = args.visible;
  return { ok: true, data: { sessions: [], notifications: [], groups: [], folders: [] } };
} };
const selectSession = async (id) => { useAppStore.setState({ activeSessionId: id, page: "chat" }); };
useAppStore.setState({ sessions, activeSessionId: "s17", page: "chat", selectSession,
  runningSessions: { s0: true }, refreshSessions: async () => {}, refreshNotifications: async () => {},
  setPage: (page) => useAppStore.setState({ page }) });
function NativePanel() {
  const blocked = useBlockingOverlayActive();
  return <div style={{position:"absolute",left:350,top:240,width:500,height:360}}>
    <PluginViewTab pluginId="fixture" viewId="files" title="Files" blocked={blocked} />
  </div>;
}
function Surface() {
  const [hover, setHover] = React.useState(false);
  window.setHover = setHover;
  return <div className="app-shell" style={{"--ds-sidebar-width":"280px"}}>
    <div className="app-chat-shell"><AppRail /><Sidebar onToggleSidebar={() => {}} />
      <main className="main-pane"><ConversationTopbar sidebarCollapsed={false} workPanelOpen={false}
        onToggleSidebar={() => {}} onNewTask={() => useAppStore.setState({activeSessionId:null})} onOpenSearch={() => {}} /></main>
    </div>
    <NativePanel />
    {hover && <SessionHoverCard card={{ session:sessions[0], target:document.querySelector(".sidebar-header"), space:"Alpha", temporary:true }}
      runningSessions={{}} pendingPermissions={{}} refreshProject={async () => null} onOpenSession={selectSession}
      keepVisible={() => {}} scheduleHide={() => {}} registerDismissGuard={() => () => {}} />}
  </div>;
}
flushSync(() => createRoot(document.getElementById("root")).render(<Surface />));
const frame = () => new Promise(requestAnimationFrame);
const settle = async () => { for (let i=0;i<8;i++) await frame(); };
const check = (ok, message) => { if (!ok) throw new Error(message); };
const saved = () => JSON.parse(localStorage.getItem("mc.sessionTabs"));
const click = async (selector) => { const el=document.querySelector(selector); check(el, `Missing ${selector}`); el.click(); await settle(); };
window.tabProbe = async (stage) => {
  await settle();
  if (stage === "narrow") {
    check(document.querySelectorAll("[data-project-tab]").length === 3, "merge multi-folder, folder and ungrouped sessions");
    check(document.querySelector('[data-tab-key="page:creative"]'), "creative stays independent");
    await click('[data-project-tab="project:alpha"]');
    check(document.querySelectorAll("[data-menu-tab]").length === 8, "project lists all eight sessions");
    check(!nativeVisible, "dropdown blocks native view");
    document.querySelector(".mc-tab-menu-select").dispatchEvent(new KeyboardEvent("keydown", {key:"End",bubbles:true}));
    check(document.activeElement.closest("[data-menu-tab]").dataset.menuTab === "s7", "End focuses last row");
    await click('[data-menu-tab="s7"] .mc-tab-menu-select');
    check(useAppStore.getState().activeSessionId === "s7", "select session from project");
    check(nativeVisible, "native view restored after selection");
    await click('[data-project-tab="project:alpha"]');
    await click('[data-menu-tab="s0"] .mc-tab-menu-close');
    check(!saved().includes("s0") && useAppStore.getState().runningSessions.s0, "closing preserves running task");
    check(document.querySelectorAll("[data-menu-tab]").length === 7, "menu updates after close");
    document.querySelector('[data-menu-tab="s7"]').dispatchEvent(new MouseEvent("contextmenu",{bubbles:true})); await settle();
    check(document.querySelector(".context-menu") && !nativeVisible, "row context menu retains native view blocking");
    document.activeElement.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true})); await settle();
    await click('[data-project-tab="project:alpha"]');
    await click('[data-menu-tab="s7"] .mc-tab-menu-close');
    check(useAppStore.getState().activeSessionId === "s8", "active close chooses neighbour across projects");
    window.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true})); await settle();
    check(!document.querySelector(".mc-tab-list-menu"), "Escape closes list");
    check(nativeVisible, "Escape restores native view");
    flushSync(()=>window.setHover(true)); await settle();
    check(!nativeVisible, "hover card blocks native view");
    await click(".mc-session-tab-overflow");
    flushSync(()=>window.setHover(false)); await settle();
    check(!nativeVisible, "closing hover preserves another overlay owner");
    window.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true})); await settle();
    check(nativeVisible, "last overlay restores native view");
  } else if (stage === "wide") {
    check(document.querySelectorAll("[data-project-tab]").length === 0, "wide layout restores individual tabs");
    check(document.querySelectorAll("[data-tab-key]").length === saved().length, "all tabs remain");
  } else if (stage === "many-projects") {
    useAppStore.setState({sessions: sessions.map((s,i)=>({...s,projectPath:`/project-${i}`}))}); await settle();
    const strip=document.querySelector(".mc-session-tabs"); strip.scrollLeft=strip.scrollWidth; await settle();
    check(strip.scrollLeft>0,"many projects really scroll");
    check(getComputedStyle(strip).webkitAppRegion === "no-drag", "visible viewport excludes native drag");
    check([...strip.querySelectorAll("*")].every(el=>getComputedStyle(el).webkitAppRegion === "none"), "no child exclusions escape clipping");
    check(getComputedStyle(document.querySelector(".sidebar-header")).webkitAppRegion === "drag", "sidebar caption remains draggable");
    await click(".mc-session-tab-overflow");
    check(document.querySelectorAll("[data-menu-tab]").length === saved().length, "all menu reaches scrolled-out projects");
    setSplitColumns(["s1","s2"]); useAppStore.setState({activeSessionId:"s1"}); await settle();
    await click('[data-menu-tab="s1"] .mc-tab-menu-close');
    check(!useSplitView.getState().columns.includes("s1"), "close removes split column");
    check(!saved().includes("s1"), "split close removes tab");
    document.body.dispatchEvent(new MouseEvent("mousedown",{bubbles:true})); await settle();
    check(!document.querySelector(".mc-tab-list-menu"), "outside press closes list");
  }
  return {stage, tabs:saved().length, groups:document.querySelectorAll("[data-project-tab]").length};
};
