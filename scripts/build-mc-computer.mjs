#!/usr/bin/env node
/**
 * mc-agent: build the Computer Use helper (crates/mc-computer) and put it in
 * the bundled plugin's `bin/`, where its manifest points
 * (docs/mc-agent/computer-use.md, MC-ADR-0014).
 *
 *   node scripts/build-mc-computer.mjs            debug build (dev)
 *   node scripts/build-mc-computer.mjs --release  release build (packaging)
 *
 * macOS and Windows have native backends; other platforms skip the helper.
 */
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const release = process.argv.includes("--release");

if (!["darwin", "win32"].includes(process.platform)) {
  console.log("[mc-computer] skipped: no backend for this platform yet");
  process.exit(0);
}

const args = ["build", "--locked", "-p", "mc-computer", ...(release ? ["--release"] : [])];
const built = spawnSync("cargo", args, { cwd: root, stdio: "inherit" });
if (built.status !== 0) process.exit(built.status ?? 1);

const executable = process.platform === "win32" ? "mc-computer.exe" : "mc-computer";
const source = join(root, "target", release ? "release" : "debug", executable);
const targetDir = join(root, "apps", "desktop", "resources", "plugins", "mc.computer-use", "bin");
mkdirSync(targetDir, { recursive: true });
const target = join(targetDir, executable);
copyFileSync(source, target);
if (process.platform !== "win32") chmodSync(target, 0o755);
console.log(`[mc-computer] ${release ? "release" : "debug"} build -> ${target}`);
