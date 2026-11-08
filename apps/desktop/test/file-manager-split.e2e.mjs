import assert from "node:assert/strict";
import { FILE_PREVIEW_LINKS_SCRIPT } from "../electron/main/mc-file-preview-links.ts";
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

const DOCUMENT = [
  "[web](https://gitlab.example.test/group/project)",
  "",
  "[key](https://gitlab.example.test/keyboard)",
  "",
  "[relative](./other.md)",
  "",
  "[script](javascript:alert(1))",
  "",
].join("\n");

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

const opened = [];
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
  contents.setWindowOpenHandler(({ url }) => { opened.push(url); return { action: "deny" }; });
  contents.on("dom-ready", () => { void contents.executeJavaScript(process.env.MC_FILE_PREVIEW_LINKS); });
  const url = pathToFileURL(process.env.PI_FILE_MANAGER_VIEW);
  url.searchParams.set("piViewOpen", "a.md");
  await window.loadURL(url.href);
  await contents.executeJavaScript(
    "new Promise((resolve, reject) => { const end = Date.now() + 8000; const poll = () => {" +
    "if (document.querySelectorAll('.md-link').length >= 4) resolve();" +
    "else if (Date.now() > end) reject(new Error('no preview links: ' + document.body.innerText.slice(0, 300)));" +
    "else setTimeout(poll, 50); }; poll(); })",
  );
  const waitFor = async (expression) => contents.executeJavaScript(
    "new Promise((resolve, reject) => { const end = Date.now() + 8000; const poll = () => {" +
    "if (" + expression + ") resolve(); else if (Date.now() > end) reject(new Error('timeout: ' + " + JSON.stringify(expression) + ")); else setTimeout(poll, 30); }; poll(); })"
  );
  const tab = async (label) => contents.executeJavaScript(
    "[...document.querySelectorAll('[role=tab]')].find(el => el.textContent === " + JSON.stringify(label) + ").click()"
  );
  const key = (keyCode) => {
    const modifiers = [process.platform === "darwin" ? "meta" : "control"];
    contents.sendInputEvent({ type: "keyDown", keyCode, modifiers });
    contents.sendInputEvent({ type: "keyUp", keyCode, modifiers });
  };
  await tab("分栏");
  await waitFor("document.querySelector('.md-body') && document.querySelector('.cm-content').getBoundingClientRect().width > 0");
  const layout = await contents.executeJavaScript("(() => {" +
    "const editor = document.querySelector('.cm-editor').getBoundingClientRect();" +
    "const preview = document.querySelector('.md-scroll').getBoundingClientRect();" +
    "return { left: editor.x, right: editor.right, preview: preview.x, width: preview.width }; })()");
  await contents.executeJavaScript("document.querySelector('.cm-content').focus()");
  key("A");
  await contents.insertText("# First draft\n\n");
  await waitFor("document.querySelector('.md-body h1')?.textContent === 'First draft'");
  await sleep(600);
  key("A");
  await contents.insertText("# First draft\n\nSecond edit");
  await waitFor("document.querySelector('.md-body')?.textContent.includes('Second edit')");
  key("Z");
  await waitFor("document.querySelector('.md-body h1')?.textContent === 'First draft' && !document.querySelector('.md-body').textContent.includes('Second edit')");
  key("A");
  await contents.insertText("# First draft\n\nSecond edit");
  await tab("编辑");
  await waitFor("!document.querySelector('.md-body')");
  await tab("预览");
  await waitFor("document.querySelector('.md-body')?.textContent.includes('Second edit')");
  await tab("分栏");
  await contents.executeJavaScript("document.querySelector('.cm-content').focus()");
  key("S");
  await waitFor("document.body.innerText.includes('已保存')");
  const result = { layout, text: await contents.executeJavaScript("document.querySelector('.md-body').textContent") };

  await contents.executeJavaScript("document.querySelector('button[aria-label=\"显示文件列表\"]')?.click()");
  await waitFor("document.querySelectorAll('[role=treeitem]').length >= 2");
  await contents.executeJavaScript("[...document.querySelectorAll('[role=treeitem]')].find(el => el.textContent.includes('b.txt')).click()");
  await waitFor("![...document.querySelectorAll('[role=tab]')].some(el => el.textContent === '分栏')");
  result.plainHasSplit = await contents.executeJavaScript("[...document.querySelectorAll('[role=tab]')].some(el => el.textContent === '分栏')");
  return result;
}

app.whenReady().then(async () => {
  try {
    console.log("FILE_MANAGER_LINKS_PROBE " + JSON.stringify({ ok: true, result: await run() }));
    app.exit(0);
  } catch (error) {
    console.error("FILE_MANAGER_LINKS_PROBE " + JSON.stringify({ ok: false, error: String(error?.stack ?? error) }));
    app.exit(1);
  }
});
`;

test(
  "File Manager split mode previews consecutive edits and preserves drafts across modes and save",
  { skip: process.platform === "linux" && !process.env.DISPLAY ? "Electron requires a display" : false },
  async () => {
    const temp = await mkdtemp(join(tmpdir(), "pi-file-manager-links-"));
    try {
      await writeFile(join(temp, "preload.cjs"), preloadFixture);
      await writeFile(join(temp, "main.cjs"), mainFixture);
      const env = { ...process.env, PI_FILE_MANAGER_VIEW: viewEntry, MC_FILE_PREVIEW_LINKS: FILE_PREVIEW_LINKS_SCRIPT };
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
      const line = output.split(/\r?\n/).find((item) => item.startsWith("FILE_MANAGER_LINKS_PROBE "));
      assert.ok(line, output.slice(-4000));
      const report = JSON.parse(line.slice("FILE_MANAGER_LINKS_PROBE ".length));
      assert.equal(report.ok, true, report.error + output);
      const { layout, text, plainHasSplit } = report.result;
      assert.equal(plainHasSplit, false);
      assert.ok(layout.width > 100, JSON.stringify(layout));
      assert.ok(layout.right <= layout.preview + 1, JSON.stringify(layout));
      assert.ok(layout.left < layout.preview);
      assert.match(text, /First draft/);
      assert.match(text, /Second edit/);

    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  },
);
