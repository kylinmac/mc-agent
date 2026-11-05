#!/usr/bin/env node
/**
 * mc-agent: build the macOS app and publish it as a GitHub Release that the
 * in-app updater reads (MC-ADR-0012).
 *
 * Usage:
 *   node scripts/mc-release.mjs <version> [--dry-run] [--skip-build] [--ad-hoc] [--arch arm64|x64]
 *
 *   <version>     semver for this release, e.g. 1.0.1 (mc-agent's own line,
 *                 starting at 1.0.0, MC-ADR-0012); must be newer than
 *                 the latest published release. Tagged as v<version>.
 *   --dry-run     build and check everything, but create no tag or release.
 *   --skip-build  reuse apps/desktop/release artifacts already built for
 *                 <version> (after a failed upload, say).
 *   --ad-hoc      local test builds without the certificate; never publishes.
 *
 * The version is stamped into the packaged app only (electron-builder
 * extraMetadata); the workspace package.json files keep upstream's version.
 * Builds are signed with a fixed self-signed certificate, not notarized (see
 * docs/mc-agent/cloud-release.md): macOS keeps the app's privacy grants across
 * releases. They stay marked notify-only for electron-updater; the app replaces
 * itself through mc-self-update.
 *
 * The release is created as a draft with every file attached and published
 * only after the upload finished, so the updater never sees a partial feed.
 */
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import process from "node:process";

const ROOT = resolve(import.meta.dirname, "..");
const DESKTOP = join(ROOT, "apps/desktop");
const RELEASE_DIR = join(DESKTOP, "release");
const REPO = "kylinmac/mc-agent";
const PRODUCT = "mc-agent";
// The certificate macOS identifies mc-agent by. Changing it makes every user
// grant folder and system permissions again, so a mismatch stops the release.
const SIGNING_CERT_SHA1 = "16f4a4b0d23e5d84c7e342d7d35b3937f975b834";
const BUNDLE_ID = "com.kylinmac.mc-agent";

function fail(message) {
  console.error(`\n✖ ${message}`);
  process.exit(1);
}

function step(message) {
  console.log(`\n▶ ${message}`);
}

/** Run a command; inherit output unless `capture` is set. */
function run(command, args, { cwd = ROOT, capture = false, env, allowFailure = false } = {}) {
  const result = spawnSync(command, args, {
    cwd,
    env: env ? { ...process.env, ...env } : process.env,
    encoding: "utf8",
    stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
  });
  if (result.status !== 0 && !allowFailure) {
    const detail = capture ? `\n${result.stderr || result.stdout}` : "";
    fail(`${command} ${args.join(" ")} failed (exit ${result.status})${detail}`);
  }
  return capture ? result.stdout.trim() : "";
}

function parseSemver(value) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(value ?? "");
  return match ? match.slice(1).map(Number) : null;
}

function newer(a, b) {
  for (let index = 0; index < 3; index++) {
    if (a[index] !== b[index]) return a[index] > b[index];
  }
  return false;
}

// ---- arguments --------------------------------------------------------------

const args = process.argv.slice(2);
const flags = new Set(args.filter((arg) => arg.startsWith("--")));
const archIndex = args.indexOf("--arch");
const arch = archIndex >= 0 ? args[archIndex + 1] : "arm64";
const version = args.find((arg, index) => !arg.startsWith("--") && args[index - 1] !== "--arch");
const dryRun = flags.has("--dry-run");
const skipBuild = flags.has("--skip-build");
const adHoc = flags.has("--ad-hoc");

