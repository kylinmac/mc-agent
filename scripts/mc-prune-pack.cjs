/**
 * mc-agent: prune foreign-architecture native binaries from unpacked dependencies
 * during `electron-builder`'s `afterPack` phase (before macOS `afterSign` sealing).
 */
const { existsSync, readdirSync, rmSync } = require("node:fs");
const { join } = require("node:path");

const ARCH_BY_ENUM = {
  0: "ia32",
  1: "x64",
  2: "armv7l",
  3: "arm64",
  4: "universal",
};

const PVRECORDER_TARGETS = {
  darwin: {
    arm64: ["mac/arm64"],
    x64: ["mac/x86_64"],
    universal: ["mac/arm64", "mac/x86_64"],
  },
  win32: {
    x64: ["windows/amd64"],
    arm64: ["windows/arm64"],
  },
  linux: {
    x64: ["linux/x86_64"],
    arm64: ["raspberry-pi"],
    armv7l: ["raspberry-pi"],
  },
};

const NODE_PTY_TARGETS = {
  darwin: {
    arm64: ["darwin-arm64"],
    x64: ["darwin-x64"],
    universal: ["darwin-arm64", "darwin-x64"],
  },
  win32: {
    x64: ["win32-x64"],
    arm64: ["win32-arm64"],
  },
  linux: {
    x64: ["linux-x64"],
    arm64: ["linux-arm64"],
  },
};

function normalizeArch(arch) {
  if (typeof arch === "number" && arch in ARCH_BY_ENUM) return ARCH_BY_ENUM[arch];
  if (typeof arch === "string") return arch.trim().toLowerCase();
  return "";
}

function pruneToAllowed(baseDir, allowedPaths) {
  if (!allowedPaths || allowedPaths.length === 0 || !existsSync(baseDir)) return 0;
  // Never prune unless at least one expected target file/directory exists on disk.
  if (!allowedPaths.some((rel) => existsSync(join(baseDir, rel)))) return 0;

  const allowedSet = new Set(allowedPaths);
  let removed = 0;

  const walk = (dir, relPrefix) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const rel = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;
      if (allowedSet.has(rel)) continue;
      const isAncestor = allowedPaths.some((allowed) => allowed.startsWith(`${rel}/`));
      const fullPath = join(dir, entry.name);
      if (isAncestor && entry.isDirectory()) {
        walk(fullPath, rel);
        continue;
      }
      rmSync(fullPath, { recursive: true, force: true });
      removed += 1;
    }
  };

  walk(baseDir, "");
  return removed;
}

/** Prune non-target binaries inside `app.asar.unpacked/node_modules`. */
function pruneUnpackedNativeModules({ unpackedNodeModules, platform, arch }) {
  const archName = normalizeArch(arch);
  const pvAllowed = PVRECORDER_TARGETS[platform]?.[archName];
  const ptyAllowed = NODE_PTY_TARGETS[platform]?.[archName];

  const pvRemoved = pruneToAllowed(
    join(unpackedNodeModules, "@picovoice", "pvrecorder-node", "lib"),
    pvAllowed,
  );
  const ptyRemoved = pruneToAllowed(
    join(unpackedNodeModules, "node-pty", "prebuilds"),
    ptyAllowed,
  );
  return { arch: archName, pvRemoved, ptyRemoved };
}

function resolveUnpackedNodeModules(context) {
  if (context.electronPlatformName === "darwin") {
    return join(
      context.appOutDir,
      `${context.packager.appInfo.productFilename}.app`,
      "Contents/Resources/app.asar.unpacked/node_modules",
    );
  }
  return join(context.appOutDir, "resources/app.asar.unpacked/node_modules");
}

exports.normalizeArch = normalizeArch;
exports.pruneUnpackedNativeModules = pruneUnpackedNativeModules;

/** electron-builder afterPack hook. */
exports.default = async function afterPack(context) {
  const unpackedNodeModules = resolveUnpackedNodeModules(context);
  const result = pruneUnpackedNativeModules({
    unpackedNodeModules,
    platform: context.electronPlatformName,
    arch: context.arch,
  });
  if (result.pvRemoved > 0 || result.ptyRemoved > 0) {
    console.log(
      `  pruned non-target binaries for ${context.electronPlatformName}/${result.arch} ` +
        `(pvrecorder: ${result.pvRemoved}, node-pty: ${result.ptyRemoved})`,
    );
  }
};
