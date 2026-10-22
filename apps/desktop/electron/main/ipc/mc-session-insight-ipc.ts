import { ErrorCodes, IPC } from "@pi-desktop/shared";
import type { IpcRegistrar } from "./types";
import { promptMatchFor } from "../mc-system-prompts.ts";

/**
 * mc-agent session information panel: a session's estimated context use by
 * kind and its composed system prompt, both read from the agent sidecar.
 */
export type SessionInsightIpcDependencies = {
  registrar: IpcRegistrar;
  /** The agent sidecar. */
  getSidecar: () => { call: (method: string, params: Record<string, unknown>) => Promise<unknown> } | null;
  /** Load an idle local session's runtime and return its breakdown, or null. */
  prepareRuntime?: (sessionId: string) => Promise<{ breakdown: unknown } | null>;
  /** Whether Settings has input suggestions turned on. */
  suggestionsEnabled?: () => Promise<boolean>;
};

const MAX_SESSION_ID_LENGTH = 256;

function invalid(message: string): Error {
  return Object.assign(new Error(message), { errorCode: ErrorCodes.INVALID_ARGUMENT });
}

export function registerSessionInsightIpc({
  registrar,
  getSidecar,
  prepareRuntime,
  suggestionsEnabled,
}: SessionInsightIpcDependencies): void {
  // mc-agent: estimated context use by kind for one session (sidecar-owned).
  registrar.handle(IPC.invoke.sessionContextBreakdown, async (input: { sessionId?: unknown } = {}) => {
    const sessionId = typeof input?.sessionId === "string" ? input.sessionId.trim() : "";
    if (!sessionId || sessionId.length > MAX_SESSION_ID_LENGTH) throw invalid("session id required");
    const sidecar = getSidecar();
    if (!sidecar) return { breakdown: null };
    const loaded = (await sidecar.call("agent.contextBreakdown", { sessionId })) as { breakdown: unknown };
    if (loaded?.breakdown || !prepareRuntime) return loaded;
    // No runtime yet (nothing sent since the app started): load it, so the
    // breakdown does not wait for the next message.
    try {
      return (await prepareRuntime(sessionId)) ?? loaded;
    } catch {
      return loaded;
    }
  });


  // mc-agent: the composed system prompt of one session, for the viewer.
  registrar.handle(IPC.invoke.sessionSystemPrompt, async (input: { sessionId?: unknown } = {}) => {
    const sessionId = typeof input?.sessionId === "string" ? input.sessionId.trim() : "";
    if (!sessionId || sessionId.length > MAX_SESSION_ID_LENGTH) throw invalid("session id required");
    const sidecar = getSidecar();
    if (!sidecar) return { prompt: null };
    // Re-run the launch first: it picks up template, SYSTEM.md, instruction and
    // memory changes (retiring a runtime they no longer match), so the viewer
    // shows what the next message will send. A running turn skips it.
    if (prepareRuntime) {
      try {
        await prepareRuntime(sessionId);
      } catch {
        // Show what there is.
      }
    }
    const loaded = (await sidecar.call("agent.systemPrompt", { sessionId })) as { prompt: unknown };
    // Which template the launch applied (MC-ADR-0010).
    return loaded?.prompt && typeof loaded.prompt === "object"
      ? { prompt: { ...(loaded.prompt as object), template: promptMatchFor(sessionId) } }
      : loaded;
  });

  // mc-agent: suggest the next message after a finished reply. Only while the
  // setting is on, and only from a runtime that already ran here: nothing is
  // launched for it.
  registrar.handle(IPC.invoke.sessionSuggestPrompt, async (input: { sessionId?: unknown } = {}) => {
    const sessionId = typeof input?.sessionId === "string" ? input.sessionId.trim() : "";
    if (!sessionId || sessionId.length > MAX_SESSION_ID_LENGTH) throw invalid("session id required");
    if (!suggestionsEnabled || !(await suggestionsEnabled())) return { text: null };
    const sidecar = getSidecar();
    if (!sidecar) return { text: null };
    const answer = (await sidecar.call("agent.suggestPrompt", { sessionId })) as { text?: unknown } | null;
    return { text: typeof answer?.text === "string" && answer.text.trim() ? answer.text : null };
  });
}
