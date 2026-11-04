import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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


function signedFixture(path, version) {
  mkdirSync(join(path, "Contents", "MacOS"), { recursive: true });
  copyFileSync("/usr/bin/true", join(path, "Contents", "MacOS", "fixture"));
  writeFileSync(join(path, "Contents", "Info.plist"), `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>test.mc-update</string>
<key>CFBundleExecutable</key><string>fixture</string>
<key>CFBundleShortVersionString</key><string>${version}</string>
<key>CFBundlePackageType</key><string>APPL</string>
</dict></plist>`);
  assert.equal(spawnSync("/usr/bin/codesign", ["--force", "--sign", "-", path]).status, 0);
}

const macOnly = { skip: process.platform !== "darwin" };
for (const scenario of ["success", "corrupt", "wrong-version", "copy-failure", "open-failure", "existing-backup"]) {
  test(`mc-agent: verified bundle replacement: ${scenario}`, macOnly, () => {
    const root = mkdtempSync(join(tmpdir(), "mc-self-update-"));
    try {
      const target = join(root, "Apps with spaces", "mc-agent.app");
      const staged = join(root, "update", "app", "mc-agent.app");
      signedFixture(target, "1.0.0");
      signedFixture(staged, "1.0.1");
      const original = readFileSync(join(target, "Contents", "Info.plist"), "utf8");
      if (scenario === "corrupt") rmSync(join(staged, "Contents", "MacOS"), { recursive: true });
      if (scenario === "copy-failure") rmSync(staged, { recursive: true });
      if (scenario === "existing-backup") mkdirSync(`${target}.mc-update-backup`);
      const script = join(root, "install.sh");
      writeFileSync(script, installScript().replace('/usr/bin/open "$TARGET" || exit 1',
        scenario === "open-failure" ? 'false || exit 1' : 'echo opened > "$TARGET.opened"'));
      assert.equal(spawnSync("/bin/sh", ["-n", script]).status, 0);
      const done = spawnSync("/bin/sh", [script, "999999", target, staged, "test.mc-update", scenario === "wrong-version" ? "1.0.2" : "1.0.1"]);
      assert.equal(done.status, scenario === "success" ? 0 : 1, done.stderr.toString());
      assert.equal(spawnSync("/usr/bin/codesign", ["--verify", "--deep", "--strict", target]).status, 0);
      assert.equal(existsSync(`${target}.mc-update-lock`), false);
      if (scenario === "success") {
        assert.match(readFileSync(join(target, "Contents", "Info.plist"), "utf8"), /1.0.1/);
        assert.equal(existsSync(`${target}.mc-update-backup`), false);
        assert.equal(existsSync(`${target}.opened`), true);
        assert.equal(existsSync(join(root, "update", "app")), false);
      } else {
        assert.equal(readFileSync(join(target, "Contents", "Info.plist"), "utf8"), original);
        assert.equal(existsSync(`${target}.opened`), false);
        if (scenario === "existing-backup") assert.equal(existsSync(`${target}.mc-update-backup`), true);
      }
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
}

test("mc-agent: a second installer cannot move or delete the first installer's files", macOnly, async () => {
  const root = mkdtempSync(join(tmpdir(), "mc-self-update-race-"));
  const parent = spawn("/bin/sleep", ["30"]);
  let first;
  try {
    const target = join(root, "mc-agent.app");
    const staged = join(root, "stage", "mc-agent.app");
    signedFixture(target, "1.0.0");
    signedFixture(staged, "1.0.1");
    const script = join(root, "install.sh");
    writeFileSync(script, installScript().replace('/usr/bin/open "$TARGET" || exit 1', 'echo opened > "$TARGET.opened"'));
    const args = [script, String(parent.pid), target, staged, "test.mc-update", "1.0.1"];
    first = spawn("/bin/sh", args);
    const ended = new Promise(resolve => first.once("close", resolve));
    for (let n = 0; n < 100 && !existsSync(`${target}.mc-update-lock`); n++) await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(existsSync(`${target}.mc-update-lock`), true);
    assert.equal(spawnSync("/bin/sh", args).status, 1);
    assert.equal(existsSync(staged), true);
    assert.equal(existsSync(`${target}.mc-update-lock`), true);
    parent.kill();
    assert.equal(await ended, 0);
    assert.equal(spawnSync("/usr/bin/codesign", ["--verify", "--deep", "--strict", target]).status, 0);
    assert.equal(existsSync(`${target}.mc-update-backup`), false);
    assert.equal(existsSync(`${target}.mc-update-lock`), false);
  } finally {
    parent.kill();
    first?.kill();
    rmSync(root, { recursive: true, force: true });
  }
});

// Release CI supplies the actual archive, so the installation path is checked too.
test("mc-agent: the published ZIP survives extraction and verified replacement", {
  skip: process.platform !== "darwin" || !process.env.MC_UPDATE_ZIP,
}, () => {
  const root = mkdtempSync(join(tmpdir(), "mc-release-update-"));
  try {
    const stagedRoot = join(root, "stage");
    assert.equal(spawnSync("/usr/bin/ditto", ["-x", "-k", process.env.MC_UPDATE_ZIP, stagedRoot]).status, 0);
    const staged = join(stagedRoot, "mc-agent.app");
    const target = join(root, "installed", "mc-agent.app");
    assert.equal(spawnSync("/usr/bin/ditto", [staged, target]).status, 0);
    const plist = join(staged, "Contents", "Info.plist");
    const value = key => spawnSync("/usr/bin/plutil", ["-extract", key, "raw", "-o", "-", plist], { encoding: "utf8" }).stdout.trim();
    const id = value("CFBundleIdentifier");
    const version = value("CFBundleShortVersionString");
    assert.ok(id && version);
    const script = join(root, "install.sh");
    writeFileSync(script, installScript().replace('/usr/bin/open "$TARGET" || exit 1', 'echo opened > "$TARGET.opened"'));
    const result = spawnSync("/bin/sh", [script, "999999", target, staged, id, version]);
    assert.equal(result.status, 0, result.stderr.toString());
    assert.equal(spawnSync("/usr/bin/codesign", ["--verify", "--deep", "--strict", target]).status, 0);
    assert.ok(existsSync(join(target, "Contents", "MacOS", "mc-agent")));
    assert.ok(existsSync(`${target}.opened`));
  } finally { rmSync(root, { recursive: true, force: true }); }
});
