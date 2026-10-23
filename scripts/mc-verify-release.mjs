import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";

const desktopRequire = createRequire(new URL("../apps/desktop/package.json", import.meta.url));
const { load } = createRequire(desktopRequire.resolve("electron-updater"))("js-yaml");

export function releaseFiles(version) {
  assert.match(version, /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/);
  const mac = `mc-agent-${version}-arm64`;
  const update = `mc-agent-Update-${version}.exe`;
  return ["latest.yml", "latest-mac.yml", `${mac}-mac.zip`, `${mac}-mac.zip.blockmap`,
    `${mac}.dmg`, `${mac}.dmg.blockmap`, update, `${update}.blockmap`,
    `mc-agent-Setup-${version}.exe`, `mc-agent-Portable-${version}.exe`,
    `mc-agent-Portable-${version}.zip`].sort();
}

export function verifyRelease(version, directory, remote) {
  const names = releaseFiles(version);
  assert.deepEqual(readdirSync(directory).sort(), names, "Release must contain exactly both platforms at this version");
  const files = new Map(names.map(name => [name, readFileSync(join(directory, name))]));
  for (const [name, bytes] of files) assert.ok(bytes.length, `Empty file: ${name}`);
  const hash = (name, algorithm, encoding) => createHash(algorithm).update(files.get(name)).digest(encoding);
  for (const [name, target] of [
    ["latest.yml", `mc-agent-Update-${version}.exe`],
    ["latest-mac.yml", `mc-agent-${version}-arm64-mac.zip`],
  ]) {
    const feed = load(files.get(name).toString());
    assert.equal(feed.version, version, `${name}: version mismatch`);
    assert.equal(feed.path, target, `${name}: wrong update target`);
    assert.equal(feed.sha512, hash(target, "sha512", "base64"), `${name}: invalid legacy hash`);
    assert.ok(Array.isArray(feed.files) && feed.files.some(file => file.url === target), `${name}: missing update entry`);
    for (const file of feed.files) {
      assert.ok(files.has(file.url), `${name}: unknown file ${file.url}`);
      assert.equal(file.sha512, hash(file.url, "sha512", "base64"), `${name}: invalid hash for ${file.url}`);
      assert.equal(file.size, files.get(file.url).length, `${name}: invalid size for ${file.url}`);
    }
  }
  if (remote) {
    assert.deepEqual(remote.assets.map(asset => asset.name).sort(), names, "Remote asset list differs");
    for (const asset of remote.assets) {
      assert.equal(asset.size, files.get(asset.name).length, `Remote size: ${asset.name}`);
      assert.equal(asset.digest, `sha256:${hash(asset.name, "sha256", "hex")}`, `Remote hash: ${asset.name}`);
    }
  }
  return names;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [, , version, directory, manifest] = process.argv;
  verifyRelease(version, directory, manifest ? JSON.parse(readFileSync(manifest, "utf8")) : undefined);
  console.log(`Verified macOS and Windows release ${version}${manifest ? " including uploaded assets" : ""}`);
}
