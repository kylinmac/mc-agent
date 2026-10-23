// Validation-only fixture: never invokes NSIS or modifies an installation.
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { buildWindowsInstaller } from "./build-windows-installer.mjs";

const root = await mkdtemp(join(tmpdir(), "mc-installer-paths-"));
const payload = join(root, "empty.exe");
const output = join(root, "validate.exe");
await writeFile(payload, "unused validation fixture");
await buildWindowsInstaller({ payload, output, version: "1.0.0", appId: "com.kylinmac.path-validation",
  executable: "fixture.exe", directory: "fixture", testFixture: true });
for (const [path, expected] of [
  ["C:\\Apps\\mc-agent", 0], ["C:\\安装 目录\\mc-agent", 0],
  ["C:\\", 1], ["C:\\.", 1], ["C:\\folder\\..", 1], ["C:/folder/../", 1],
  ["relative", 1], ["C:relative", 1], ["\\\\server\\share", 1], ["C:\\bad\"name", 1],
]) {
  const child = spawnSync(output, [`--test-validate-path=${path}`], { windowsHide: true, timeout: 10000 });
  assert.ifError(child.error);
  assert.equal(child.status, expected, `destination ${path}`);
}
console.log("PASS: 10 installer destination cases, without extraction or installation");
