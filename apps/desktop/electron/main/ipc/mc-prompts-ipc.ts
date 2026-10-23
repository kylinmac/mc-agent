import { ErrorCodes, IPC } from "@pi-desktop/shared";
import type { HostProcess } from "../host-process";
import type { IpcRegistrar } from "./types";

function invalid(message: string): Error {
  return Object.assign(new Error(message), { errorCode: ErrorCodes.INVALID_ARGUMENT });
}

/** mc-agent (MC-ADR-0010): system prompt templates and rules, stored by host-core. */
export function registerMcPromptsIpc({
  registrar,
  getHost,
}: {
  registrar: IpcRegistrar;
  getHost: () => HostProcess | null;
}): void {
  // mc-agent (MC-ADR-0010): system prompt templates, stored by host-core.
  registrar.handle(IPC.invoke.mcPromptsGet, async () => {
    const host = getHost();
    if (!host) throw new Error("host unavailable");
    return host.call("mcPrompts.get", {});
  });
  registrar.handle(IPC.invoke.mcPromptsSet, async (input: { config?: unknown } = {}) => {
    const host = getHost();
    if (!host) throw new Error("host unavailable");
    if (!input?.config || typeof input.config !== "object") throw invalid("config required");
    return host.call("mcPrompts.set", { config: input.config });
  });
  // The template chosen for one conversation; the id is checked by host-core.
  registrar.handle(IPC.invoke.mcPromptsSessionGet, async (input: { sessionId?: unknown } = {}) => {
    const host = getHost();
    if (!host) throw new Error("host unavailable");
    if (typeof input?.sessionId !== "string" || !input.sessionId) throw invalid("sessionId required");
    return host.call("mcPrompts.sessionGet", { sessionId: input.sessionId });
  });
  registrar.handle(
    IPC.invoke.mcPromptsSessionSet,
    async (input: { sessionId?: unknown; templateId?: unknown } = {}) => {
      const host = getHost();
      if (!host) throw new Error("host unavailable");
      if (typeof input?.sessionId !== "string" || !input.sessionId) throw invalid("sessionId required");
      if (input.templateId != null && typeof input.templateId !== "string") throw invalid("templateId must be a string");
      return host.call("mcPrompts.sessionSet", {
        sessionId: input.sessionId,
        templateId: input.templateId ?? null,
      });
    },
  );
}
