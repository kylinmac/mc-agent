import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { resolveElectronBinary } from "../../../scripts/e2e/boot.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "../../..");
// PI_FILE_MANAGER_VIEW runs this against another copy, such as a marketplace one.
const viewEntry =
  process.env.PI_FILE_MANAGER_VIEW ??
  join(root, "apps/desktop/resources/plugins/pi.file-manager/views/index.html");
const electronBinary =
  process.env.PI_DESKTOP_ELECTRON_BIN ?? resolveElectronBinary(root).electronBinary;

const DOCUMENT = Array.from({ length: 12 }, (_, i) => `## HEADING_${i}\n\n` + `PARA_${i} 很长的中文段落用于测试两边折行高度不同。`.repeat(16) + `\n\n- PARENT_${i}\n\n  - NESTED_${i}\n\n> QUOTE_${i}\n> continuation\n\n`).join("") + "| Name | Description |\n| --- | --- |\n" + Array.from({ length: 60 }, (_, i) => `| ROW_${i} | long description for a wrapped table row ${i} |`).join("\n") + "\n\n```ts\n" + Array.from({ length: 80 }, (_, i) => `const CODE_${i} = ${i};`).join("\n") + "\n```\n\n" + "最后一段。\n\n".repeat(80);

const preloadFixture = String.raw`
const { contextBridge, ipcRenderer } = require("electron");
const workspace = {
  path: "/fixture/project",
  name: "project",
  projectId: "fixture-project",
  roots: [{ path: "/fixture/project", name: "project", primary: true }],
};
const prefs = {
  splitRatio: 0.32, treeCollapsed: false, showIgnored: false, mdPreview: true,
  csvTable: true, jsonTree: false, tablePageSize: 1000, projectRoots: {},
};
let text = ${JSON.stringify(DOCUMENT)};
contextBridge.exposeInMainWorld("pluginBridge", {
  async invoke(channel, payload = {}) {
    switch (channel) {
      case "app.getAppearance": return { base: "dark", locale: "zh-CN" };
      case "workspace.get": return workspace;
      case "fm.hello":
        return {
          ok: true, root: workspace,
          limits: { maxReadBytes: 2097152, maxWriteBytes: 8388608, maxListEntries: 5000 },
          ignoreFiles: [], prefs,
        };
      case "fm.list":
        return {
          ok: true, path: payload.path ?? "",
          entries: payload.path ? [] : [{
            name: "a.md", path: "a.md", isDirectory: false, size: text.length,
            mtimeMs: 1, ignored: false, isSymlink: false, outside: false,
          }, { name: "b.txt", path: "b.txt", isDirectory: false, size: 4, mtimeMs: 1, ignored: false, isSymlink: false, outside: false }],
          truncated: false, ignoreActive: false,
        };
      case "fm.write": text = payload.text; return { ok: true, mtimeMs: 2, size: text.length };
      case "fm.read":
        return { ok: true, kind: "text", path: payload.path, text, eol: "lf", bom: false, size: text.length, mtimeMs: 1 };
      case "fm.prefs.set": return { ok: true, prefs: { ...prefs, ...(payload.partial ?? {}) } };
      case "ui.showToast":
        ipcRenderer.send("fixture-toast", payload.message);
        return { ok: true };
      default:
        return { ok: false, code: "fixture", message: "unhandled " + channel };
    }
  },
  on() { return () => {}; },
});
`;

