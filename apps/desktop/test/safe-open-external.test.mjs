import { readMainModuleSync } from "./helpers/source-contracts.mjs";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { register } from "node:module";
import { dirname, join, relative, sep } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
register(pathToFileURL(join(here, "helpers/ts-import-hooks.mjs")));

const {
  DISALLOWED_EXTERNAL_URL,
  isAllowedExternalUrl,
  isAllowedHttpUrl,
  openAllowedExternal,
  parseAllowedExternalUrl,
} = await import("../electron/main/safe-open-external.ts");

const read = (rel) => readFileSync(join(here, rel), "utf8");
const desktopServicesSource = readMainModuleSync("services/desktop-services.ts");
const windowSource = readMainModuleSync("bootstrap/window.ts");
const appIpcSource = readMainModuleSync("ipc/app-ipc.ts");
const mainIndexSource = readMainModuleSync("index.ts");
const runtimeSource = read("../electron/main/plugin-runtime.ts");
const browserSource = read("../electron/main/browser-view.ts");

test("parseAllowedExternalUrl permits http, https, and mailto", () => {
  assert.equal(
    parseAllowedExternalUrl("https://github.com/vastsa/PI-Desktop"),
    "https://github.com/vastsa/PI-Desktop",
  );
  assert.equal(parseAllowedExternalUrl("https://claude.ai"), "https://claude.ai/");
  assert.equal(
    parseAllowedExternalUrl("http://localhost:3000/docs"),
    "http://localhost:3000/docs",
  );
  assert.equal(
    parseAllowedExternalUrl("http://127.0.0.1:8080/api?query=hello#test"),
    "http://127.0.0.1:8080/api?query=hello#test",
  );
  assert.equal(
    parseAllowedExternalUrl("mailto:security@example.com"),
    "mailto:security@example.com",
  );
  assert.equal(
    parseAllowedExternalUrl("MAILTO:user@example.com?subject=hi"),
    "mailto:user@example.com?subject=hi",
  );
  assert.equal(parseAllowedExternalUrl("  HTTPS://EXAMPLE.COM/a  "), "https://example.com/a");
  assert.equal(isAllowedExternalUrl("https://example.com"), true);
  assert.equal(isAllowedHttpUrl("https://example.com"), true);
  assert.equal(isAllowedHttpUrl("mailto:user@example.com"), false);
});

test("parseAllowedExternalUrl blocks file, script, and custom schemes", () => {
  const blocked = [
    "file:///etc/passwd",
    "file:///C:/Windows/System32/cmd.exe",
    "file://localhost/Users/admin/.ssh/id_rsa",
    "FILE:///path/to/script.sh",
    "ms-msdt:/id%20PCWDiagnostic",
    "search-ms:query=calc.exe",
    "custom-scheme://execute?cmd=calc",
    "ssh://user@attacker.com",
    "telnet://attacker.com:23",
    "javascript:alert(1)",
    "JAVASCRIPT:console.log('xss')",
    "data:text/html,<script>alert(1)</script>",
    "vbscript:msgbox('hi')",
    "https:alert(1)",
    "http:",
    "http://",
    "mailto:",
  ];
  for (const url of blocked) {
    assert.equal(parseAllowedExternalUrl(url), null, url);
  }
});

test("parseAllowedExternalUrl rejects malformed or control-character input", () => {
  const blocked = ["", "   ", null, undefined, ":::invalid", "not-a-url", 12345, "https://example.com\nfile:///etc/passwd"];
  for (const input of blocked) {
    assert.equal(parseAllowedExternalUrl(input), null, String(input));
  }
});

test("openAllowedExternal calls the opener only for allowlisted hrefs and throws otherwise", async () => {
  const calls = [];
  const mockOpen = async (url) => {
    calls.push(url);
  };

  assert.equal(
    await openAllowedExternal("https://example.com/path", mockOpen),
    "https://example.com/path",
  );
  assert.equal(await openAllowedExternal("mailto:a@b.test", mockOpen), "mailto:a@b.test");
  await assert.rejects(
    () => openAllowedExternal("file:///etc/passwd", mockOpen),
    (error) => error instanceof Error && error.message === DISALLOWED_EXTERNAL_URL,
  );
  await assert.rejects(() => openAllowedExternal("ms-msdt:foo", mockOpen));
  assert.deepEqual(calls, ["https://example.com/path", "mailto:a@b.test"]);
});

// Where the OS is actually asked to open a URL. Each file that calls
// `shell.openExternal` directly must take its URL from the shared allowlist
// (or, for the listed exceptions, only ever pass fixed URLs). The check is on
// structure, not formatting: rewrite a call site freely, but a new file that
// reaches the OS fails here until it routes through safe-open-external.
const FIXED_URL_ONLY = new Map([
  // macOS System Settings deep links (x-apple.systempreferences:), constants.
  ["main/ipc/mc-permissions-ipc.ts", "fixed System Settings URLs"],
]);

function sourceFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.(ts|tsx|mts|cts)$/.test(entry.name) && !/\.test\./.test(entry.name) ? [path] : [];
  });
}

test("every direct shell.openExternal call takes its URL from the shared allowlist", () => {
  const electronRoot = join(here, "../electron");
  const callers = sourceFiles(electronRoot)
    .map((path) => ({ rel: relative(electronRoot, path).split(sep).join("/"), source: readFileSync(path, "utf8") }))
    .filter(({ source }) => /\bshell\.openExternal\s*\(/.test(source));
  assert.ok(callers.length > 0, "no openExternal callers found; did the layout change?");
  for (const { rel, source } of callers) {
    if (FIXED_URL_ONLY.has(rel)) {
      assert.doesNotMatch(source, /safe-open-external/, `${rel}: drop it from FIXED_URL_ONLY if it now takes outside URLs`);
      continue;
    }
    assert.match(
      source,
      /from "\.{1,2}(?:\/\.\.)*\/safe-open-external"/,
      `${rel} calls shell.openExternal without the shared allowlist; use parseAllowedExternalUrl or openAllowedExternal`,
    );
    assert.match(source, /\b(?:parseAllowedExternalUrl|openAllowedExternal)\s*\(/, `${rel} imports but never applies the allowlist`);
  }
});

test("renderer and plugin entry points reach the OS only through the allowlist", () => {
  // These hand renderer- or plugin-supplied strings onward; none may call the
  // OS itself, and each must route through the shared gate.
  for (const [name, source] of [
    ["bootstrap/window.ts", windowSource],
    ["index.ts", mainIndexSource],
    ["ipc/app-ipc.ts", appIpcSource],
  ]) {
    assert.doesNotMatch(source, /\bshell\.openExternal\s*\(/, name);
    assert.match(source, /\bsafeOpenExternal\s*\(/, name);
  }
  assert.match(desktopServicesSource, /parseAllowedExternalUrl\(rawUrl\)/);
  // The plugin runtime must not grow its own scheme regex beside the gate.
  const gateStart = runtimeSource.indexOf("openExternal: async (url: string)");
  assert.ok(gateStart >= 0, "plugin runtime openExternal gate not found");
  const gate = runtimeSource.slice(gateStart, runtimeSource.indexOf("net: {", gateStart));
  assert.match(gate, /parseAllowedExternalUrl\(url\)/);
  assert.doesNotMatch(gate, /\^https\?:|\^mailto:/);
  // In-app browser: file: URLs go to openPath, never openExternal.
  assert.match(browserSource, /shell\.openPath\(fileURLToPath\(url\)\)/);
});
