/**
 * Which folder a new session of a project starts in (mc-agent R1.5).
 *
 * The last choice per project is a per-device convenience kept in
 * localStorage. A remembered folder that is no longer part of the project is
 * ignored, and the default is the project's primary path, which is the
 * resource folder once the project has one (MC-ADR-0003).
 */

export type StartFolderRoot = { path: string; kind?: "workspace" | "resources" | "reference" };

const KEY_PREFIX = "mc-agent.startFolder.";

function comparable(path: string): string {
  return path.replaceAll("\\", "/").replace(/\/+$/, "");
}

export function chooseStartFolder(
  roots: readonly StartFolderRoot[],
  primaryPath: string,
  remembered: string | null | undefined,
): string {
  if (remembered) {
    const match = roots.find((root) => comparable(root.path) === comparable(remembered));
    if (match) return match.path;
  }
  return primaryPath;
}

export type KeyValueStore = Pick<Storage, "getItem" | "setItem">;

function defaultStore(): KeyValueStore | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

export function rememberedStartFolder(groupId: string, store = defaultStore()): string | null {
  try {
    return store?.getItem(KEY_PREFIX + groupId) ?? null;
  } catch {
    return null;
  }
}

export function rememberStartFolder(groupId: string, path: string, store = defaultStore()): void {
  try {
    store?.setItem(KEY_PREFIX + groupId, path);
  } catch {
    // Storage can be unavailable or full; the choice is only a convenience.
  }
}
