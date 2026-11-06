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
  const linkExpr = (label) =>
    "[...document.querySelectorAll('.md-link')].find((el) => el.textContent === " + JSON.stringify(label) + ")";
  const click = async (label) => {
    const box = await contents.executeJavaScript(
      "(() => { const r = " + linkExpr(label) + ".getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()",
    );
    const at = { x: Math.round(box.x), y: Math.round(box.y) };
    contents.sendInputEvent({ type: "mouseMove", ...at });
    await sleep(100);
    contents.sendInputEvent({ type: "mouseDown", ...at, button: "left", clickCount: 1 });
    contents.sendInputEvent({ type: "mouseUp", ...at, button: "left", clickCount: 1 });
    await sleep(300);
    return { opened: opened.splice(0), toasts: toasts.splice(0) };
  };
  const result = {};
  result.web = await click("web");
  result.webTitle = await contents.executeJavaScript(linkExpr("web") + ".title");
  result.relative = await click("relative");
  result.script = await click("script");
  await contents.executeJavaScript(linkExpr("key") + ".focus()");
  contents.sendInputEvent({ type: "keyDown", keyCode: "Enter" });
  contents.sendInputEvent({ type: "keyUp", keyCode: "Enter" });
  await sleep(300);
  result.keyboard = { opened: opened.splice(0), toasts: toasts.splice(0) };
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
  "File Manager preview opens web links and leaves other links alone",
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
      assert.equal(report.ok, true, report.error);
      const { web, webTitle, relative, script, keyboard } = report.result;

      assert.deepEqual(web, { opened: ["https://gitlab.example.test/group/project"], toasts: [] });
      assert.equal(webTitle, "https://gitlab.example.test/group/project");
      assert.deepEqual(keyboard, { opened: ["https://gitlab.example.test/keyboard"], toasts: [] });
      // Not web links: nothing opens, and the plugin still reports them.
      assert.deepEqual(relative.opened, []);
      assert.equal(relative.toasts.length, 1);
      assert.deepEqual(script.opened, []);
      assert.equal(script.toasts.length, 1);
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  },
);
