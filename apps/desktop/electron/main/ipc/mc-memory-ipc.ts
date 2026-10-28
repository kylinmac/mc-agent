import { ErrorCodes, IPC } from "@pi-desktop/shared";
import type { HostProcess } from "../host-process";
import {
  consolidateMemory,
  createMemoryReview,
  loadMemorySettings,
  saveMemorySettings,
  setMemoryReview,
  type ReviewSuggestion,
} from "../mc-memory";
import type { IpcRegistrar } from "./types";

type SidecarCall = { call: (method: string, params?: unknown) => Promise<unknown> };

function invalid(message: string): Error {
  return Object.assign(new Error(message), { errorCode: ErrorCodes.INVALID_ARGUMENT });
}

/**
 * mc-agent (MC-ADR-0024): the memory about the user and the review switch
 * (Settings → Memory), the review after an idle conversation, and the memory
 * panel's Tidy up.
 */
export function registerMcMemoryIpc({
  registrar,
  getHost,
  getSidecar,
  dataDir,
  sendToRenderer,
  log,
}: {
  registrar: IpcRegistrar;
  getHost: () => HostProcess | null;
  getSidecar: () => SidecarCall | null;
  dataDir: string;
  sendToRenderer: (channel: string, payload: unknown) => void;
  log: (message: string, error?: unknown) => void;
}): void {
  setMemoryReview(
    createMemoryReview({
      getHost,
      dataDir,
      review: async (sessionId, memory, mode) => {
        const sidecar = getSidecar();
        if (!sidecar) return null;
        const answer = (await sidecar.call("agent.reviewMemory", { sessionId, memory, mode })) as {
          suggestions?: ReviewSuggestion[] | null;
        } | null;
        return answer?.suggestions ?? null;
      },
      notify: (event) => sendToRenderer(IPC.event.mcMemorySuggestions, event),
      log,
    }),
  );

  registrar.handle(IPC.invoke.mcMemoryGet, async () => loadMemorySettings(dataDir));
  registrar.handle(IPC.invoke.mcMemorySet, async (input: { user?: unknown; review?: unknown } = {}) => {
    if (input?.user !== undefined && !Array.isArray(input.user)) throw invalid("user must be a list");
    if (input?.review !== undefined && typeof input.review !== "boolean") throw invalid("review must be a boolean");
    return saveMemorySettings(dataDir, {
      ...(input?.user !== undefined ? { user: input.user as [] } : {}),
      ...(input?.review !== undefined ? { review: input.review as boolean } : {}),
    });
  });
  registrar.handle(IPC.invoke.mcMemoryConsolidate, async (input: { sessionId?: unknown } = {}) => {
    const sessionId = typeof input?.sessionId === "string" ? input.sessionId.trim() : "";
    if (!sessionId || sessionId.length > 200) throw invalid("session id required");
    return { result: await consolidateMemory(sessionId) };
  });
}
