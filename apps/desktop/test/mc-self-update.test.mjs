import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

register("./helpers/ts-import-hooks.mjs", import.meta.url);
const { bundleOf, installScript, releaseZip } = await import("../electron/main/mc-self-update.ts");

const FEED = `version: 1.0.1
files:
  - url: mc-agent-1.0.1-arm64-mac.zip
    sha512: ZIPHASH==
    size: 133545734
  - url: mc-agent-1.0.1-arm64.dmg
    sha512: DMGHASH==
    size: 134472132
path: mc-agent-1.0.1-arm64-mac.zip
sha512: ZIPHASH==
releaseDate: '2026-10-21T15:56:55.497Z'
`;

test("mc-agent: the release zip for this architecture comes from latest-mac.yml", () => {
  assert.deepEqual(releaseZip(FEED, "arm64"), { url: "mc-agent-1.0.1-arm64-mac.zip", sha512: "ZIPHASH==", size: 133545734 });
  assert.equal(releaseZip(FEED, "x64"), null);
  assert.equal(releaseZip("version: 1.0.1\n", "arm64"), null);
});

test("mc-agent: the running bundle is found from the executable path", () => {
  assert.equal(bundleOf("/Applications/mc-agent.app/Contents/MacOS/mc-agent"), "/Applications/mc-agent.app");
  assert.equal(bundleOf("/usr/local/bin/node"), null);
});

test("mc-agent: the install script waits for the app, swaps the bundle and keeps the old one on failure", { skip: process.platform !== "darwin" || !existsSync("/usr/bin/ditto") }, () => {
  const root = mkdtempSync(join(tmpdir(), "mc-self-update-"));
  try {
    const target = join(root, "Apps", "mc-agent.app");
    const staged = join(root, "update", "app", "mc-agent.app");
    mkdirSync(join(target, "Contents"), { recursive: true });
    mkdirSync(join(staged, "Contents"), { recursive: true });
    writeFileSync(join(target, "Contents", "v"), "old");
    writeFileSync(join(staged, "Contents", "v"), "new");
    const script = join(root, "install.sh");
    writeFileSync(script, installScript().replace('/usr/bin/open "$TARGET"', 'echo opened > "$TARGET.opened"'));
    assert.equal(spawnSync("/bin/sh", ["-n", script]).status, 0);
    // A pid that has already exited: the swap runs at once.
    const done = spawnSync("/bin/sh", [script, "999999", target, staged]);
    assert.equal(done.status, 0);
    assert.equal(readFileSync(join(target, "Contents", "v"), "utf8"), "new");
    assert.equal(existsSync(`${target}.mc-update-backup`), false);
    assert.equal(existsSync(`${target}.opened`), true);
    assert.equal(existsSync(join(root, "update", "app")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
