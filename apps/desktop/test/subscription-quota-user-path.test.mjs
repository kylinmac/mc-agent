import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { repositoryRoot, resolveElectronBinary } from "../../../scripts/e2e/boot.mjs";

const root = repositoryRoot();
const { build } = createRequire(join(root, "packages/agent-runtime/package.json"))("esbuild");

const fixture = String.raw`
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import { catalogs, flattenCatalog } from "@pi-desktop/i18n";
import { SubscriptionQuotaChip } from "../../apps/desktop/src/features/chat/composer/SubscriptionQuotaChip";
import { api } from "../../apps/desktop/src/lib/api";
const calls = [];
api.subscriptionQuota = (providerId) => new Promise((resolve, reject) => calls.push({ providerId, resolve, reject }));
await i18n.use(initReactI18next).init({ lng: "en", keySeparator: false,
  resources: { en: { translation: flattenCatalog(catalogs.en) } }, interpolation: { escapeValue: false } });
let now = Date.now();
Date.now = () => now;
const rootNode = createRoot(document.getElementById("root"));
const render = (ids, active = true) => flushSync(() => rootNode.render(ids.map((id, index) =>
  <SubscriptionQuotaChip key={index} t={i18n.t.bind(i18n)} providerId={id} runActive={active} />)));
const value = (percent) => ({ quota: { source: "codex", fetchedAt: now,
  windows: [{ remainingPercent: percent, seconds: 604800 }] } });
const text = () => document.getElementById("root").textContent;
const check = (condition, message) => { if (!condition) throw new Error(message + " text=" + text()); };
const until = async (condition, message) => {
  for (let i = 0; i < 300; i++) { if (condition()) return; await new Promise(r => setTimeout(r, 10)); }
  check(false, message);
};
window.quotaProbe = async () => {
  render(["a"]);
  await until(() => calls.length === 1, "running conversation must load quota");
  calls[0].resolve(value(99));
  await until(() => text().includes("99%"), "first quota missing");
  render([]);
  render(["a", "a"]);
  check(document.querySelectorAll(".mc-quota-window-value").length === 2, "shared snapshot must render immediately");
  check(calls.length === 1, "same account must not query for each conversation");
  now += 3 * 60_000;
  render(["a", "a"], false);
  await until(() => calls.length === 2, "completion should refresh once when due");
  check(text().includes("99%"), "refresh must keep the previous quota");
  calls[1].reject(new Error("offline"));
  await until(() => text().includes("*"), "failed refresh should mark stale data");
  check([...document.querySelectorAll(".mc-quota-chip-body")].every(e => e.getAttribute("aria-label").includes("Refresh failed")), "stale state must be explained");
  now += 3 * 60_000;
  render(["a"], true);
  render(["a"], false);
  await until(() => calls.length === 3, "recovery request missing");
  render(["b"], true);
  check(!text().includes("99%"), "account B must never show account A quota");
  await until(() => calls.length === 4, "new running account must load quota");
  calls[3].resolve(value(40));
  await until(() => text().includes("40%"), "account B quota missing");
  calls[2].resolve(value(90));
  await new Promise(r => setTimeout(r, 30));
  check(text().includes("40%") && !text().includes("90%"), "late account A response crossed accounts");
  render(["a"]);
  check(text().includes("90%") && !text().includes("*"), "recovered quota should be shared and fresh");
  render([undefined]);
  check(!document.querySelector(".mc-quota-chip"), "missing provider should hide quota");
  rootNode.unmount();
  return { passed: true, requests: calls.length };
};
`;
test("quota is shared across conversations, loads while running, and isolates accounts", {
  skip: process.platform === "linux" && !process.env.DISPLAY ? "Electron requires a display" : false,
}, async () => {
  const temp = await mkdtemp(join(tmpdir(), "mc-quota-ui-"));
  try {
    await build({
      stdin: { contents: fixture, resolveDir: join(root, "scripts/e2e"), loader: "tsx" },
      outfile: join(temp, "renderer.js"),
      bundle: true,
      platform: "browser",
      format: "esm",
      jsx: "automatic",
      define: { "process.env.NODE_ENV": '"production"' },
      alias: {
        "@pi-desktop/i18n": join(root, "packages/i18n/src"),
        "@pi-desktop/shared": join(root, "packages/shared/src"),
        react: join(root, "apps/desktop/node_modules/react"),
        "react-dom": join(root, "apps/desktop/node_modules/react-dom"),
        i18next: join(root, "apps/desktop/node_modules/i18next"),
        "react-i18next": join(root, "apps/desktop/node_modules/react-i18next"),
      },
      nodePaths: [join(root, "apps/desktop/node_modules")],
    });
    await writeFile(join(temp, "index.html"),
      '<!doctype html><meta charset="utf-8"><div class="main-pane"><div id="root"></div></div><script type="module" src="renderer.js"></script>');
    await writeFile(join(temp, "main.cjs"), `
const { app, BrowserWindow } = require("electron");
const path = require("node:path");
app.setPath("userData", path.join(__dirname, "profile"));
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 900, height: 700,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false,
      offscreen: process.platform === "win32" } });
  win.webContents.on("console-message", (event) => console.error(event.message));
  try {
    await win.loadFile(path.join(__dirname, "index.html"));
    console.log("QUOTA_PROBE " + JSON.stringify(await win.webContents.executeJavaScript("window.quotaProbe()")));
    app.exit(0);
  } catch (error) { console.error(error?.stack ?? error); app.exit(1); }
});`);
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(resolveElectronBinary(root).electronBinary, [join(temp, "main.cjs")], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    for (const stream of [child.stdout, child.stderr]) {
      stream.setEncoding("utf8");
      stream.on("data", (chunk) => { output += chunk; });
    }
    const timer = setTimeout(() => child.kill("SIGKILL"), 60_000);
    let code;
    try {
      code = await new Promise((resolve, reject) => {
        child.once("error", reject);
        child.once("close", resolve);
      });
    } finally {
      clearTimeout(timer);
    }
    assert.equal(code, 0, output.slice(-6000));
    const line = output.split(/\r?\n/).find((item) => item.startsWith("QUOTA_PROBE "));
    assert.ok(line, output.slice(-6000));
    assert.equal(JSON.parse(line.slice("QUOTA_PROBE ".length)).passed, true);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
