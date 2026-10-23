// Isolated renderer fixture: real rail, search dialog and toolbar, mocked IPC.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { repositoryRoot, resolveElectronBinary } from "./e2e/boot.mjs";
import { loadStyles } from "../apps/desktop/test/helpers/styles.mjs";

const root = repositoryRoot();
const { build } = createRequire(join(root, "packages/agent-runtime/package.json"))("esbuild");
const dir = await mkdtemp(join(tmpdir(), "mc-titlebar-click-"));
const manual = process.argv.includes("--manual");
const fixture = `
import React from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import { catalogs, flattenCatalog } from "@pi-desktop/i18n";
import { WindowsTitlebarActions } from "../../apps/desktop/src/features/app-rail/WindowsTitlebarActions";
import { AppRail } from "../../apps/desktop/src/features/app-rail/AppRail";
import { SearchDialog } from "../../apps/desktop/src/components/SearchDialog";
import { ConversationTopbar } from "../../apps/desktop/src/components/ConversationTopbar";
import { useAppStore } from "../../apps/desktop/src/stores/app-store";
await i18n.use(initReactI18next).init({ lng: "zh-CN", keySeparator: false,
 resources: { "zh-CN": { translation: flattenCatalog(catalogs["zh-CN"]) } } });
window.piDesktop = { platform: "win32", on() { return () => {}; }, async invoke() {
 return { hits: [], nextOffset: null, commands: [], sessions: [], notifications: [] };
} };
useAppStore.setState({page: "plugins", refreshSessions: async () => {}, refreshNotifications: async () => {}});
function Surface() {
 const [collapsed, setCollapsed] = React.useState(false);
 const [open, setOpen] = React.useState(false);
 const page = useAppStore(s => s.page);
 return <div className={"app-shell" + (collapsed ? " sidebar-collapsed" : "")} style={{"--ds-sidebar-width":"280px"}}>
  <div className="app-chat-shell">
   <AppRail />
   {!collapsed && <aside className="sidebar sidebar-surface"><div className="sidebar-header"><button className="brand">mc-agent</button></div><div className="sidebar-body">会话列表</div></aside>}
   <main className="main-pane"><ConversationTopbar sidebarCollapsed={collapsed} workPanelOpen={false}
    onToggleSidebar={() => setCollapsed(!collapsed)} onNewTask={() => {}} onOpenSearch={() => setOpen(true)} />
    <p style={{marginTop:80}}>独立测试窗口 · 当前页面：{page}</p>
   </main>
   <WindowsTitlebarActions collapsed={collapsed} onToggleSidebar={() => setCollapsed(!collapsed)} onOpenSearch={() => setOpen(true)} />
  </div>
  <SearchDialog open={open} onClose={() => setOpen(false)} />
 </div>;
}
flushSync(() => createRoot(document.getElementById("root")).render(<Surface />));
const frame = () => new Promise(requestAnimationFrame);
const check = (ok, message) => { if (!ok) throw new Error(message); };
window.titlebarProbe = async () => {
 await frame(); await frame();
 check(document.querySelector('[data-nav="rail-home"]'), "Rail missing: " + document.body.innerHTML);
 check(document.querySelector('[data-nav="rail-home"]').getBoundingClientRect().width > 0, "Home must remain visible");
 check(document.querySelector('.sidebar-header .brand').getBoundingClientRect().width === 0, "Brand must be hidden");
 const results=[];
 for (const collapsed of [false,true]) {
  if (collapsed) flushSync(() => document.querySelector('.mc-windows-titlebar-actions [data-nav="toggle-sidebar"]').click());
  await frame(); await frame();
  const search=document.querySelector('.mc-windows-titlebar-actions [data-nav="search"]');
  const rect=search.getBoundingClientRect();
  const header=document.querySelector(collapsed ? '.conversation-topbar' : '.sidebar-header');
  check(header.getBoundingClientRect().left >= rect.right, "Native drag band overlaps Search: " + JSON.stringify({collapsed,header:header.getBoundingClientRect().toJSON(),search:rect.toJSON()}));
  flushSync(() => search.click());
  await frame(); await frame();
  check(document.querySelector('.search-dialog'), "Search did not open");
  document.querySelector('.search-dialog input').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));
  await frame(); await frame();
  check(!document.querySelector('.search-dialog'), "Escape did not close Search");
  results.push({collapsed,searchOpened:true,dragClear:true});
 }
 flushSync(() => document.querySelector('[data-nav="rail-home"]').click());
 check(useAppStore.getState().page === 'chat', "Home did not return to chat");
 return results;
};
`;
await build({stdin:{contents:fixture,resolveDir:join(root,"scripts/e2e"),loader:"tsx"},
 outfile:join(dir,"renderer.js"),bundle:true,platform:"browser",format:"esm",jsx:"automatic",
 define:{"process.env.NODE_ENV":'"production"',"import.meta.env.DEV":"false"},
 alias:Object.fromEntries(["react","react-dom","i18next","react-i18next"].map(name=>[name,join(root,"apps/desktop/node_modules",name)]).concat([
 ["@pi-desktop/i18n",join(root,"packages/i18n/src")],["@pi-desktop/shared",join(root,"packages/shared/src")]])),
 nodePaths:[join(root,"apps/desktop/node_modules")],loader:{".png":"dataurl",".svg":"dataurl"}});
await writeFile(join(dir,"style.css"),(await loadStyles()).replace('@import "tailwindcss";', '') + '\n*{box-sizing:border-box}html,body,#root{height:100%;margin:0}button{font:inherit}.sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}');
await writeFile(join(dir,"index.html"),'<!doctype html><html data-platform="win32" data-theme="dark"><meta charset="utf-8"><title>mc-agent Titlebar Test</title><link rel="stylesheet" href="style.css"><div id="root"></div><script type="module" src="renderer.js"></script></html>');
await writeFile(join(dir,"main.cjs"), `
const {app,BrowserWindow}=require('electron');const path=require('node:path');
app.setPath('userData',path.join(__dirname,'profile'));
app.whenReady().then(async()=>{
 const win=new BrowserWindow({show:${manual},frame:false,width:1000,height:700,title:'mc-agent Titlebar Test',webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}});
 win.webContents.on('console-message',(event)=>console.log(event.message));
 try {await win.loadFile(path.join(__dirname,'index.html'));
 ${manual ? "" : "console.log('TITLEBAR_PROBE '+JSON.stringify(await win.webContents.executeJavaScript('window.titlebarProbe()')));app.exit(0);"}
 }catch(e){console.error(e.stack);app.exit(1)}
});app.on('window-all-closed',()=>app.quit());`);
const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
const binary=process.env.MC_TITLEBAR_ELECTRON || resolveElectronBinary(root).electronBinary;
console.log(`Titlebar fixture: ${dir}; runtime: ${binary}`);
const child=spawn(binary,[join(dir,"main.cjs")],{env,stdio:["ignore","pipe","pipe"]});
let output="";for(const stream of [child.stdout,child.stderr]) stream.on("data",chunk=>{output+=chunk;process.stdout.write(chunk);});
const timer=setTimeout(()=>child.kill(),manual?600000:45000);
try {const code=await new Promise((ok,fail)=>{child.once("exit",ok);child.once("error",fail);});assert.equal(code,0,output);}
finally{clearTimeout(timer);}