if (process.platform !== "darwin") fail("releases are built on macOS");
if (!["arm64", "x64"].includes(arch)) fail(`unsupported arch: ${arch}`);
const parsed = parseSemver(version);
if (!parsed) fail("usage: node scripts/mc-release.mjs <major.minor.patch> [--dry-run] [--skip-build]");
const tag = `v${version}`;
if (adHoc && !dryRun) fail("--ad-hoc builds cannot be published; add --dry-run");
if (!adHoc && !skipBuild && !process.env.MC_MAC_SIGN_IDENTITY) {
  fail("MC_MAC_SIGN_IDENTITY is not set (scripts/mc-import-mac-signing-cert.sh); use --ad-hoc --dry-run for a local test build");
}

// ---- preflight --------------------------------------------------------------

step("Preflight");
run("gh", ["auth", "status"], { capture: true });
const dirty = run("git", ["status", "--porcelain", "--untracked-files=no"], { capture: true });
if (dirty && !dryRun) fail(`commit or discard tracked changes first:\n${dirty}`);
const branch = run("git", ["rev-parse", "--abbrev-ref", "HEAD"], { capture: true });
if (branch !== "main" && !dryRun) fail(`release from main (on ${branch})`);
run("git", ["fetch", "--quiet", "origin", "main", "--tags"]);
const head = run("git", ["rev-parse", "HEAD"], { capture: true });
const remoteHead = run("git", ["rev-parse", "origin/main"], { capture: true });
if (head !== remoteHead && !dryRun) fail("push main first: the release must point at a published commit");
if (run("git", ["tag", "--list", tag], { capture: true }) && !dryRun) fail(`tag ${tag} already exists`);

const latestTag = run(
  "gh",
  ["release", "view", "--repo", REPO, "--json", "tagName", "--jq", ".tagName"],
  { capture: true, allowFailure: true },
);
const latest = parseSemver(latestTag.replace(/^v/, ""));
if (latest && !newer(parsed, latest)) fail(`${version} is not newer than the latest release ${latestTag}`);
console.log(`  version ${version} (latest published: ${latestTag || "none"}), ${arch}, ${dryRun ? "dry run" : "publish"}`);

// ---- build ------------------------------------------------------------------

const zip = `${PRODUCT}-${version}-${arch}-mac.zip`;
const dmg = `${PRODUCT}-${version}-${arch}.dmg`;
const assets = [zip, `${zip}.blockmap`, dmg, `${dmg}.blockmap`, "latest-mac.yml"];

if (!skipBuild) {
  step("Build dependencies, host and runtime");
  run("pnpm", ["run", "build:deps"], { cwd: DESKTOP });
  run("pnpm", ["run", "build:host-release"], { cwd: DESKTOP });
  run("pnpm", ["run", "bundle:runtime"], { cwd: DESKTOP });
  run("pnpm", ["exec", "electron-vite", "build"], { cwd: DESKTOP });

  step(`Package ${PRODUCT} ${version} (${arch}, ${adHoc ? "ad-hoc signed" : "fixed certificate"})`);
  run(
    "pnpm",
    [
      "exec",
      "electron-builder",
      "--mac",
      `--${arch}`,
      "--publish",
      "never",
      // Ad-hoc first; the hook then re-signs before the zip and dmg are made.
      "-c.mac.identity=-",
      ...(adHoc ? [] : ["-c.afterSign=../../scripts/mc-sign-mac-bundle.cjs"]),
      `-c.extraMetadata.version=${version}`,
      "-c.extraMetadata.mcUpdateDelivery=notify",
    ],
    { cwd: DESKTOP },
  );
}

// ---- verify -----------------------------------------------------------------

