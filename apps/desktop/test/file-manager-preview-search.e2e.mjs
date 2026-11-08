import { FILE_PREVIEW_SEARCH_SCRIPT } from "../electron/main/mc-file-preview-search.ts";
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

const DOCUMENT = "# 查找示例\n\n目标**文字**在这里，目标文字又出现。\n\n" + "普通段落\n\n".repeat(80) + "目标文字在末尾。";

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
const text = ${JSON.stringify(DOCUMENT)};
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
          }],
          truncated: false, ignoreActive: false,
        };
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
  contents.on("dom-ready", () => { if (process.env.MC_FILE_PREVIEW_SEARCH) void contents.executeJavaScript(process.env.MC_FILE_PREVIEW_SEARCH); });
  const url = pathToFileURL(process.env.PI_FILE_MANAGER_VIEW);
  url.searchParams.set("piViewOpen", "a.md");
  await window.loadURL(url.href);
  const waitFor = async (expression) => contents.executeJavaScript(
    "new Promise((resolve, reject) => { const end = Date.now() + 5000; const poll = () => {" +
    "if (" + expression + ") resolve(); else if (Date.now() > end) reject(new Error('timeout: ' + " + JSON.stringify(expression) + ")); else setTimeout(poll, 30); }; poll(); })"
  );
  const key = (keyCode, modifiers = []) => {
    contents.sendInputEvent({ type: "keyDown", keyCode, modifiers });
    contents.sendInputEvent({ type: "keyUp", keyCode, modifiers });
  };
  const tab = async (label) => contents.executeJavaScript("[...document.querySelectorAll('[role=tab]')].find(el => el.textContent === " + JSON.stringify(label) + ").click()");
  const query = async (value) => {
    await contents.executeJavaScript("(() => { const el = document.querySelector('[data-mc-preview-search] input'); el.value = " + JSON.stringify(value) + "; el.dispatchEvent(new Event('input', { bubbles: true })); })()");
  };
  await waitFor("document.querySelector('.md-body')");
  key("F", ["control"]);
  await waitFor("document.querySelector('[data-mc-preview-search] input') === document.activeElement");
  await query("目标文字");
  await waitFor("document.querySelector('[data-mc-preview-search] output')?.textContent === '1 / 3'");
  key("Enter");
  await waitFor("document.querySelector('[data-mc-preview-search] output')?.textContent === '2 / 3'");
  key("Enter");
  await waitFor("document.querySelector('.md-scroll').scrollTop > 0");
  key("Enter", ["shift"]);
  await waitFor("document.querySelector('[data-mc-preview-search] output')?.textContent === '2 / 3'");
  const highlighted = await contents.executeJavaScript("CSS.highlights.get('mc-preview-matches').size");
  await query("[.*]");
  await waitFor("document.querySelector('[data-mc-preview-search] output')?.textContent === '0 / 0'");
  await query("不存在");
  await waitFor("document.querySelector('[data-mc-preview-search] output')?.textContent === '0 / 0'");
  key("Escape");
  await waitFor("!document.querySelector('[data-mc-preview-search]')");
  key("F", [process.platform === 'darwin' ? 'meta' : 'control']);
  await waitFor("document.querySelector('[data-mc-preview-search] input')");
  await query("目标文字");
  await tab("分栏");
  await contents.executeJavaScript("document.querySelector('.cm-content').focus()");
  key("F", [process.platform === 'darwin' ? 'meta' : 'control']);
  await waitFor("document.querySelector('.cm-search input') === document.activeElement");
  key("Escape");
  await contents.executeJavaScript("document.querySelector('.cm-content').focus()");
  key("A", [process.platform === 'darwin' ? 'meta' : 'control']);
  await contents.insertText("目标文字更新后的草稿");
  await waitFor("document.querySelector('.md-body')?.textContent.includes('更新后的草稿') && document.querySelector('[data-mc-preview-search] output')?.textContent === '1 / 1'");
  await tab("编辑");
  await waitFor("!document.querySelector('[data-mc-preview-search]') && !CSS.highlights.has('mc-preview-matches')");
  const result = { highlighted };

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
  "Markdown preview supports find, navigation and split editor focus",
  { skip: process.platform === "linux" && !process.env.DISPLAY ? "Electron requires a display" : false },
  async () => {
    const temp = await mkdtemp(join(tmpdir(), "pi-file-manager-links-"));
    try {
      await writeFile(join(temp, "preload.cjs"), preloadFixture);
      await writeFile(join(temp, "main.cjs"), mainFixture);
      const env = { ...process.env, PI_FILE_MANAGER_VIEW: viewEntry, MC_FILE_PREVIEW_SEARCH: FILE_PREVIEW_SEARCH_SCRIPT };
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
      assert.equal(report.ok, true, report.error);
      assert.equal(report.result.highlighted, 3);

    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  },
);
