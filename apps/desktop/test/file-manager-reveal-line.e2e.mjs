import assert from "node:assert/strict";
import { fileRevealLineScript } from "../electron/main/mc-file-reveal-line.ts";
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

// Odd lines hold a paragraph, even lines are blank: line 151 is "Paragraph 151"
// and line 150 is the blank line before it.
const DOCUMENT = ["# Title"];
for (let line = 2; line <= 240; line += 1) DOCUMENT.push(line % 2 ? `Paragraph ${line}` : "");

const preloadFixture = (mdPreview) => String.raw`
const { contextBridge } = require("electron");
const workspace = {
  path: "/fixture/project",
  name: "project",
  projectId: "fixture-project",
  roots: [{ path: "/fixture/project", name: "project", primary: true }],
};
const prefs = {
  splitRatio: 0.32, treeCollapsed: true, showIgnored: false, mdPreview: ${mdPreview},
  csvTable: true, jsonTree: false, tablePageSize: 1000, projectRoots: {},
};
const text = ${JSON.stringify(DOCUMENT.join("\n"))};
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
      case "fm.list": return { ok: true, path: payload.path ?? "", entries: [], truncated: false, ignoreActive: false };
      case "fm.read":
        return { ok: true, kind: "text", path: payload.path, text, eol: "lf", bom: false, size: text.length, mtimeMs: 1 };
      case "fm.prefs.set": return { ok: true, prefs: { ...prefs, ...(payload.partial ?? {}) } };
      default:
        return { ok: false, code: "fixture", message: "unhandled " + channel };
    }
  },
  on() { return () => {}; },
});
`;

const EDITOR_PROBE = `(() => {
  const view = document.querySelector(".cm-content").cmTile.root.view;
  const line = view.state.doc.lineAt(view.state.selection.main.head).number;
  const coords = view.coordsAtPos(view.state.doc.line(line).from);
  const frame = view.scrollDOM.getBoundingClientRect();
  return { line, visible: !!coords && coords.top >= frame.top && coords.bottom <= frame.bottom };
})()`;
const PREVIEW_PROBE = `(() => {
  const marked = [...document.querySelectorAll("[data-source-line]")].find((node) => node.style.backgroundColor);
  if (!marked) return { line: null, visible: false };
  const rect = marked.getBoundingClientRect();
  return { line: Number(marked.dataset.sourceLine), visible: rect.top >= 0 && rect.bottom <= innerHeight };
})()`;

const mainFixture = String.raw`
const { app, BrowserWindow } = require("electron");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
app.setPath("userData", path.join(__dirname, "profile"));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const scripts = JSON.parse(process.env.MC_REVEAL_SCRIPTS);

async function run() {
  const window = new BrowserWindow({
    show: false, width: 1000, height: 700,
    webPreferences: {
      sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false,
      preload: path.join(__dirname, "preload.cjs"),
    },
  });
  const contents = window.webContents;
  const url = pathToFileURL(process.env.PI_FILE_MANAGER_VIEW);
  url.searchParams.set("piViewOpen", "docs/a.md");
  await window.loadURL(url.href);
  const ready = process.env.MC_MODE === "editor"
    ? "!!document.querySelector('.cm-content')?.cmTile?.root?.view?.state.doc.length"
    : "document.querySelectorAll('[data-source-line]').length > 50";
  await contents.executeJavaScript(
    "new Promise((resolve, reject) => { const end = Date.now() + 8000; const poll = () => {" +
    "if (" + ready + ") resolve();" +
    "else if (Date.now() > end) reject(new Error('file not shown: ' + document.body.innerText.slice(0, 300)));" +
    "else setTimeout(poll, 50); }; poll(); })",
  );
  const probe = process.env.MC_PROBE;
  const result = {};
  // A request for another file waits and changes nothing here.
  await contents.executeJavaScript(scripts.other);
  await sleep(500);
  result.other = await contents.executeJavaScript(probe);
  for (const name of ["relative", "absolute", "blank"]) {
    if (!scripts[name]) continue;
    await contents.executeJavaScript(scripts[name]);
    await sleep(700);
    result[name] = await contents.executeJavaScript(probe);
    await sleep(1800);
  }
  return result;
}

app.whenReady().then(async () => {
  try {
    console.log("FILE_MANAGER_REVEAL_PROBE " + JSON.stringify({ ok: true, result: await run() }));
    app.exit(0);
  } catch (error) {
    console.error("FILE_MANAGER_REVEAL_PROBE " + JSON.stringify({ ok: false, error: String(error?.stack ?? error) }));
    app.exit(1);
  }
});
`;

async function probe(mode) {
  const temp = await mkdtemp(join(tmpdir(), "pi-file-manager-reveal-"));
  try {
    await writeFile(join(temp, "preload.cjs"), preloadFixture(mode === "preview"));
    await writeFile(join(temp, "main.cjs"), mainFixture);
    const scripts = {
      other: fileRevealLineScript("docs/b.md", 151),
      relative: fileRevealLineScript("docs/a.md", 151),
      absolute: fileRevealLineScript("/fixture/project/docs/a.md", 61),
      ...(mode === "preview" ? { blank: fileRevealLineScript("docs/a.md", 200) } : {}),
    };
    const env = {
      ...process.env,
      PI_FILE_MANAGER_VIEW: viewEntry,
      MC_MODE: mode,
      MC_PROBE: mode === "editor" ? EDITOR_PROBE : PREVIEW_PROBE,
      MC_REVEAL_SCRIPTS: JSON.stringify(scripts),
    };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(electronBinary, [join(temp, "main.cjs")], { env, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    for (const stream of [child.stdout, child.stderr]) {
      stream.setEncoding("utf8");
      stream.on("data", (chunk) => { output += chunk; });
    }
    const timeout = setTimeout(() => child.kill("SIGKILL"), 60_000);
    try {
      await new Promise((resolve, reject) => {
        child.once("error", reject);
        child.once("close", resolve);
      });
    } finally {
      clearTimeout(timeout);
    }
    const line = output.split(/\r?\n/).find((item) => item.startsWith("FILE_MANAGER_REVEAL_PROBE "));
    assert.ok(line, output.slice(-4000));
    const report = JSON.parse(line.slice("FILE_MANAGER_REVEAL_PROBE ".length));
    assert.equal(report.ok, true, report.error);
    return report.result;
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}

const skip = process.platform === "linux" && !process.env.DISPLAY ? "Electron requires a display" : false;

test("a path:line reference puts the File Manager editor on that line", { skip }, async () => {
  const r = await probe("editor");
  // Another file's request leaves the open one alone.
  assert.equal(r.other.line, 1);
  assert.deepEqual(r.relative, { line: 151, visible: true });
  // The header names a primary-root file relatively; an absolute request matches it.
  assert.deepEqual(r.absolute, { line: 61, visible: true });
});

test("a path:line reference scrolls the File Manager preview to the block holding it", { skip }, async () => {
  const r = await probe("preview");
  assert.equal(r.other.line, null);
  assert.deepEqual(r.relative, { line: 151, visible: true });
  assert.deepEqual(r.absolute, { line: 61, visible: true });
  // A blank line lands on the block after it.
  assert.deepEqual(r.blank, { line: 201, visible: true });
});
