/**
 * mc-agent: re-sign a packaged macOS app with the project's fixed certificate.
 *
 * electron-builder signs ad-hoc first. An ad-hoc designated requirement is the
 * code hash, so macOS treats every release as a new app and drops its privacy
 * grants. A fixed certificate makes the requirement "this bundle id, this
 * certificate", which stays the same from one release to the next.
 *
 * Runs as electron-builder's afterSign hook (before the zip and dmg are made),
 * or directly: node scripts/mc-sign-mac-bundle.cjs <path/to/App.app>
 *
 *   MC_MAC_SIGN_IDENTITY  SHA-1 of the certificate. Unset: the app stays ad-hoc.
 *   MC_MAC_SIGN_KEYCHAIN  Keychain holding it (optional).
 */
const { spawnSync } = require("node:child_process");
const { closeSync, lstatSync, openSync, readdirSync, readSync } = require("node:fs");
const { join, resolve, sep } = require("node:path");

const ENTITLEMENTS = resolve(__dirname, "../apps/desktop/build/entitlements.mac.plist");
const BUNDLE_SUFFIXES = [".app", ".appex", ".xpc"];
// 32/64-bit Mach-O in either byte order, and universal binaries.
const MACHO_MAGIC = new Set([0xfeedface, 0xcefaedfe, 0xfeedfacf, 0xcffaedfe, 0xcafebabe, 0xbebafeca]);

function isMachO(path) {
  const fd = openSync(path, "r");
  try {
    const head = Buffer.alloc(8);
    if (readSync(fd, head, 0, 8, 0) < 8) return false;
    const magic = head.readUInt32BE(0);
    if (!MACHO_MAGIC.has(magic)) return false;
    // A Java class shares the universal magic; its next word is a class
    // version (45 or above), a universal binary's is a small architecture count.
    if (magic === 0xcafebabe) return head.readUInt32BE(4) < 45;
    return true;
  } finally {
    closeSync(fd);
  }
}

/** Everything that carries a signature, in the order it has to be signed. */
function signingOrder(app) {
  const targets = [app];
  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry);
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) continue;
      if (stat.isDirectory()) {
        if (BUNDLE_SUFFIXES.some((suffix) => entry.endsWith(suffix))) targets.push(path);
        // A framework's seal lives on its current version, not its top folder.
        if (entry.endsWith(".framework")) targets.push(join(path, "Versions", "A"));
        walk(path);
      } else if (stat.isFile() && isMachO(path)) {
        targets.push(path);
      }
    }
  };
  walk(app);
  // Inside out: sealing a bundle records the signatures of what it contains.
  return targets.sort((a, b) => b.split(sep).length - a.split(sep).length);
}

function signBundle(app, identity, keychain) {
  const targets = signingOrder(app);
  for (const target of targets) {
    const result = spawnSync(
      "/usr/bin/codesign",
      [
        "--force",
        "--sign",
        identity,
        ...(keychain ? ["--keychain", keychain] : []),
        "--options",
        "runtime",
        "--timestamp=none",
        "--entitlements",
        ENTITLEMENTS,
        target,
      ],
      { encoding: "utf8" },
    );
    if (result.status !== 0) throw new Error(`codesign failed for ${target}: ${result.stderr.trim()}`);
  }
  return targets.length;
}

function signFromEnv(app) {
  const identity = process.env.MC_MAC_SIGN_IDENTITY;
  if (!identity) {
    console.log("  MC_MAC_SIGN_IDENTITY is not set: the app stays ad-hoc signed");
    return;
  }
  const count = signBundle(app, identity, process.env.MC_MAC_SIGN_KEYCHAIN);
  console.log(`  re-signed ${count} items with the fixed certificate`);
}

exports.signingOrder = signingOrder;
exports.signBundle = signBundle;

/** electron-builder afterSign hook. */
exports.default = async function afterSign(context) {
  if (context.electronPlatformName !== "darwin") return;
  signFromEnv(join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`));
};

if (require.main === module) {
  const app = process.argv[2];
  if (!app) {
    console.error("usage: node scripts/mc-sign-mac-bundle.cjs <path/to/App.app>");
    process.exit(2);
  }
  signFromEnv(resolve(app));
}
