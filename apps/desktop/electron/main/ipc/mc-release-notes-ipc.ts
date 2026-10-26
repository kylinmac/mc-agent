import { app } from "electron";
import { IPC } from "@pi-desktop/shared";
import { readReleaseNotesState, writeReleaseNotesSeen } from "../mc-release-notes-state";
import type { IpcRegistrar } from "./types";

/**
 * mc-agent (MC-ADR-0017): the renderer asks once after launch whether there
 * are release notes to show, and reports when they were shown. Development
 * builds never show them: their version is the upstream constant.
 */
export function registerMcReleaseNotesIpc({ registrar, dataDir }: { registrar: IpcRegistrar; dataDir: string }): void {
  registrar.handle(IPC.invoke.mcReleaseNotesState, async () => {
    if (!app.isPackaged) return { version: null, lastSeen: null, existingInstall: false };
    return { version: app.getVersion(), ...(await readReleaseNotesState(dataDir)) };
  });
  registrar.handle(IPC.invoke.mcReleaseNotesSeen, async (version: unknown) => {
    if (!app.isPackaged || typeof version !== "string" || !/^\d+\.\d+\.\d+$/.test(version)) return { ok: false };
    await writeReleaseNotesSeen(dataDir, version);
    return { ok: true };
  });
}
