import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

function stableVersion(value: unknown): string | undefined {
  return typeof value === "string" && /^(?:0|[1-9]\d{0,7})(?:\.(?:0|[1-9]\d{0,7})){2}$/.test(value)
    ? value : undefined;
}

async function readVersionFile(path: string, field: string): Promise<string | undefined> {
  try {
    const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > 8 * 1024 * 1024) return undefined;
      return stableVersion(JSON.parse(await file.readFile("utf8"))?.[field]);
    } finally {
      await file.close();
    }
  } catch {
    // A fresh installation may have no cache, or Codex may be replacing it.
    return undefined;
  }
}

export function createCodexVersionReader(
  fetchPublic: (url: string, init: RequestInit) => Promise<Response>,
  directory = process.env.CODEX_HOME?.trim() || join(homedir(), ".codex"),
) {
  let lastKnown: string | undefined;
  let nextCheck = 0;
  let pending: Promise<string | undefined> | undefined;

  async function publishedVersion() {
    try {
      const response = await fetchPublic("https://registry.npmjs.org/@openai%2fcodex/latest", {
        credentials: "omit", redirect: "error", signal: AbortSignal.timeout(2500),
      });
      return response.ok ? stableVersion((await response.json())?.version) : undefined;
    } catch {
      return undefined;
    }
  }

  async function refresh() {
    const [published, ...local] = await Promise.all([
      publishedVersion(),
      readVersionFile(join(directory, "models_cache.json"), "client_version"),
      readVersionFile(join(directory, "version.json"), "latest_version"),
    ]);
    const candidates = [lastKnown, published, ...local].filter((v): v is string => v !== undefined);
    lastKnown = candidates.sort((a, b) => a.localeCompare(b, "en", { numeric: true })).at(-1);
    nextCheck = Date.now() + (published ? 24 * 60 : 5) * 60_000;
    return lastKnown;
  }

  return () => {
    if (Date.now() < nextCheck) return Promise.resolve(lastKnown);
    return pending ??= refresh().finally(() => { pending = undefined; });
  };
}