const mainFixture = String.raw`
const { app, BrowserWindow, ipcMain } = require("electron");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
app.setPath("userData", path.join(__dirname, "profile"));

const toasts = [];
ipcMain.on("fixture-toast", (_event, message) => toasts.push(message));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function run() {
  const window = new BrowserWindow({
    show: false, width: 1000, height: 700,
    webPreferences: {
      sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false,
      preload: path.join(__dirname, "preload.cjs"),
    },
  });
  const contents = window.webContents;
  contents.on("console-message", (_event, level, message) => { if (level >= 2) console.error("RENDERER", message); });
  const url = pathToFileURL(process.env.PI_FILE_MANAGER_VIEW);
  url.searchParams.set("piViewOpen", "a.md");
  await window.loadURL(url.href);
  // Chromium on Linux throttles animation frames in never-shown windows.
  window.showInactive();
  const waitFor = async (expression) => contents.executeJavaScript(
    "new Promise((resolve, reject) => { const end = Date.now() + 8000; const poll = () => {" +
    "if (" + expression + ") resolve(); else if (Date.now() > end) reject(new Error('timeout: ' + " + JSON.stringify(expression) + ")); else setTimeout(poll, 30); }; poll(); })"
  );
  const tab = async (label) => contents.executeJavaScript("[...document.querySelectorAll('[role=tab]')].find(el => el.textContent === " + JSON.stringify(label) + ").click()");
  await waitFor("document.querySelector('.md-body')");
  await tab("分栏");
  await waitFor("document.querySelector('[data-source-line]')");
  const evaluate = (fn, ...args) => contents.executeJavaScript("(" + fn.toString() + ")(..." + JSON.stringify(args) + ")");
  const result = [];
  const measure = (label, selector, fraction = 0) => evaluate((label, selector, fraction) => {
    const e = document.querySelector('.cm-scroller');
    const line = [...e.querySelectorAll('.cm-line')].find(el => el.textContent.includes(label));
    const p = document.querySelector('.md-scroll');
    const target = [...p.querySelectorAll(selector)].find(el => el.textContent.includes(label));
    const rect = target.getBoundingClientRect();
    const source = line?.getBoundingClientRect();
    return { label, source: source ? source.top + source.height * fraction - e.getBoundingClientRect().top : null,
      preview: rect.top + rect.height * fraction - p.getBoundingClientRect().top };
  }, label, selector, fraction);
  const scrollPreview = async (label, selector, fraction = 0) => {
    await evaluate((label, selector, fraction) => {
      const p = document.querySelector('.md-scroll');
      const target = [...p.querySelectorAll(selector)].find(el => el.textContent.includes(label));
      const rect = target.getBoundingClientRect();
      p.dispatchEvent(new WheelEvent('wheel', { bubbles: true }));
      p.scrollTop += rect.top + rect.height * fraction - p.getBoundingClientRect().top;
    }, label, selector, fraction);
    await sleep(600);
    result.push(await measure(label, selector, fraction));
  };
  await scrollPreview('HEADING_8', 'h2');
  await scrollPreview('PARA_8', 'p', 0.5);
  await scrollPreview('NESTED_8', 'li li');
  await scrollPreview('QUOTE_8', 'blockquote p');
  await scrollPreview('ROW_25', 'tr');
  await scrollPreview('ROW_45', 'tr');
  const stable = await evaluate(() => [document.querySelector('.cm-scroller').scrollTop, document.querySelector('.md-scroll').scrollTop]);
  await sleep(700);
  const later = await evaluate(() => [document.querySelector('.cm-scroller').scrollTop, document.querySelector('.md-scroll').scrollTop]);
  for (let i = 0; i < stable.length; i++) result.push({ label: 'settled-' + i, source: stable[i], preview: later[i] });
  await evaluate(() => {
    const e = document.querySelector('.cm-scroller');
    const line = [...e.querySelectorAll('.cm-line')].find(el => el.textContent.includes('ROW_47'));
    e.dispatchEvent(new WheelEvent('wheel', { bubbles: true }));
    e.scrollTop += line.getBoundingClientRect().top - e.getBoundingClientRect().top;
  });
  await sleep(500);
  result.push(await measure('ROW_47', 'tr'));
  window.setSize(760, 700);
  await sleep(600);
  result.push(await contents.executeJavaScript("(() => { const e = document.querySelector('.cm-scroller'); const line = [...document.querySelectorAll('.cm-line')].find(el => el.textContent.includes('ROW_47')); const p = document.querySelector('.md-scroll'); const row = [...p.querySelectorAll('tr')].find(el => el.textContent.includes('ROW_47')); return {label:'resize',source:line ? line.getBoundingClientRect().top-e.getBoundingClientRect().top : null,preview:row.getBoundingClientRect().top-p.getBoundingClientRect().top}; })()"));
  await contents.executeJavaScript("(() => { const p = document.querySelector('.md-scroll'); const c = p.querySelector('.md-code code'); p.dispatchEvent(new WheelEvent('wheel',{bubbles:true})); p.scrollTop += c.getBoundingClientRect().top-p.getBoundingClientRect().top + parseFloat(getComputedStyle(c).lineHeight)*40; })()");
  await sleep(600);
  result.push(await contents.executeJavaScript("(() => { const e = document.querySelector('.cm-scroller'); const line = [...document.querySelectorAll('.cm-line')].find(el => el.textContent.includes('CODE_40')); return {label:'code-line',source:line ? line.getBoundingClientRect().top-e.getBoundingClientRect().top : null,preview:0}; })()"));
  await contents.executeJavaScript("document.querySelector('.md-scroll').dispatchEvent(new WheelEvent('wheel', { bubbles:true })); document.querySelector('.md-scroll').scrollTop = 1e9");
  await sleep(400);
  result.push(await contents.executeJavaScript("(() => { const e = document.querySelector('.cm-scroller'); return {label:'bottom', source:0, preview: e.scrollHeight-e.clientHeight-e.scrollTop}; })()"));
  await contents.executeJavaScript("document.querySelector('.cm-scroller').dispatchEvent(new WheelEvent('wheel', { bubbles:true })); document.querySelector('.cm-scroller').scrollTop = 0");
  await sleep(400);
  result.push(await contents.executeJavaScript("({label:'top',source:0,preview:document.querySelector('.md-scroll').scrollTop})"));

  await contents.executeJavaScript("document.querySelector('.cm-content').focus()");
  const modifiers = [process.platform === "darwin" ? "meta" : "control"];
  contents.sendInputEvent({ type: "keyDown", keyCode: "A", modifiers });
  contents.sendInputEvent({ type: "keyUp", keyCode: "A", modifiers });
  await contents.insertText("# Inserted heading\n\nInserted paragraph.\n\n" + ${JSON.stringify(DOCUMENT)});
  await waitFor("document.querySelector('.md-body h1')?.textContent === 'Inserted heading'");
  await scrollPreview('NESTED_8', 'li li');
  await scrollPreview('ROW_25', 'tr');
  await tab('预览');
  await waitFor("!document.querySelector('.cm-content')?.getBoundingClientRect().width");
  await tab('分栏');
  await waitFor("document.querySelector('.cm-content')?.getBoundingClientRect().width > 0");
  await scrollPreview('HEADING_8', 'h2');

  return result;
}

app.whenReady().then(async () => {
  try {
    console.log("FILE_MANAGER_SCROLL_PROBE " + JSON.stringify({ ok: true, result: await run() }));
    app.exit(0);
  } catch (error) {
    console.error("FILE_MANAGER_SCROLL_PROBE " + JSON.stringify({ ok: false, error: String(error?.stack ?? error) }));
    app.exit(1);
  }
});
`;

