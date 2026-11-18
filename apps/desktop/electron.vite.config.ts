import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join, resolve } from "node:path";
import { defineConfig } from "electron-vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import type { Plugin } from "vite";

// Dev needs 'unsafe-eval' for vite HMR tooling; production must not ship it.
function tightenCsp(): Plugin {
  return {
    name: "pi-tighten-csp",
    apply: "build",
    transformIndexHtml(html) {
      return html
        .replace(" 'unsafe-eval'", "")
        .replace(
          /connect-src [^;]*;/,
          "connect-src 'self';",
        );
    },
  };
}

// Electron 43 ships a Chromium that always supports woff2, but KaTeX's
// stylesheet lists woff and truetype fallbacks for every face. Dropping those
// src entries lets Rollup tree-shake ~0.8 MB of .woff/.ttf assets it would
// otherwise emit but never serve.
function dropLegacyFontFallbacks(): Plugin {
  return {
    name: "pi-drop-legacy-font-fallbacks",
    apply: "build",
    // Must run before Vite rewrites url() into asset references, otherwise the
    // .woff/.ttf files are already registered for emission.
    enforce: "pre",
    transform(code, id) {
      if (!/\.css(?:\?.*)?$/.test(id)) return null;
      const stripped = code.replace(
        /,\s*url\([^)]+\)\s*format\("(?:woff|truetype)"\)/g,
        "",
      );
      return stripped === code ? null : { code: stripped, map: null };
    },
  };
}

// mc-agent (MC-ADR-0030): serve & bundle Excalidraw's compact WOFF2 fonts locally
// (~480 KB, omitting the 12 MB CJK split font in favor of OS CJK fallback) and
// suppress its remote CDN fallback so whiteboards run 100% offline under strict CSP.
const EXCALIDRAW_COMPACT_FONT_FAMILIES = [
  "Assistant",
  "Cascadia",
  "ComicShanns",
  "Excalifont",
  "Liberation",
  "Lilita",
  "Nunito",
  "Virgil",
];

function bundleOfflineExcalidrawAssets(): Plugin {
  const fontsRoot = resolve(__dirname, "node_modules/@excalidraw/excalidraw/dist/prod/fonts");
  return {
    name: "mc-offline-excalidraw-assets",
    transform(code, id) {
      if (!/@excalidraw[\\/_]excalidraw/.test(id) || !/\.js(?:\?.*)?$/.test(id)) return null;
      const patched = code
        .replace(/([A-Za-z0-9_$]+)\.push\(new URL\([^()]*ASSETS_FALLBACK_URL\)\)/g, "$1")
        .replace(
          /("Virgil"\s*,\s*\.\.\.[A-Za-z0-9_$]+\))\s*([,;])\s*[A-Za-z0-9_$]+\(\s*[A-Za-z0-9_$]+\s*,\s*\.\.\.[A-Za-z0-9_$]+\)/g,
          "$1$2 void 0",
        );
      return patched === code ? null : { code: patched, map: null };
    },
    configureServer(server) {
      server.middlewares.use("/excalidraw-assets/fonts/", (req, res, next) => {
        const rel = decodeURIComponent((req.url ?? "").split("?")[0] ?? "").replace(/^\/+/, "");
        if (!rel || rel.includes("..")) return next();
        const file = join(fontsRoot, rel);
        if (!existsSync(file) || !statSync(file).isFile()) return next();
        const ext = extname(file).toLowerCase();
        res.setHeader(
          "Content-Type",
          ext === ".woff2" ? "font/woff2" : ext === ".ttf" ? "font/ttf" : "application/octet-stream",
        );
        res.end(readFileSync(file));
      });
    },
    generateBundle() {
      if (!existsSync(fontsRoot)) return;
      for (const family of EXCALIDRAW_COMPACT_FONT_FAMILIES) {
        const dir = join(fontsRoot, family);
        if (!existsSync(dir)) continue;
        for (const entry of readdirSync(dir)) {
          const full = join(dir, entry);
          if (!statSync(full).isFile()) continue;
          this.emitFile({
            type: "asset",
            fileName: `excalidraw-assets/fonts/${family}/${entry}`,
            source: readFileSync(full),
          });
        }
      }
    },
  };
}

