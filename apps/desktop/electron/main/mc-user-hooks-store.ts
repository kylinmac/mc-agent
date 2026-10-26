import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { normalizeMcUserHooks, type McUserHook } from "@pi-desktop/shared";

/*
  mc-agent (MC-ADR-0021): the user's hooks, one JSON file in the app's data
  directory. Every session launch reads it, so a change applies to the next
  prompt of each conversation.
*/

const FILE_NAME = "mc-hooks.json";

export function userHooksPath(dataDir: string): string {
  return join(dataDir, FILE_NAME);
}

export async function loadUserHooks(dataDir: string): Promise<McUserHook[]> {
  try {
    const parsed = JSON.parse(await readFile(userHooksPath(dataDir), "utf8")) as { hooks?: unknown };
    return normalizeMcUserHooks(parsed?.hooks);
  } catch {
    return [];
  }
}

export async function saveUserHooks(dataDir: string, value: unknown): Promise<McUserHook[]> {
  const hooks = normalizeMcUserHooks(value);
  const path = userHooksPath(dataDir);
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify({ version: 1, hooks }, null, 2)}\n`, "utf8");
  await rename(temporary, path);
  return hooks;
}
