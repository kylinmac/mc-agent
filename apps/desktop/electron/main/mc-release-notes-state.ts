import { existsSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

/*
  mc-agent (MC-ADR-0017): which version's release notes this installation
  last showed. Kept in the data directory beside window-state.json, so a
  reinstall keeps it and a fresh data directory starts without it.
*/

const FILE_NAME = "release-notes-seen.json";

export type ReleaseNotesState = {
  /** Last version whose notes were shown or skipped; null before the first record. */
  lastSeen: string | null;
  /**
   * With no record yet: whether this data directory was used before. The
   * first version carrying the popup has no record anywhere, so this tells an
   * upgrade from a fresh install.
   */
  existingInstall: boolean;
};

export async function readReleaseNotesState(dataDir: string): Promise<ReleaseNotesState> {
  try {
    const raw = JSON.parse(await readFile(join(dataDir, FILE_NAME), "utf8")) as { lastSeen?: unknown };
    if (typeof raw?.lastSeen === "string" && raw.lastSeen.trim()) return { lastSeen: raw.lastSeen.trim(), existingInstall: true };
  } catch {
    // No record yet.
  }
  // Files every earlier version wrote once it had run.
  const existingInstall = ["window-state.json", "close-behavior.json"].some((name) => existsSync(join(dataDir, name)));
  return { lastSeen: null, existingInstall };
}

export async function writeReleaseNotesSeen(dataDir: string, version: string): Promise<void> {
  await mkdir(dataDir, { recursive: true });
  const path = join(dataDir, FILE_NAME);
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify({ lastSeen: version })}\n`, "utf8");
  await rename(temporary, path);
}
