import { statSync } from "node:fs";
import { resolve } from "node:path";
import { ErrorCodes, IPC } from "@pi-desktop/shared";
import type { HostProcess } from "../host-process";
import type { TerminalManager } from "../mc-terminal";
import type { IpcRegistrar } from "./types";

/**
 * mc-agent work-panel terminal IPC (MC-ADR-0005). The renderer names a tab
 * and a folder; Main only starts a shell in a folder host-core has on record
 * as a project folder, so the channel cannot open a shell anywhere else.
 */
export type McTerminalIpcDependencies = {
  registrar: IpcRegistrar;
  getHost: () => HostProcess | null;
  /** Registers a callback for app quit, so no shell outlives the app. */
  onQuit: (dispose: () => void) => void;
  /** Built by the caller, whose events push output to the renderer. */
  manager: TerminalManager;
};

const MAX_ID_LENGTH = 256;
const MAX_PATH_LENGTH = 4096;
const MAX_WRITE_LENGTH = 64 * 1024;

function invalid(message: string): Error {
  return Object.assign(new Error(message), { errorCode: ErrorCodes.INVALID_ARGUMENT });
}

function text(value: unknown, label: string, max: number): string {
  const result = typeof value === "string" ? value : "";
  if (!result || result.length > max) throw invalid(`${label} required`);
  return result;
}

/** Folders host-core knows: project records and project-group roots. */
async function knownProjectFolders(host: HostProcess): Promise<Set<string>> {
  const [projects, groups] = await Promise.all([
    host.call("projects.list", {}) as Promise<{ projects?: Array<{ path?: string }> }>,
    host.call("project.groups.list", {}) as Promise<{ groups?: Array<{ roots?: Array<{ path?: string }>; remote?: unknown }> }>,
  ]);
  const folders = new Set<string>();
  for (const project of projects.projects ?? []) if (project.path) folders.add(resolve(project.path));
  for (const group of groups.groups ?? []) {
    if (group.remote) continue;
    for (const root of group.roots ?? []) if (root.path) folders.add(resolve(root.path));
  }
  return folders;
}

export function registerMcTerminalIpc({
  registrar,
  getHost,
  onQuit,
  manager,
}: McTerminalIpcDependencies): TerminalManager {
  onQuit(() => manager.disposeAll());

  registrar.handle(
    IPC.invoke.terminalCreate,
    async (input: { tabId?: unknown; cwd?: unknown; cols?: unknown; rows?: unknown } = {}) => {
      const tabId = text(input?.tabId, "tab id", MAX_ID_LENGTH);
      const cwd = resolve(text(input?.cwd, "folder", MAX_PATH_LENGTH));
      return manager.create({
        tabId,
        cwd,
        cols: typeof input?.cols === "number" ? input.cols : undefined,
        rows: typeof input?.rows === "number" ? input.rows : undefined,
        // Validated inside the manager's start, so closing the tab while the
        // host answers still cancels it.
        check: async () => {
          const host = getHost();
          if (!host) throw new Error("host unavailable");
          if (!(await knownProjectFolders(host)).has(cwd)) {
            throw Object.assign(new Error("terminal folder is not a project folder"), {
              errorCode: ErrorCodes.NOT_FOUND,
            });
          }
          if (!statSync(cwd, { throwIfNoEntry: false })?.isDirectory()) {
            throw invalid("terminal folder does not exist");
          }
        },
      });
    },
  );

  registrar.handle(IPC.invoke.terminalWrite, async (input: { termId?: unknown; data?: unknown } = {}) => {
    manager.write(text(input?.termId, "terminal id", MAX_ID_LENGTH), text(input?.data, "data", MAX_WRITE_LENGTH));
    return { ok: true };
  });

  registrar.handle(
    IPC.invoke.terminalResize,
    async (input: { termId?: unknown; cols?: unknown; rows?: unknown } = {}) => {
      manager.resize(
        text(input?.termId, "terminal id", MAX_ID_LENGTH),
        Number(input?.cols),
        Number(input?.rows),
      );
      return { ok: true };
    },
  );

  registrar.handle(IPC.invoke.terminalDispose, async (input: { tabId?: unknown } = {}) => {
    manager.disposeTab(text(input?.tabId, "tab id", MAX_ID_LENGTH));
    return { ok: true };
  });

  return manager;
}
