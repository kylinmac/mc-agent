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
