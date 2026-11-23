import assert from "node:assert/strict";
import { globSync, readFileSync } from "node:fs";
import { isBuiltin } from "node:module";
import { dirname, relative, resolve, sep } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const desktop = resolve(root, "apps/desktop");
const renderer = resolve(desktop, "src");
const headless = resolve(root, "apps/pi-host");
const shared = resolve(root, "packages/shared/src");
const voiceLive = resolve(root, "packages/voice-runtime/src/live");
const runtimePackages = ["agent-host", "agent-runtime", "host-runtime", "voice-runtime", "racp", "plugin-devkit"];
const hostRoots = [
  resolve(desktop, "electron"), headless,
  ...runtimePackages.map((name) => resolve(root, "packages", name)),
];
const hostPackages = [
  "electron", "@pi-desktop/pi-host",
  "@earendil-works/pi-agent-core", "@earendil-works/pi-ai", "@earendil-works/pi-coding-agent",
  ...runtimePackages.map((name) => "@pi-desktop/" + name),
];

function within(path, directory) {
  return path === directory || path.startsWith(directory + sep);
}

function localTarget(file, specifier) {
  if (specifier.startsWith("@renderer/")) return resolve(renderer, specifier.slice("@renderer/".length));
  if (specifier.startsWith("/src/")) return resolve(renderer, specifier.slice("/src/".length));
  return resolve(dirname(file), specifier);
}

function importsHost(file, specifier) {
  if (specifier === "@pi-desktop/voice-runtime/live") return false;
  if (isBuiltin(specifier) || specifier.startsWith("node:")) return true;
  if (hostPackages.some((name) => specifier === name || specifier.startsWith(name + "/"))) return true;
  const target = localTarget(file, specifier);
  return !within(target, voiceLive) && hostRoots.some((dir) => within(target, dir));
}

function importsDesktop(file, specifier) {
  return ["electron", "@pi-desktop/desktop"].some((name) => specifier === name || specifier.startsWith(name + "/"))
    || within(localTarget(file, specifier), desktop);
}

function violations(file, source, forbidden = importsHost) {
  return ts.preProcessFile(source, true, true).importedFiles
    .filter(({ fileName }) => forbidden(file, fileName))
    .map(({ fileName, pos }) => {
      const line = source.slice(0, pos).split("\n").length;
      return relative(root, file) + ":" + line + " → " + fileName;
    });
}

test("recognizes host imports, re-exports, require and literal dynamic imports", () => {
  const file = resolve(renderer, "example.ts");
  const source = [
    'import type { Stats } from "node:fs";',
    'export { readFile } from "fs/promises";',
    'void import("../electron/main/logger");',
    'require("@pi-desktop/agent-runtime/private");',
    'import type {} from "@renderer/../electron/preload";',
    'import type {} from "../../../packages/host-runtime/src";',
    'import "electron";',
    'import "@pi-desktop/voice-runtime";',
    'import "@earendil-works/pi-agent-core";',
    'import "@pi-desktop/voice-runtime/live";',
    'import type {} from "@pi-desktop/shared";',
    '// import "node:fs";',
    'const example = "require(\'electron\')";',
  ];
  assert.deepEqual(violations(file, source.join("\n")).map((entry) => entry.split(" → ")[1]), [
    "node:fs", "fs/promises", "../electron/main/logger", "@pi-desktop/agent-runtime/private",
    "@renderer/../electron/preload", "../../../packages/host-runtime/src", "electron", "@pi-desktop/voice-runtime",
    "@earendil-works/pi-agent-core",
  ]);
  const hostFile = resolve(headless, "src/app.ts");
  assert.equal(importsDesktop(hostFile, "../../desktop/electron/main/host-process"), true);
  assert.equal(importsDesktop(hostFile, "node:fs"), false);
});

function checkSources(directories, forbidden) {
  const failures = [];
  for (const cwd of directories) {
    const paths = globSync("**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}", { cwd })
      .filter((path) => !/\.(test|spec)\.[^.]+$/.test(path));
    assert.ok(paths.length > 0, "No source files under " + cwd);
    for (const path of paths) {
      const file = resolve(cwd, path);
      failures.push(...violations(file, readFileSync(file, "utf8"), forbidden));
    }
  }
  assert.deepEqual(failures, [], failures.join("\n"));
}

test("renderer and browser-facing contracts access host capabilities through the bridge", () => {
  checkSources([renderer, shared, voiceLive], importsHost);
});

test("headless host and runtime packages run independently of the desktop shell", () => {
  checkSources([headless, ...runtimePackages.map((name) => resolve(root, "packages", name))]
    .map((directory) => resolve(directory, "src")), importsDesktop);
});

