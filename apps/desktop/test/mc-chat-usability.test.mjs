import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { resolveElectronBinary } from "../../../scripts/e2e/boot.mjs";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const require = createRequire(join(root, "apps/desktop/package.json"));
const { build } = require("esbuild");

test("tab menu and visible image previews work through the real components", {
  skip: process.platform === "linux" && !process.env.DISPLAY ? "Electron requires a display" : false,
}, async () => {
  const temp = await mkdtemp(join(tmpdir(), "mc-chat-usability-"));
  try {
    await build({
      entryPoints: [join(root, "apps/desktop/test/fixtures/mc-chat-usability.tsx")],
      outfile: join(temp, "renderer.js"), bundle: true, platform: "browser", format: "esm", jsx: "automatic",
      define: { "process.env.NODE_ENV": '"production"' },
      alias: {
        "@pi-desktop/i18n": join(root, "packages/i18n/src"),
        "@pi-desktop/shared": join(root, "packages/shared/src"),
        react: join(root, "apps/desktop/node_modules/react"),
        "react-dom": join(root, "apps/desktop/node_modules/react-dom"),
        i18next: join(root, "apps/desktop/node_modules/i18next"),
        "react-i18next": join(root, "apps/desktop/node_modules/react-i18next"),
      },
      loader: { ".woff": "file", ".woff2": "file", ".ttf": "file" },
      plugins: [{ name: "fixture-url-assets", setup(builder) {
        builder.onResolve({ filter: /\?url$/ }, (args) => ({ path: resolve(args.resolveDir, args.path.slice(0, -4)), namespace: "fixture-url" }));
        builder.onLoad({ filter: /.*/, namespace: "fixture-url" }, async (args) => ({ contents: await readFile(args.path), loader: "file" }));
      } }],
      nodePaths: [join(root, "apps/desktop/node_modules")],
    });
    // The isolated esbuild fixture has no Tailwind pass; expose its theme tokens.
    const cssPath = join(temp, "renderer.css");
    await writeFile(cssPath, (await readFile(cssPath, "utf8")).replace(/@theme[^\{]*\{/g, ":root {"));
    await writeFile(join(temp, "index.html"), '<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="renderer.css"><style>:root{--text-xs:11px;--text-sm:12px;--text-base:14px;--radius-md:8px;--radius-lg:16px;--radius-full:9999px}body{margin:0;font:14px system-ui;background:var(--ds-bg-primary);color:var(--ds-text-primary)}button,input{font:inherit}</style><div id="root"></div><script type="module" src="renderer.js"></script>');
    await writeFile(join(temp, "main.cjs"), `
const { app, BrowserWindow } = require("electron");
const path = require("node:path");
app.setPath("userData", path.join(__dirname, "profile"));
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 1050, height: 700,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, offscreen: true } });
  win.webContents.on("console-message", (event) => console.error(event.message));
  try {
    await win.loadFile(path.join(__dirname, "index.html"));
    const result = await win.webContents.executeJavaScript("window.usabilityProbe()");
    await new Promise((resolve) => setTimeout(resolve, 200));
    if (process.env.MC_CHAT_SCREENSHOT) require("node:fs").writeFileSync(process.env.MC_CHAT_SCREENSHOT, (await win.webContents.capturePage()).toPNG());
    console.log("USABILITY_PROBE " + JSON.stringify(result)); app.exit(0);
  } catch (error) { console.error(error?.stack ?? error); app.exit(1); }
});`);
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(resolveElectronBinary(root).electronBinary, [join(temp, "main.cjs")], { env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    for (const stream of [child.stdout, child.stderr]) stream.on("data", (chunk) => { output += chunk; });
    const timer = setTimeout(() => child.kill(), 60_000);
    let code;
    try { code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("close", resolve); }); }
    finally { clearTimeout(timer); }
    assert.equal(code, 0, output.slice(-6000));
    assert.match(output, /USABILITY_PROBE .*"passed":true/);
  } finally {
    // Only remove the uniquely created fixture directory under the OS temp root.
    assert.ok(resolve(temp).startsWith(resolve(tmpdir()) + (process.platform === "win32" ? "\\" : "/")));
    await rm(temp, { recursive: true, force: true });
  }
});