export default defineConfig({
  main: {
    // `ws` loads its optional native accelerators (bufferutil, utf-8-validate)
    // inside `require` + try/catch and falls back to its own JavaScript
    // implementation when they are absent. A bundle cannot fail a require, and
    // Vite turns the unresolved optional peer into a module-level throw that
    // kills the whole Main bundle before the app starts, so state the documented
    // "no native accelerator" input to that branch at build time instead.
    define: {
      "process.env.WS_NO_BUFFER_UTIL": "\"1\"",
      "process.env.WS_NO_UTF_8_VALIDATE": "\"1\"",
      // The main bundle is ESM (`type: module`), where Node does not provide
      // the CommonJS `__dirname` global used by Electron's relative asset paths.
      "__dirname": "import.meta.dirname",
    },
    build: {
      minify: "esbuild",
      rollupOptions: {
        // Bundle JS workspace packages into Main. Native voice modules must
        // resolve from packaged node_modules because their loaders locate
        // platform libraries relative to their own package directories.
        // jiti is loaded lazily by the sidecar's trusted-extension loader
        // (D387); Electron main never calls it, and its transpiled dist
        // breaks the main bundle's esbuild transform.
        external: [
          "original-fs",
          "electron-updater",
          "jiti",
          "jiti/static",
          "@picovoice/pvrecorder-node",
          "transcribe-cpp",
          // mc-agent (MC-ADR-0005): the work-panel terminal's native PTY.
          "node-pty",
        ],
        input: {
          index: resolve(__dirname, "electron/main/entry.ts"),
          // Forked per plugin by PluginRuntime (ADR 0008); must stay a
          // standalone entry so utilityProcess can point at a real file.
          "plugin-host-process": resolve(__dirname, "electron/main/plugin-host-process.mjs"),
        },
      },
    },
  },
  preload: {
    // The preload must be a fully bundled CJS file so it can run in a
    // sandboxed renderer without Node module resolution.
    build: {
      minify: "esbuild",
      rollupOptions: {
        input: {
          index: resolve(__dirname, "electron/preload/index.ts"),
          "plugin-panel": resolve(__dirname, "electron/preload/plugin-panel.ts"),
        },
        output: {
          format: "cjs",
          // Main window preload stays .cjs; plugin panels use .js as referenced by panel host.
          entryFileNames: (chunk) =>
            chunk.name === "plugin-panel" ? "[name].js" : "[name].cjs",
        },
      },
    },
  },
  renderer: {
    root: ".",
    build: {
      // electron-vite's renderer preset hard-defaults minify to false, unlike
      // plain Vite. Enabling esbuild minification roughly halves the emitted
      // renderer chunks with no behavior change.
      minify: "esbuild",
      rollupOptions: {
        input: {
          index: resolve(__dirname, "index.html"),
        },
      },
    },
    plugins: [
      react(),
      tailwindcss(),
      tightenCsp(),
      dropLegacyFontFallbacks(),
      bundleOfflineExcalidrawAssets(),
    ],
    resolve: {
      alias: [
        { find: "@renderer", replacement: resolve("src") },
        {
          find: /^@pi-desktop\/i18n\/locales\/([^/]+)$/,
          replacement: resolve(
            __dirname,
            "../../packages/i18n/src/locales/$1/index.ts",
          ),
        },
        {
          find: "@pi-desktop/i18n/locale-info",
          replacement: resolve(
            __dirname,
            "../../packages/i18n/src/locale-info.ts",
          ),
        },
        // Always read locale source so new keys work without a stale packages/*/dist.
        {
          find: "@pi-desktop/i18n",
          replacement: resolve(__dirname, "../../packages/i18n/src/index.ts"),
        },
      ],
    },
  },
});
