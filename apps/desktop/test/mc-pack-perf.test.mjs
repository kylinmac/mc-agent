import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { shouldPollBackgroundShells } from "../src/features/work-tools/background-poll-policy.ts";

const require = createRequire(import.meta.url);
const { normalizeArch, pruneUnpackedNativeModules } = require("../build/mc-prune-pack.cjs");

function touch(root, rel) {
  const full = join(root, rel);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, "binary");
  return full;
}

function seedNativeTree(root) {
  for (const rel of [
    "@picovoice/pvrecorder-node/lib/mac/arm64/pv_recorder.node",
    "@picovoice/pvrecorder-node/lib/mac/x86_64/pv_recorder.node",
    "@picovoice/pvrecorder-node/lib/linux/x86_64/pv_recorder.node",
    "@picovoice/pvrecorder-node/lib/raspberry-pi/cortex-a72/pv_recorder.node",
    "@picovoice/pvrecorder-node/lib/windows/amd64/pv_recorder.node",
    "@picovoice/pvrecorder-node/lib/windows/arm64/pv_recorder.node",
    "node-pty/build/Release/pty.node",
    "node-pty/prebuilds/darwin-arm64/pty.node",
    "node-pty/prebuilds/darwin-x64/pty.node",
    "node-pty/prebuilds/win32-x64/pty.node",
    "node-pty/prebuilds/win32-arm64/pty.node",
  ]) {
    touch(root, rel);
  }
}

test("afterPack native pruner keeps only the target platform and arch", () => {
  assert.equal(normalizeArch(1), "x64");
  assert.equal(normalizeArch(3), "arm64");
  assert.equal(normalizeArch(4), "universal");

  const darwinDir = mkdtempSync(join(tmpdir(), "mc-prune-mac-"));
  const winDir = mkdtempSync(join(tmpdir(), "mc-prune-win-"));
  const uniDir = mkdtempSync(join(tmpdir(), "mc-prune-uni-"));
  try {
    seedNativeTree(darwinDir);
    const macResult = pruneUnpackedNativeModules({
      unpackedNodeModules: darwinDir,
      platform: "darwin",
      arch: 3,
    });
    assert.equal(macResult.arch, "arm64");
    assert.ok(macResult.pvRemoved > 0 && macResult.ptyRemoved > 0);
    assert.ok(existsSync(join(darwinDir, "@picovoice/pvrecorder-node/lib/mac/arm64/pv_recorder.node")));
    assert.ok(!existsSync(join(darwinDir, "@picovoice/pvrecorder-node/lib/mac/x86_64")));
    assert.ok(!existsSync(join(darwinDir, "@picovoice/pvrecorder-node/lib/raspberry-pi")));
    assert.ok(!existsSync(join(darwinDir, "@picovoice/pvrecorder-node/lib/windows")));
    assert.ok(existsSync(join(darwinDir, "node-pty/build/Release/pty.node")));
    assert.ok(existsSync(join(darwinDir, "node-pty/prebuilds/darwin-arm64/pty.node")));
    assert.ok(!existsSync(join(darwinDir, "node-pty/prebuilds/win32-x64")));

    seedNativeTree(winDir);
    pruneUnpackedNativeModules({ unpackedNodeModules: winDir, platform: "win32", arch: "x64" });
    assert.ok(existsSync(join(winDir, "@picovoice/pvrecorder-node/lib/windows/amd64/pv_recorder.node")));
    assert.ok(!existsSync(join(winDir, "@picovoice/pvrecorder-node/lib/windows/arm64")));
    assert.ok(!existsSync(join(winDir, "@picovoice/pvrecorder-node/lib/mac")));
    assert.ok(existsSync(join(winDir, "node-pty/prebuilds/win32-x64/pty.node")));
    assert.ok(!existsSync(join(winDir, "node-pty/prebuilds/darwin-arm64")));

    seedNativeTree(uniDir);
    pruneUnpackedNativeModules({ unpackedNodeModules: uniDir, platform: "darwin", arch: 4 });
    assert.ok(existsSync(join(uniDir, "@picovoice/pvrecorder-node/lib/mac/arm64/pv_recorder.node")));
    assert.ok(existsSync(join(uniDir, "@picovoice/pvrecorder-node/lib/mac/x86_64/pv_recorder.node")));
    assert.ok(!existsSync(join(uniDir, "@picovoice/pvrecorder-node/lib/linux")));
    assert.ok(existsSync(join(uniDir, "node-pty/prebuilds/darwin-arm64/pty.node")));
    assert.ok(existsSync(join(uniDir, "node-pty/prebuilds/darwin-x64/pty.node")));
    assert.ok(!existsSync(join(uniDir, "node-pty/prebuilds/win32-x64")));
  } finally {
    rmSync(darwinDir, { recursive: true, force: true });
    rmSync(winDir, { recursive: true, force: true });
    rmSync(uniDir, { recursive: true, force: true });
  }
});