function featureBoundaries(files) {
  const filesByPath = new Map(files);
  const imports = new Map();
  const edges = new Map();
  const failures = [];
  const parts = (file) => relative(renderer, file).split(sep);
  const sourceExtensions = [".ts", ".tsx", ".js", ".jsx", ".mts", ".cts", ".mjs", ".cjs"];
  function resolveSource(file, specifier) {
    const target = localTarget(file, specifier);
    if (filesByPath.has(target)) return target;
    const stem = target.replace(/\.[cm]?jsx?$/, "");
    return sourceExtensions.map((ext) => stem + ext)
      .concat(sourceExtensions.map((ext) => resolve(target, "index" + ext)))
      .find((path) => filesByPath.has(path));
  }
  for (const [file, source] of files) {
    const [layer, owner] = parts(file);
    const targets = [];
    for (const { fileName } of ts.preProcessFile(source, true, true).importedFiles) {
      if (!/^(\.\.?\/|@renderer\/|\/src\/)/.test(fileName)) continue;
      const resolved = resolveSource(file, fileName);
      if (resolved) targets.push(resolved);
      const [targetLayer, target, ...path] = parts(localTarget(file, fileName));
      if (targetLayer !== "features" || !target) continue;
      const edge = relative(renderer, file) + " → " + fileName;
      if (["stores", "lib", "hooks"].includes(layer)) failures.push("Shared code imports a feature: " + edge);
      const otherFeature = layer === "features" && owner !== target && owner !== "app";
      if ((layer === "components" || layer === "plugins" || otherFeature) && path.length > 1) {
        failures.push("Private feature import: " + edge);
      }
    }
    imports.set(file, targets);
  }

  // Start at all files of a feature; follow individual shared modules until the next feature.
  const roots = new Map();
  for (const file of imports.keys()) {
    const [layer, owner] = parts(file);
    if (layer !== "features") continue;
    if (!roots.has(owner)) roots.set(owner, []);
    roots.get(owner).push(file);
  }
  for (const [owner, entries] of roots) {
    const queue = [...entries];
    const predecessor = new Map(entries.map((file) => [file, null]));
    const outgoing = new Map();
    for (let i = 0; i < queue.length; i++) {
      const file = queue[i];
      for (const target of imports.get(file)) {
        if (predecessor.has(target)) continue;
        predecessor.set(target, file);
        const [layer, feature] = parts(target);
        if (layer !== "features") {
          queue.push(target);
        } else if (feature !== owner && !outgoing.has(feature)) {
          const route = [];
          for (let at = target; at; at = predecessor.get(at)) route.push(relative(renderer, at));
          outgoing.set(feature, route.reverse().join(" → "));
        }
      }
    }
    edges.set(owner, outgoing);
  }
  const finished = new Set();
  const active = new Set();
  function visit(owner, path) {
    if (finished.has(owner)) return;
    active.add(owner);
    for (const [next, route] of edges.get(owner) ?? []) {
      if (active.has(next)) {
        failures.push("Feature cycle: " + [...path, route].join(" | "));
      } else {
        visit(next, [...path, route]);
      }
    }
    active.delete(owner);
    finished.add(owner);
  }
  for (const owner of edges.keys()) visit(owner, []);
  return failures;
}

test("feature rules catch cycles, private imports and reverse dependencies", () => {
  const files = [
    ["features/a/View.tsx", 'export { value } from "../b/state/private";'],
    ["features/b/state/private.ts", 'void import("@renderer/features/a/View");'],
    ["hooks/useValue.ts", 'import type { Value } from "/src/features/b/state/private";'],
    ["components/Shared.tsx", 'import "../features/b/state/private";'],
    ["plugins/renderer-host/test.ts", 'import "../../features/b/state/private";'],
    ["components/Allowed.tsx", 'import "../features/b/public";'],
    ["features/app/AppShell.tsx", 'import "../a/internal/Panel";'],
  ].map(([file, source]) => [resolve(renderer, file), source]);
  assert.deepEqual(featureBoundaries(files).map((error) => error.split(":")[0]), [
    "Private feature import", "Shared code imports a feature", "Private feature import", "Private feature import", "Feature cycle",
  ]);
});

test("follows shared files and barrels between features without conflating unrelated components", () => {
  const fixture = (rows) => rows.map(([path, source]) => [resolve(renderer, path), source]);
  const files = fixture([
    ["features/a/view.ts", 'import "../../components/entry.js";'],
    ["components/entry.ts", 'export * from "./nested";'],
    ["components/nested/index.ts", 'void import("../../features/b/view");'],
    ["features/b/view.ts", 'import "../a/view";'],
    ["components/unrelated.ts", 'import "../features/a/view";'],
  ]);
  assert.match(featureBoundaries(files).join("\n"), /Feature cycle: .*components[/\\]nested[/\\]index\.ts/);
  const isolated = files.map(([path, source]) => [path, path.endsWith("entry.ts") ? "export {};" : source]);
  assert.deepEqual(featureBoundaries(isolated), []);
});

test("renderer features compose through public modules and have no cross-feature cycles through shared modules", () => {
  const files = globSync("**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}", { cwd: renderer })
    .filter((file) => !/\.(test|spec)\.[^.]+$/.test(file))
    .map((file) => [resolve(renderer, file), readFileSync(resolve(renderer, file), "utf8")]);
  const failures = featureBoundaries(files);
  assert.deepEqual(failures, [], failures.join("\n"));
});
