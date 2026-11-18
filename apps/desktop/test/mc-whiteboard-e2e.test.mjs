import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { resolveElectronBinary } from "../../../scripts/e2e/boot.mjs";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const require = createRequire(join(root, "apps/desktop/package.json"));
const { build } = require("esbuild");

const OFFLINE_FONT_FAMILIES = [
  "Assistant",
  "Cascadia",
  "ComicShanns",
  "Excalifont",
  "Liberation",
  "Lilita",
  "Nunito",
  "Virgil",
];

test(
  "Excalidraw whiteboard mounts offline in temporary session, live-reloads Agent ops, exports PNG chip, and accepts HTML artboard annotations",
  {
    skip: process.platform === "linux" && !process.env.DISPLAY ? "Electron requires a display" : false,
  },
  async () => {
    const temp = await mkdtemp(join(tmpdir(), "mc-whiteboard-e2e-"));
    try {
      // Copy offline compact Excalidraw font subsets into temp/excalidraw-assets/fonts/
      const excalidrawEntry = require.resolve("@excalidraw/excalidraw");
      const srcFontsDir = join(dirname(excalidrawEntry), "fonts");
      for (const family of OFFLINE_FONT_FAMILIES) {
        await cp(join(srcFontsDir, family), join(temp, "excalidraw-assets", "fonts", family), {
          recursive: true,
        });
      }

      await build({
        entryPoints: [join(root, "apps/desktop/test/fixtures/mc-whiteboard-e2e.tsx")],
        outfile: join(temp, "renderer.js"),
        bundle: true,
        platform: "browser",
        format: "esm",
        jsx: "automatic",
        conditions: ["production"],
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
        plugins: [
          {
            name: "fixture-url-assets",
            setup(builder) {
              builder.onResolve({ filter: /\?url$/ }, (args) => ({
                path: resolve(args.resolveDir, args.path.slice(0, -4)),
                namespace: "fixture-url",
              }));
              builder.onLoad({ filter: /.*/, namespace: "fixture-url" }, async (args) => ({
                contents: await readFile(args.path),
                loader: "file",
              }));
            },
          },
        ],
        nodePaths: [join(root, "apps/desktop/node_modules")],
      });

      // Strip Excalidraw's esm.sh CDN fallback + Xiaolai CJK registration just like `electron.vite.config.ts`
      const jsPath = join(temp, "renderer.js");
      const rawJs = await readFile(jsPath, "utf8");
      const patchedJs = rawJs
        .replace(/([A-Za-z0-9_$]+)\.push\(new URL\([^()]*ASSETS_FALLBACK_URL\)\)/g, "$1")
        .replace(
          /("Virgil"\s*,\s*\.\.\.[A-Za-z0-9_$]+\))\s*([,;])\s*[A-Za-z0-9_$]+\(\s*[A-Za-z0-9_$]+\s*,\s*\.\.\.[A-Za-z0-9_$]+\)/g,
          "$1$2 void 0",
        );
      assert.notEqual(patchedJs, rawJs, "Excalidraw offline asset patch must match bundled JS");
      await writeFile(jsPath, patchedJs);

      const cssPath = join(temp, "renderer.css");
      await writeFile(cssPath, (await readFile(cssPath, "utf8")).replace(/@theme[^\{]*\{/g, ":root {"));

      await writeFile(
        join(temp, "index.html"),
        '<!doctype html><html data-theme="dark"><meta charset="utf-8"><link rel="stylesheet" href="renderer.css"><style>:root{--text-xs:11px;--text-sm:12px;--text-base:14px;--radius-md:8px;--radius-lg:16px;--radius-full:9999px}html,body,#root{margin:0;width:100%;height:100%;font:14px system-ui;background:var(--ds-bg-primary,#141416);color:var(--ds-text-primary,#f4f4f6)}.sr-only{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0,0,0,0)}button,input,select{font:inherit}</style><div id="root"></div><script type="module" src="renderer.js"></script></html>',
      );

      await writeFile(
        join(temp, "main.cjs"),
        `
const { app, BrowserWindow, session } = require("electron");
const path = require("node:path");
app.setPath("userData", path.join(__dirname, "profile"));
app.whenReady().then(async () => {
  const externalUrls = [];
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
    if (/^https?:/i.test(details.url)) {
      externalUrls.push(details.url);
      callback({ cancel: true });
      return;
    }
    callback({});
  });
  const win = new BrowserWindow({
    show: false,
    width: 1120,
    height: 760,
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
      offscreen: true,
    },
  });
  win.webContents.on("console-message", (event) => console.error(event.message));
  try {
    await win.loadFile(path.join(__dirname, "index.html"));
    const result = await win.webContents.executeJavaScript("window.whiteboardProbe()");
    if (externalUrls.length > 0) {
      throw new Error("Unexpected external network requests: " + externalUrls.join(", "));
    }
    console.log("WHITEBOARD_PROBE " + JSON.stringify({ ...result, externalUrls }));
    app.exit(0);
  } catch (error) {
    console.error(error?.stack ?? error);
    app.exit(1);
  }
});`,
      );

      const env = { ...process.env };
      delete env.ELECTRON_RUN_AS_NODE;
      const child = spawn(resolveElectronBinary(root).electronBinary, [join(temp, "main.cjs")], {
        env,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let output = "";
      for (const stream of [child.stdout, child.stderr]) {
        stream.on("data", (chunk) => {
          output += chunk;
        });
      }
      const timer = setTimeout(() => child.kill(), 60_000);
      let code;
      try {
        code = await new Promise((resolveCode, reject) => {
          child.once("error", reject);
          child.once("close", resolveCode);
        });
      } finally {
        clearTimeout(timer);
      }
      assert.equal(code, 0, output.slice(-8000));
      assert.match(output, /WHITEBOARD_PROBE .*"passed":true/);
    } finally {
      assert.ok(resolve(temp).startsWith(resolve(tmpdir()) + (process.platform === "win32" ? "\\" : "/")));
      await rm(temp, { recursive: true, force: true });
    }
  },
);
