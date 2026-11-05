import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const require = createRequire(import.meta.url);
const { signingOrder } = require("../../../scripts/mc-sign-mac-bundle.cjs");

const MACHO = Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 0x0c, 0x00, 0x00, 0x01]);
// Universal magic, 2 architectures.
const UNIVERSAL = Buffer.from([0xca, 0xfe, 0xba, 0xbe, 0x00, 0x00, 0x00, 0x02]);
// The same magic, class file version 52.
const JAVA_CLASS = Buffer.from([0xca, 0xfe, 0xba, 0xbe, 0x00, 0x00, 0x00, 0x34]);

function put(root, path, content) {
  const file = join(root, path);
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, content);
  return file;
}

test("every signed item comes before the bundle that seals it, and non-code is skipped", () => {
  const dir = mkdtempSync(join(tmpdir(), "mc-sign-"));
  try {
    const app = join(dir, "x.app");
    const main = put(app, "Contents/MacOS/x", MACHO);
    const host = put(app, "Contents/Resources/bin/host", UNIVERSAL);
    const helper = join(app, "Contents/Frameworks/x Helper.app");
    const helperMain = put(helper, "Contents/MacOS/x Helper", MACHO);
    const version = join(app, "Contents/Frameworks/E.framework/Versions/A");
    const framework = put(version, "E", MACHO);
    const library = put(version, "Libraries/l.dylib", MACHO);
    put(app, "Contents/Resources/a.class", JAVA_CLASS);
    put(app, "Contents/Resources/app.asar", "text content");
    put(app, "Contents/Resources/empty", "");
    symlinkSync(framework, join(app, "Contents/Frameworks/E.framework/E"));

    const order = signingOrder(app);
    assert.deepEqual(new Set(order), new Set([app, main, host, helper, helperMain, version, framework, library]));
    assert.equal(order.at(-1), app, "the app is sealed last");
    assert.ok(order.indexOf(helperMain) < order.indexOf(helper));
    assert.ok(order.indexOf(framework) < order.indexOf(version));
    assert.ok(order.indexOf(library) < order.indexOf(version));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a release must carry the fixed certificate", () => {
  const workflow = readFileSync(new URL("../../../.github/workflows/mc-release.yml", import.meta.url), "utf8");
  assert.ok(
    workflow.indexOf("mc-import-mac-signing-cert.sh") < workflow.indexOf("scripts/mc-release.mjs"),
    "the certificate loads before the build",
  );
  const release = readFileSync(new URL("../../../scripts/mc-release.mjs", import.meta.url), "utf8");
  assert.match(release, /-c\.afterSign=\.\.\/\.\.\/scripts\/mc-sign-mac-bundle\.cjs/);
  assert.match(release, /SIGNING_CERT_SHA1 = "[0-9a-f]{40}"/);
  assert.match(release, /--ad-hoc builds cannot be published/);
});