test(
  "Markdown split scroll aligns source blocks and table rows in both directions",
  { skip: process.platform === "linux" && !process.env.DISPLAY ? "Electron requires a display" : false },
  async () => {
    const temp = await mkdtemp(join(tmpdir(), "pi-file-manager-scroll-"));
    try {
      await writeFile(join(temp, "preload.cjs"), preloadFixture);
      await writeFile(join(temp, "main.cjs"), mainFixture);
      const env = { ...process.env, PI_FILE_MANAGER_VIEW: viewEntry };
      delete env.ELECTRON_RUN_AS_NODE;
      const child = spawn(electronBinary, [join(temp, "main.cjs")], { env, stdio: ["ignore", "pipe", "pipe"] });
      let output = "";
      for (const stream of [child.stdout, child.stderr]) {
        stream.setEncoding("utf8");
        stream.on("data", (chunk) => { output += chunk; });
      }
      const timeout = setTimeout(() => child.kill("SIGKILL"), 45_000);
      try {
        await new Promise((resolve, reject) => {
          child.once("error", reject);
          child.once("close", resolve);
        });
      } finally {
        clearTimeout(timeout);
      }
      const line = output.split(/\r?\n/).find((item) => item.startsWith("FILE_MANAGER_SCROLL_PROBE "));
      assert.ok(line, output.slice(-4000));
      const report = JSON.parse(line.slice("FILE_MANAGER_SCROLL_PROBE ".length));
      assert.equal(report.ok, true, report.error + output);
      for (const position of report.result) {
        assert.notEqual(position.source, null, JSON.stringify(report.result) + output);
        assert.ok(Math.abs(position.source - position.preview) < 24, JSON.stringify(report.result) + output);
      }

    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  },
);