step("Verify artifacts");
for (const asset of assets) {
  if (!existsSync(join(RELEASE_DIR, asset))) fail(`missing ${asset} in apps/desktop/release`);
}
const feed = readFileSync(join(RELEASE_DIR, "latest-mac.yml"), "utf8");
if (!feed.includes(`version: ${version}\n`)) fail("latest-mac.yml describes another version; rebuild without --skip-build");
if (!feed.includes(`path: ${zip}`)) fail(`latest-mac.yml does not point at ${zip}`);
const appDir = join(RELEASE_DIR, arch === "arm64" ? "mac-arm64" : "mac", `${PRODUCT}.app`);
run("codesign", ["--verify", "--deep", "--strict", appDir]);
if (!adHoc) {
  // codesign prints the requirement on stdout or stderr depending on the version.
  const requirement = spawnSync("codesign", ["-d", "--requirements", "-", appDir], { encoding: "utf8" });
  const designated = `${requirement.stdout}${requirement.stderr}`;
  const expected = `identifier "${BUNDLE_ID}" and certificate leaf = H"${SIGNING_CERT_SHA1}"`;
  if (!designated.includes(expected)) fail(`the app is not signed with the fixed certificate:\n${designated}`);
}
// The Computer Use helper: present, built for this architecture, signed
// inside the bundle, and runnable (docs/mc-agent/macos-permissions.md P2).
const helper = join(appDir, "Contents/Resources/plugins/mc.computer-use/bin/mc-computer");
if (!existsSync(helper)) fail("the Computer Use helper is missing from the app");
const helperArch = run("lipo", ["-archs", helper], { capture: true }).trim();
if (!helperArch.split(/\s+/).includes(arch === "arm64" ? "arm64" : "x86_64")) {
  fail(`the Computer Use helper is built for ${helperArch}, not ${arch}`);
}
run("codesign", ["--verify", "--strict", helper]);
const helperVersion = run(helper, ["--version"], { capture: true }).trim();
if (!helperVersion.startsWith("mc-computer ")) fail(`the Computer Use helper did not run: ${helperVersion}`);
// The version and delivery mode the app itself will report to the updater.
const asar = createRequire(join(DESKTOP, "package.json"))("@electron/asar");
const packaged = JSON.parse(
  asar.extractFile(join(appDir, "Contents/Resources/app.asar"), "package.json").toString("utf8"),
);
if (packaged.version !== version) fail(`the app reports version ${packaged.version}`);
if (packaged.mcUpdateDelivery !== "notify") fail("the app is not marked notify-only");
console.log(
  `  ${assets.length} files present, feed and app at ${version}, notify-only, signature valid${adHoc ? " (ad-hoc)" : " (fixed certificate)"}, helper ${helperArch} ok`,
);

if (dryRun) {
  console.log(`\n✔ Dry run done. Publish with: node scripts/mc-release.mjs ${version}`);
  process.exit(0);
}

// ---- publish ----------------------------------------------------------------

step("Release notes");
const previousTag = run("git", ["describe", "--tags", "--abbrev=0", "--match", "v*"], {
  capture: true,
  allowFailure: true,
});
const range = previousTag ? `${previousTag}..HEAD` : "-20";
const log = run("git", ["log", range, "--no-merges", "--pretty=- %s"], { capture: true });
const notesFile = join(mkdtempSync(join(tmpdir(), "mc-release-")), "notes.md");
writeFileSync(
  notesFile,
  `${previousTag ? `Changes since ${previousTag}:` : "Changes:"}\n\n${log || "- Maintenance release"}\n\n` +
    "macOS builds are not notarized: on first launch, right-click the app and choose Open.\n",
);
console.log(readFileSync(notesFile, "utf8"));

step(`Tag ${tag}`);
run("git", ["tag", "-a", tag, "-m", `${PRODUCT} ${version}`]);
run("git", ["push", "origin", tag]);

step("Upload draft release");
run("gh", [
  "release",
  "create",
  tag,
  "--repo",
  REPO,
  "--draft",
  "--verify-tag",
  "--title",
  `${PRODUCT} ${version}`,
  "--notes-file",
  notesFile,
  ...assets.map((asset) => join(RELEASE_DIR, asset)),
]);

step("Publish");
run("gh", ["release", "edit", tag, "--repo", REPO, "--draft=false", "--latest"]);
console.log(`\n✔ Published https://github.com/${REPO}/releases/tag/${tag}`);
