import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import {
  resolveFsAccess,
  validateManifest,
  type PluginFsPolicy,
  type PluginManifest,
} from "@pi-desktop/plugin-sdk";


/**
 * Permissions and file scope a plugin directory currently declares, with legacy
 * fs names already folded in so a hot reload compares like with like. Throws on
 * a manifest that is missing or unparseable, which is what a reload wants:
 * nothing is granted against a manifest nobody can read.
 */
export function readDeclaredAccess(pluginPath: string): {
  permissions: string[];
  fs: PluginFsPolicy;
} {
  const manifestPath = join(pluginPath, "manifest.json");
  if (!existsSync(manifestPath)) {
    throw new Error("PLUGIN_INVALID: manifest.json missing");
  }
  const raw = JSON.parse(readFileSync(manifestPath, "utf8")) as {
    permissions?: unknown;
    fs?: unknown;
  };
  const declared = Array.isArray(raw.permissions)
    ? raw.permissions.filter((entry): entry is string => typeof entry === "string")
    : [];
  const access = resolveFsAccess({ permissions: declared, fs: raw.fs });
  return { permissions: access.permissions, fs: access.policy };
}

/**
 * Scope a reload adds beyond what was approved. Patterns are compared as
 * written: narrowing a scope is always fine, and a widened one has to go back
 * through review rather than being reasoned about, because deciding whether one
 * glob covers another is not something to guess at behind the gateway.
 */
export function widenedFsScope(ceiling: PluginFsPolicy, next: PluginFsPolicy): string[] {
  const added: string[] = [];
  for (const mode of ["read", "write", "delete"] as const) {
    const before = ceiling[mode];
    const after = next[mode];
    if (!after) continue;
    if (!before) {
      added.push(`fs.${mode}`);
      continue;
    }
    if (after.root !== before.root) added.push(`fs.${mode}.root=${after.root}`);
    if (after.own && !before.own) added.push(`fs.${mode}.own`);
    for (const pattern of after.scope) {
      if (!before.scope.includes(pattern)) added.push(`fs.${mode}.scope=${pattern}`);
    }
  }
  return added;
}

/**
 * Manifest and folded access a development plugin directory declares right now,
 * for the permission review that has to happen before it is loaded. The same
 * read a reload performs, plus the identity the review UI needs to name it
 * before its first load.
 */
export function readDevPluginDeclaration(pluginPath: string): {
  manifest: PluginManifest;
  permissions: string[];
  fs: PluginFsPolicy;
} {
  const manifestPath = join(pluginPath, "manifest.json");
  if (!existsSync(manifestPath)) {
    throw new Error("PLUGIN_INVALID: manifest.json missing");
  }
  const raw = JSON.parse(readFileSync(manifestPath, "utf8")) as unknown;
  const validated = validateManifest(raw);
  if (!validated.ok || !validated.manifest) {
    throw new Error(`PLUGIN_INVALID: ${validated.error}`);
  }
  const access = readDeclaredAccess(pluginPath);
  return { manifest: validated.manifest, permissions: access.permissions, fs: access.fs };
}
