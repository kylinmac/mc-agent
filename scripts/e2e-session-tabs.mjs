// Production components and CSS, temporary profile, mocked IPC; no models or user data.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { repositoryRoot, resolveElectronBinary } from "./e2e/boot.mjs";
import { loadStyles } from "../apps/desktop/test/helpers/styles.mjs";

const root = repositoryRoot();
const { build } = createRequire(join(root, "packages/agent-runtime/package.json"))("esbuild");
const dir = await mkdtemp(join(tmpdir(), "mc-session-tabs-"));
try {
  await build({entryPoints:[join(root,"scripts/e2e/session-tabs.tsx")], outfile:join(dir,"renderer.js"),
    bundle:true, platform:"browser", format:"esm", jsx:"automatic",
    define:{"process.env.NODE_ENV":'"production"',"import.meta.env.DEV":"false"},
    alias:Object.fromEntries(["react","react-dom","i18next","react-i18next"].map(name=>[name,join(root,"apps/desktop/node_modules",name)]).concat([
      ["@pi-desktop/i18n",join(root,"packages/i18n/src")],["@pi-desktop/shared",join(root,"packages/shared/src")]])),
    nodePaths:[join(root,"apps/desktop/node_modules")],loader:{".png":"dataurl",".svg":"dataurl"}});
  await writeFile(join(dir,"style.css"),(await loadStyles()).replace('@import "tailwindcss";', '') +
    '\n*{box-sizing:border-box}html,body,#root{height:100%;margin:0}button{font:inherit;border:0;background:none}.sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}');
  const tabs = [...Array.from({length:18},(_,i)=>`s${i}`),"page:creative"];
  await writeFile(join(dir,"index.html"),`<!doctype html><html data-platform="darwin" data-theme="dark"><meta charset="utf-8"><title>Session tabs test</title><link rel="stylesheet" href="style.css"><div id="root"></div><script>localStorage.setItem('mc.sessionTabs',${JSON.stringify(JSON.stringify(tabs))})</script><script type="module" src="renderer.js"></script></html>`);
  await writeFile(join(dir,"main.cjs"),`
const {app,BrowserWindow}=require('electron');const path=require('node:path');
app.setPath('userData',path.join(__dirname,'profile'));
app.whenReady().then(async()=>{
 const win=new BrowserWindow({show:false,titleBarStyle:'hiddenInset',width:1000,height:700,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}});
 win.webContents.on('console-message',(event)=>console.log(event.message));
 try {
  await win.loadFile(path.join(__dirname,'index.html'));
  console.log(JSON.stringify(await win.webContents.executeJavaScript('window.tabProbe("narrow")')));
  win.setSize(1600,800);win.webContents.setZoomFactor(0.5);
  console.log(JSON.stringify(await win.webContents.executeJavaScript('window.tabProbe("wide")')));
  win.setSize(1000,700);win.webContents.setZoomFactor(0.85);
  console.log(JSON.stringify(await win.webContents.executeJavaScript('window.tabProbe("many-projects")')));
  app.exit(0);
 }catch(e){console.error(e.stack);app.exit(1)}
});`);
  const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
  const child=spawn(resolveElectronBinary(root).electronBinary,[join(dir,"main.cjs")],{env,stdio:["ignore","pipe","pipe"]});
  let output="";
  for(const stream of [child.stdout,child.stderr]) stream.on("data",chunk=>{output+=chunk;process.stdout.write(chunk);});
  const timer=setTimeout(()=>child.kill(),45000);
  try {
    const code=await new Promise((resolve,reject)=>{child.once("exit",resolve);child.once("error",reject);});
    assert.equal(code,0,output);
  } finally { clearTimeout(timer); }
} finally {
  await rm(dir,{recursive:true,force:true});
}
