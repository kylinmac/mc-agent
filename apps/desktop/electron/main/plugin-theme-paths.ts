import { existsSync, realpathSync, statSync } from "node:fs";
import { resolve, sep } from "node:path";
import {
  isExternalThemeAssetPath,
  normalizeThemeAssetPath,
  THEME_ASSET_MAX_BYTES,
  MAX_WINDOW_CORNER_RADIUS,
  WINDOW_BACKGROUND_COLOR_PATTERN,
} from "@pi-desktop/plugin-sdk";
import { resolveAbsoluteThemeAssetPath, resolvePackageThemeAssetPath } from "./plugin-theme-assets.js";


/**
 * `realpath` with the input as its own fallback, for a path that may not exist
 * yet. Containment is decided by the host-runtime workspace-files checks; this only exists so the
 * relative path we compare scopes against is expressed in the same terms.
 */
export function realpathOrSelf(path: string): string {
  try {
    return realpathSync(resolve(path));
  } catch {
    return resolve(path);
  }
}

/**
 * Resolve a plugin-relative path, or null when it would leave the plugin
 * directory. Manifest validation already rejects `..`, so this is defense in
 * depth against symlinked or oddly-cased contributions.
 */
export function resolveInsidePlugin(pluginPath: string, relative: string): string | null {
  const root = resolve(pluginPath);
  const target = resolve(root, relative);
  const prefix = root.endsWith(sep) ? root : root + sep;
  return target !== root && target.startsWith(prefix) ? target : null;
}

/**
 * Resolve one theme's declared assets to files inside the plugin package.
 *
 * Package-relative assets are canonicalized after the plugin's `onLoad` hook
 * and rechecked by `resolveThemeAsset` before every host-scheme read. Absolute
 * assets retain their existing behavior.
 */
export function resolveThemeAssets(
  pluginPath: string,
  declared: readonly string[],
): { files: Map<string, string>; dropped: number } {
  const files = new Map<string, string>();
  if (!declared.length) return { files, dropped: 0 };
  let total = 0;
  let dropped = 0;
  for (const asset of declared) {
    const normalized = normalizeThemeAssetPath(asset);
    if (!normalized || normalized.split("/").some((segment) => segment.toLowerCase() === "node_modules")) {
      dropped += 1;
      continue;
    }
    const absolute = isExternalThemeAssetPath(normalized)
      ? resolveAbsoluteThemeAssetPath(normalized)
      : resolvePackageThemeAssetPath(pluginPath, normalized);
    if (!absolute || !existsSync(absolute)) {
      dropped += 1;
      continue;
    }
    try {
      total += statSync(absolute).size;
    } catch {
      dropped += 1;
      continue;
    }
    files.set(normalized, absolute);
  }
  if (total > THEME_ASSET_MAX_BYTES) return { files: new Map(), dropped: declared.length };
  return { files, dropped };
}

/**
 * Read `contributes.windowAppearance`.
 *
 * Only the two palette slots the host honours survive; the shape is the
 * manifest validator's job, and anything that slips past it is dropped here
 * rather than handed to `setBackgroundColor`.
 */
export function resolveWindowBackground(
  value: unknown,
): { light?: string; dark?: string } | undefined {
  if (!value || typeof value !== "object") return undefined;
  const backgroundColor = (value as { backgroundColor?: unknown }).backgroundColor;
  if (!backgroundColor || typeof backgroundColor !== "object") return undefined;
  const result: { light?: string; dark?: string } = {};
  for (const key of ["light", "dark"] as const) {
    const color = (backgroundColor as Record<string, unknown>)[key];
    if (typeof color === "string" && WINDOW_BACKGROUND_COLOR_PATTERN.test(color)) {
      result[key] = color;
    }
  }
  return result.light || result.dark ? result : undefined;
}

export function resolveWindowCornerRadius(value: unknown): number | undefined {
  if (!value || typeof value !== "object") return undefined;
  const radius = (value as { cornerRadius?: unknown }).cornerRadius;
  return typeof radius === "number" && Number.isInteger(radius) &&
    radius >= 0 && radius <= MAX_WINDOW_CORNER_RADIUS
    ? radius
    : undefined;
}
