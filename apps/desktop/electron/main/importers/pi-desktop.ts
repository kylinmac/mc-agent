import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ExternalSessionSummary } from "./types";

/*
  mc-agent (MC-ADR-0009): conversations from an installed PI-Desktop. Its
  storage matches this app's, so host-core copies them itself, losslessly
  (`mcImport.piDesktopScan` / `mcImport.piDesktopRun`); this module only
  names the source and maps the host's candidates. The source is read-only.
*/

export const PI_DESKTOP_SOURCE_DIR = path.join(os.homedir(), ".pi-desktop");

type HostCaller = { call<T>(method: string, params?: unknown): Promise<T> };

type HostCandidate = {
  externalId: string;
  title: string;
  projectPath: string | null;
  model: string | null;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
};

/**
 * PI-Desktop's conversations, or none when it is absent or is this app's own
 * data (Electron main publishes its data directory as PI_DESKTOP_DATA_DIR at
 * boot; host-core refuses its own directory too).
 */
export async function scanPiDesktop(
  host: HostCaller,
  sourceDir: string = PI_DESKTOP_SOURCE_DIR,
  ownDataDir: string | undefined = process.env.PI_DESKTOP_DATA_DIR,
): Promise<ExternalSessionSummary[]> {
  if (!existsSync(path.join(sourceDir, "pi.sqlite"))) return [];
  if (ownDataDir && path.resolve(sourceDir) === path.resolve(ownDataDir)) return [];
  const { sessions } = await host.call<{ sessions: HostCandidate[] }>("mcImport.piDesktopScan", {
    sourceDir,
  });
  return sessions.map((session) => ({
    source: "pi-desktop",
    externalId: session.externalId,
    title: session.title.trim() || session.externalId,
    projectPath: session.projectPath,
    model: session.model,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    messageCount: session.messageCount,
    filePath: path.join(sourceDir, "sessions", `${session.externalId}.jsonl`),
  }));
}

export async function importPiDesktop(
  host: HostCaller,
  externalIds: string[],
  sourceDir: string = PI_DESKTOP_SOURCE_DIR,
): Promise<{ imported: number; skipped: number; failed: number }> {
  if (externalIds.length === 0) return { imported: 0, skipped: 0, failed: 0 };
  return host.call("mcImport.piDesktopRun", { sourceDir, ids: externalIds });
}
