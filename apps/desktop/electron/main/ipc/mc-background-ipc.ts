import { ErrorCodes, IPC } from "@pi-desktop/shared";
import type { HostProcess } from "../host-process";
import type { IpcRegistrar } from "./types";

/**
 * mc-agent background commands (MC-ADR-0006): the desktop panel lists, views
 * and stops a session's background commands. host-core owns the processes and
 * scopes every call to the session that started them.
 */
export type McBackgroundIpcDependencies = {
  registrar: IpcRegistrar;
  getHost: () => HostProcess | null;
};

const MAX_ID_LENGTH = 256;

function text(value: unknown, label: string): string {
  const result = typeof value === "string" ? value.trim() : "";
  if (!result || result.length > MAX_ID_LENGTH) {
    throw Object.assign(new Error(`${label} required`), { errorCode: ErrorCodes.INVALID_ARGUMENT });
  }
  return result;
}

export function registerMcBackgroundIpc({ registrar, getHost }: McBackgroundIpcDependencies): void {
  const host = () => {
    const current = getHost();
    if (!current) throw new Error("host unavailable");
    return current;
  };
  registrar.handle(IPC.invoke.backgroundShellsList, async (input: { sessionId?: unknown } = {}) =>
    host().call("backgroundShells.list", { sessionId: text(input?.sessionId, "sessionId") }),
  );
  registrar.handle(IPC.invoke.backgroundShellsView, async (input: { sessionId?: unknown; id?: unknown } = {}) =>
    host().call("backgroundShells.view", {
      sessionId: text(input?.sessionId, "sessionId"),
      id: text(input?.id, "id"),
    }),
  );
  registrar.handle(IPC.invoke.backgroundShellsKill, async (input: { sessionId?: unknown; id?: unknown } = {}) =>
    host().call("backgroundShells.kill", {
      sessionId: text(input?.sessionId, "sessionId"),
      id: text(input?.id, "id"),
    }),
  );
}