test("afterPack native pruner refuses to delete files if target binary is missing", () => {
  const dir = mkdtempSync(join(tmpdir(), "mc-prune-guard-"));
  try {
    touch(dir, "@picovoice/pvrecorder-node/lib/linux/x86_64/pv_recorder.node");
    touch(dir, "node-pty/prebuilds/win32-x64/pty.node");
    const result = pruneUnpackedNativeModules({
      unpackedNodeModules: dir,
      platform: "darwin",
      arch: "arm64",
    });
    assert.equal(result.pvRemoved, 0);
    assert.equal(result.ptyRemoved, 0);
    assert.ok(existsSync(join(dir, "@picovoice/pvrecorder-node/lib/linux/x86_64/pv_recorder.node")));
    assert.ok(existsSync(join(dir, "node-pty/prebuilds/win32-x64/pty.node")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("release slimming config and startup decoupling invariants stay wired", async () => {
  const cargo = readFileSync(new URL("../../../Cargo.toml", import.meta.url), "utf8");
  assert.match(cargo, /\[profile\.release\][\s\S]*strip = true/);
  assert.match(cargo, /lto = "thin"/);
  assert.match(cargo, /codegen-units = 1/);
  assert.match(cargo, /panic = "abort"/);

  const vite = readFileSync(new URL("../electron.vite.config.ts", import.meta.url), "utf8");
  assert.equal((vite.match(/minify:\s*"esbuild"/g) ?? []).length, 3);

  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(pkg.build.afterPack, "./build/mc-prune-pack.cjs");
  assert.ok(pkg.build.files.includes("!**/node_modules/koffi/vendor/**"));

  const desktopDir = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
  const repoRoot = dirname(fileURLToPath(new URL("../../../package.json", import.meta.url)));
  const desktopRequire = createRequire(join(desktopDir, "package.json"));
  const { resolveFunction } = desktopRequire("app-builder-lib/out/util/resolve");
  const prevCwd = process.cwd();
  process.chdir(desktopDir);
  try {
    assert.equal(typeof (await resolveFunction(undefined, pkg.build.afterPack, "afterPack", desktopDir)), "function");
    assert.equal(typeof (await resolveFunction(undefined, pkg.build.afterPack, "afterPack", repoRoot)), "function");
    await assert.rejects(
      () => resolveFunction(undefined, "../../scripts/mc-prune-pack.cjs", "afterPack", desktopDir),
      /resolves outside the workspace root/,
    );
  } finally {
    process.chdir(prevCwd);
  }

  const agentHook = readFileSync(new URL("../src/features/work-tools/use-work-panel-agent.ts", import.meta.url), "utf8");
  assert.doesNotMatch(agentHook, /^import\s+.*from\s+["']\.\/TerminalTab["']/m);
  assert.match(agentHook, /import\(["']\.\/TerminalTab["']\)/);
});

test("background shell poller stops when subscribed sessions are idle and wakes on running turns or shells", () => {
  const exited = {
    id: "b1",
    sessionId: "s1",
    command: "echo ok",
    cwd: "/w",
    status: "exited",
    exitCode: 0,
    startedAt: 1,
    endedAt: 2,
    outputSize: 3,
  };
  const running = { ...exited, status: "running", endedAt: null, exitCode: null };
  assert.equal(
    shouldPollBackgroundShells(["s1"], { s1: [exited] }, { activeSessionId: "s1", isRunning: false, runningSessions: {} }),
    false,
  );
  assert.equal(
    shouldPollBackgroundShells(["s1"], {}, { activeSessionId: "s1", isRunning: true, runningSessions: {} }),
    true,
  );
  assert.equal(
    shouldPollBackgroundShells(["s2"], {}, { activeSessionId: "s1", isRunning: false, runningSessions: { s2: true } }),
    true,
  );
  assert.equal(
    shouldPollBackgroundShells(["s1"], { s1: [running] }, { activeSessionId: "s1", isRunning: false, runningSessions: {} }),
    true,
  );
});
