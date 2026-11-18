import React from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import { catalogs, flattenCatalog } from "@pi-desktop/i18n";
import { Sidebar } from "../../apps/desktop/src/components/Sidebar";
import { ConversationTopbar } from "../../apps/desktop/src/components/ConversationTopbar";
import { SessionInfo } from "../../apps/desktop/src/features/session-info/SessionInfo";
import { toggleSessionInfoOpenForSession } from "../../apps/desktop/src/features/session-info/session-info-model";
import { SubagentTopology } from "../../apps/desktop/src/features/chat/transcript/SubagentDetail";
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
  if (method.endsWith("updates/getState")) return { ok: true, data: { availableVersion: "9.9.9", selfInstall: true, status: "available" } };
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
  const [sbWidth, setSbWidth] = React.useState(280);
  window.setHover = setHover;
  window.setSbWidth = setSbWidth;
  return <div className="app-shell" style={{"--ds-sidebar-width":`${sbWidth}px`}}>
    <div className="app-chat-shell"><Sidebar sidebarWidth={sbWidth} sidebarToggleShortcut="" onToggleSidebar={() => {}} onWidthChange={setSbWidth} onWidthCommit={setSbWidth} onResizeCollapse={() => {}} />
      <main className="main-pane"><ConversationTopbar sidebarCollapsed={false} workPanelOpen={false}
        onToggleSidebar={() => {}} onNewTask={() => useAppStore.setState({activeSessionId:null})} onOpenSearch={() => {}} />
        <SessionInfo />
        <div className="chat-surface" /></main>
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
    check(!document.querySelector('[data-tab-key="page:creative"]') && !saved().includes("page:creative"), "legacy creative page tab is pruned from storage and DOM");
    // Unstarted empty session s17 hides SessionInfo and reserves zero left margin on .chat-surface.
    const mainPaneEl = document.querySelector(".main-pane");
    const chatSurfaceEl = document.querySelector(".chat-surface");
    check(!document.querySelector(".mc-session-info"), "unstarted empty session hides SessionInfo");
    check(getComputedStyle(chatSurfaceEl).paddingLeft === "0px", "unstarted empty session leaves zero left padding on .chat-surface");
    useAppStore.setState({
      messages: [{ id: "m1", role: "user", content: "start chat", createdAt: "2026-11-18T00:00:00Z" }],
    });
    await settle();
    check(Boolean(document.querySelector(".mc-session-info")), "starting conversation mounts SessionInfo");
    check(
      document.querySelector(".mc-session-info-trigger")?.getAttribute("title")?.includes("(⌘I)"),
      "SessionInfo trigger tooltip advertises ⌘I shortcut on macOS",
    );
    flushSync(() => toggleSessionInfoOpenForSession("s17"));
    await settle();
    check(
      document.querySelector(".mc-session-info")?.classList.contains("is-open") &&
        document.querySelector(".mc-session-info-trigger")?.getAttribute("aria-expanded") === "true",
      "toggleSessionInfo shortcut action opens SessionInfo",
    );
    flushSync(() => toggleSessionInfoOpenForSession("s17"));
    await settle();
    check(
      !document.querySelector(".mc-session-info")?.classList.contains("is-open") &&
        document.querySelector(".mc-session-info-trigger")?.getAttribute("aria-expanded") === "false",
      "toggleSessionInfo shortcut action collapses SessionInfo",
    );
    check(
      Number.parseFloat(getComputedStyle(chatSurfaceEl).paddingLeft) > 0,
      "started conversation applies SessionInfo left gutter on narrow pane",
    );
    useAppStore.setState({
      messages: [],
      sessionHistory: { s17: { messageStart: 0, hasMoreBefore: false } },
    });
    await settle();
    check(!document.querySelector(".mc-session-info"), "returning to empty session unmounts SessionInfo");
    check(
      mainPaneEl.style.getPropertyValue("--mc-info-gutter") === "" &&
        mainPaneEl.style.getPropertyValue("--mc-info-offset") === "" &&
        getComputedStyle(chatSurfaceEl).paddingLeft === "0px",
      "unmounting SessionInfo clears --mc-info-gutter/--mc-info-offset and restores symmetric 0px paddingLeft",
    );
    // Settings / slot pages remove the sidebar collapse button from the header and restore it on chat.
    check(Boolean(document.querySelector('.sidebar-header-actions [data-nav="toggle-sidebar"]')), "chat page renders sidebar collapse button");
    for (const pinnedPage of ["settings", "plugins", "scheduled"]) {
      useAppStore.setState({ page: pinnedPage });
      await settle();
      check(!document.querySelector('.sidebar-header-actions [data-nav="toggle-sidebar"]'), `${pinnedPage} hides sidebar collapse button`);
    }
    useAppStore.setState({ page: "chat" });
    await settle();
    check(Boolean(document.querySelector('.sidebar-header-actions [data-nav="toggle-sidebar"]')), "returning to chat restores sidebar collapse button");
    // Subagent topology connectors align without dangling stubs in both wide (>520px) and stacked (<=520px) widths.
    const topoHost = document.createElement("div");
    chatSurfaceEl.appendChild(topoHost);
    const topoRoot = createRoot(topoHost);
    const mkTask = (id, summary) => ({
      kind: "tool",
      message: {
        id: `task-${id}`,
        role: "tool",
        content: "",
        createdAt: "2026-11-18T00:00:00Z",
        toolName: "Task",
        toolCallId: `call-${id}`,
        toolStatus: "running",
        toolArgs: { agent: "explorer", task: summary },
        toolResult: { details: { delegationId: id, agent: "explorer", status: "running", modelId: "gpt-6.2-sol", thinkingLevel: "medium" } },
      },
    });
    const renderTopo = async (width, items) => {
      flushSync(() =>
        topoRoot.render(
          <div className="tool-activity-group has-subagents open" style={{ width: `${width}px` }}>
            <SubagentTopology items={items} />
          </div>,
        ),
      );
      await settle();
    };
    await renderTopo(680, [mkTask("only", "Inspect single subagent card")]);
    {
      const conn = topoHost.querySelector(".subagent-topology-connector");
      const node = topoHost.querySelector(".subagent-topology-node");
      const before = getComputedStyle(node, "::before");
      const after = getComputedStyle(node, "::after");
      check(after.content === "none", `wide 1-subagent hides vertical spine, got ${after.content}`);
      const connY = conn.getBoundingClientRect().top;
      const branchY = node.getBoundingClientRect().top + Number.parseFloat(before.top);
      check(Math.abs(connY - branchY) <= 1, `wide 1-subagent straight line mismatch: ${connY} vs ${branchY}`);
    }
    await renderTopo(680, [
      mkTask("a", "Check Claude Code diff across multiple lines of summary text to make card taller"),
      mkTask("b", "Compare Codex CLI source"),
    ]);
    {
      const agents = topoHost.querySelector(".subagent-topology-agents");
      check(getComputedStyle(agents, "::before").content === "none", "legacy container spine disabled");
      const nodes = [...topoHost.querySelectorAll(".subagent-topology-node")];
      const firstBefore = getComputedStyle(nodes[0], "::before");
      const firstAfter = getComputedStyle(nodes[0], "::after");
      check(Math.abs(Number.parseFloat(firstAfter.top) - Number.parseFloat(firstBefore.top)) <= 0.5, "wide first node spine starts at branch");
      const lastRect = nodes[1].getBoundingClientRect();
      const lastBefore = getComputedStyle(nodes[1], "::before");
      const lastAfter = getComputedStyle(nodes[1], "::after");
      const spineEnd = lastRect.height - Number.parseFloat(lastAfter.bottom);
      const branchEnd = Number.parseFloat(lastBefore.top) + Number.parseFloat(lastBefore.height);
      check(Math.abs(spineEnd - branchEnd) <= 0.5, `wide last node spine overshoots branch: ${spineEnd} vs ${branchEnd}`);
    }
    for (const items of [
      [mkTask("only", "Compare Claude Desktop archive")],
      [mkTask("a", "Check Claude Code diff"), mkTask("b", "Compare Codex CLI source")],
    ]) {
      await renderTopo(440, items);
      const conn = topoHost.querySelector(".subagent-topology-connector");
      const agents = topoHost.querySelector(".subagent-topology-agents");
      const nodes = [...topoHost.querySelectorAll(".subagent-topology-node")];
      const firstAfter = getComputedStyle(nodes[0], "::after");
      const connLeft = Number.parseFloat(getComputedStyle(conn).marginLeft);
      const spineLeft =
        Number.parseFloat(getComputedStyle(agents).paddingLeft) +
        nodes[0].offsetWidth -
        Number.parseFloat(firstAfter.right) -
        Number.parseFloat(firstAfter.width);
      check(Math.abs(connLeft - spineLeft) <= 0.5, `stacked trunk x mismatch: connector=${connLeft} vs spine=${spineLeft}`);
      check(Number.parseFloat(firstAfter.top) === 0, `stacked first spine must touch connector at top=0, got ${firstAfter.top}`);
      const last = nodes[nodes.length - 1];
      const lastRect = last.getBoundingClientRect();
      const lastBefore = getComputedStyle(last, "::before");
      const lastAfter = getComputedStyle(last, "::after");
      const spineEnd = lastRect.height - Number.parseFloat(lastAfter.bottom);
      const branchEnd = Number.parseFloat(lastBefore.top) + Number.parseFloat(lastBefore.height);
      check(Math.abs(spineEnd - branchEnd) <= 0.5, `stacked last node spine overshoots branch: ${spineEnd} vs ${branchEnd}`);
    }
    flushSync(() => topoRoot.unmount());
    topoHost.remove();
    // Narrow 240px sidebar with 4 plugin views + update + settings: nothing clips outside sidebar.
    flushSync(() => {
      window.setSbWidth(240);
      useAppStore.setState({
        pluginViews: [1, 2, 3, 4].map((n) => ({
          ref: `fixture.p${n}/panel`,
          pluginId: `fixture.p${n}`,
          pluginName: `Plugin ${n}`,
          viewId: "panel",
          title: `插件 ${n}`,
        })),
      });
    });
    await settle();
    const sidebarEl = document.querySelector(".sidebar");
    const sbRect = sidebarEl.getBoundingClientRect();
    check(Math.round(sbRect.width) === 240, `sidebar width expected 240, got ${sbRect.width}`);
    for (const sel of [
      '[data-nav="rail-home"]',
      '[data-nav="plugins"]',
      '[data-nav="scheduled"]',
      '[data-nav="rail-view:fixture.p1/panel"]',
      '[data-nav="rail-view:fixture.p2/panel"]',
      '[data-nav="rail-view:fixture.p3/panel"]',
      '[data-nav="rail-view:fixture.p4/panel"]',
      '[data-nav="update"]',
      '[data-nav="settings"]',
    ]) {
      const btn = sidebarEl.querySelector(sel);
      check(btn, `missing footer button ${sel}`);
      const r = btn.getBoundingClientRect();
      check(r.width >= 24 && r.height >= 24, `footer button ${sel} shrunk too small: ${r.width}x${r.height}`);
      check(r.left >= sbRect.left - 1 && r.right <= sbRect.right + 1, `footer button ${sel} clipped outside 240px sidebar (${r.left}..${r.right} vs ${sbRect.left}..${sbRect.right})`);
    }
    flushSync(() => {
      window.setSbWidth(280);
      useAppStore.setState({ pluginViews: [] });
    });
    await settle();
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
    const alpha = document.querySelector('[data-project-tab="project:alpha"]');
    const beta = document.querySelector('[data-project-tab="path:/beta"]');
    const aRect = alpha.getBoundingClientRect();
    const bRect = beta.getBoundingClientRect();
    alpha.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0, pointerId: 1, clientX: aRect.left + aRect.width / 2, clientY: aRect.top + aRect.height / 2 }));
    alpha.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, pointerId: 1, clientX: bRect.right - 2, clientY: bRect.top + bRect.height / 2 }));
    await settle();
    check(alpha.classList.contains("is-dragging"), "dragged project tab marks itself dragging");
    check(beta.classList.contains("is-drop-after"), "target project tab marks drop position");
    check(!useSplitView.getState().dropHint, "dragging a group never activates split drop hint");
    alpha.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerId: 1, clientX: bRect.right - 2, clientY: bRect.top + bRect.height / 2 }));
    alpha.click();
    await settle();
    check(!document.querySelector(".mc-tab-list-menu"), "releasing a dragged group does not open dropdown");
    check([...document.querySelectorAll("[data-project-tab]")].map((el) => el.dataset.projectTab).join(",") === "path:/beta,project:alpha,ungrouped", "project group reorders past neighbour");
    useAppStore.setState({ activeSessionId: "s16", runningSessions: { s0: true, s16: true } }); await settle();
    document.querySelector('[data-project-tab="ungrouped"]').dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 240, clientY: 20 }));
    await settle();
    check(Boolean(document.querySelector('[data-context-menu-item="close-group"]')) && !nativeVisible, "group context menu offers close-group and blocks native view");
    await click('[data-context-menu-item="close-group"]');
    check(!document.querySelector('[data-project-tab="ungrouped"]'), "closing group removes project pill");
    check(!saved().includes("s16") && !saved().includes("s17"), "closing group removes all member tabs");
    check(useAppStore.getState().runningSessions.s16 === true, "closing group keeps running tasks");
    check(useAppStore.getState().page === "chat" && useAppStore.getState().activeSessionId === "s6", "closing active group focuses surviving neighbour");
    check(nativeVisible, "closing group restores native view");
    await click('[data-project-tab="project:alpha"]');
    await click('[data-menu-tab="s1"] .mc-tab-menu-select');
  } else if (stage === "wide") {
    check(document.querySelectorAll("[data-project-tab]").length === 0, "wide layout restores individual tabs");
    check(document.querySelectorAll("[data-tab-key]").length === saved().length, "all tabs remain");
  } else if (stage === "many-projects") {
    useAppStore.setState({sessions: sessions.map((s,i)=>({...s,projectPath:`/project-${i}`}))}); await settle();
    const strip=document.querySelector(".mc-session-tabs"); strip.scrollLeft=strip.scrollWidth; await settle();
    check(strip.scrollLeft>0,"many projects really scroll");
    const viewport = document.querySelector(".mc-session-tabs-viewport");
    strip.scrollLeft = 0; await settle();
    const wheelRight = new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaX: 0, deltaY: 160, deltaMode: 0 });
    viewport.dispatchEvent(wheelRight); await settle();
    check(wheelRight.defaultPrevented && strip.scrollLeft > 0, "vertical mouse wheel scrolls overflowing group tabs horizontally");
    const scrolledLeft = strip.scrollLeft;
    useAppStore.setState((state) => ({
      sessions: state.sessions.map((item) => ({ ...item, updatedAt: "2026-11-16T12:00:00Z" })),
    }));
    await settle();
    check(strip.scrollLeft === scrolledLeft, "background session updates preserve manual wheel scroll");
    const wheelLeft = new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaX: 0, deltaY: -scrolledLeft, deltaMode: 0 });
    viewport.dispatchEvent(wheelLeft); await settle();
    check(strip.scrollLeft === 0, "upward wheel scrolls group tabs back to start");
    const trackpadWheel = new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaX: 80, deltaY: 10, deltaMode: 0 });
    viewport.dispatchEvent(trackpadWheel);
    check(!trackpadWheel.defaultPrevented, "horizontal trackpad gesture passes through natively");
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
