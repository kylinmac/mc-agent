import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { releaseFiles, verifyRelease } from "./mc-verify-release.mjs";

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "mc-release-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const version = "1.0.11";
  for (const name of releaseFiles(version)) writeFileSync(join(dir, name), name);
  for (const [name, target] of [["latest.yml", `mc-agent-Update-${version}.exe`],
    ["latest-mac.yml", `mc-agent-${version}-arm64-mac.zip`]]) {
    const bytes = readFileSync(join(dir, target));
    const sha512 = createHash("sha512").update(bytes).digest("base64");
    writeFileSync(join(dir, name), JSON.stringify({ version, path: target, sha512,
      files: [{ url: target, sha512, size: bytes.length }] }));
  }
  return { dir, version };
}

test("accepts complete same-version artifacts and uploaded digests", t => {
  const { dir, version } = fixture(t);
  const remote = { assets: releaseFiles(version).map(name => {
    const bytes = readFileSync(join(dir, name));
    return { name, size: bytes.length, digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}` };
  }) };
  assert.equal(verifyRelease(version, dir, remote).length, 11);
  remote.assets[0].digest = "sha256:wrong";
  assert.throws(() => verifyRelease(version, dir, remote), /Remote hash/);
});

test("rejects missing or stale assets", t => {
  const { dir, version } = fixture(t);
  writeFileSync(join(dir, "mc-agent-1.0.10-arm64.dmg"), "old");
  assert.throws(() => verifyRelease(version, dir), /exactly both platforms/);
  rmSync(join(dir, "mc-agent-1.0.10-arm64.dmg"));
  rmSync(join(dir, `mc-agent-Setup-${version}.exe`));
  assert.throws(() => verifyRelease(version, dir), /exactly both platforms/);
});

test("rejects corrupt update payloads", t => {
  const { dir, version } = fixture(t);
  writeFileSync(join(dir, `mc-agent-Update-${version}.exe`), "corrupt");
  assert.throws(() => verifyRelease(version, dir), /invalid legacy hash/);
});

test("rejects a feed from another version", t => {
  const { dir, version } = fixture(t);
  const path = join(dir, "latest-mac.yml");
  const feed = JSON.parse(readFileSync(path));
  feed.version = "1.0.10";
  writeFileSync(path, JSON.stringify(feed));
  assert.throws(() => verifyRelease(version, dir), /version mismatch/);
});

test("rejects invalid version input", () => {
  for (const version of ["v1.0.11", "../1.0.11", "1.0.11;echo", "01.0.11"]) {
    assert.throws(() => releaseFiles(version));
  }
});
