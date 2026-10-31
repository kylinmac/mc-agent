import { ErrorCodes, IPC } from "@pi-desktop/shared";
import type { IpcRegistrar } from "./types";
import { appendPromptsFor, promptMatchFor } from "../mc-system-prompts.ts";

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
    // An idle runtime may still have the previous model/window. Preparation
    // reconciles its launch configuration; running/external sessions skip it.
    // Failure must reach the caller rather than masquerade as a fresh snapshot.
    const prepared = await prepareRuntime?.(sessionId);
    if (prepared) return prepared;
    return sidecar.call("agent.contextBreakdown", { sessionId });
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
    // Which template and append prompts the launch applied (MC-ADR-0010).
    // `customAppend` then means APPEND_SYSTEM.md only, not the append prompts.
    if (!loaded?.prompt || typeof loaded.prompt !== "object") return loaded;
    const appended = appendPromptsFor(sessionId);
    return {
      prompt: {
        ...(loaded.prompt as object),
        template: promptMatchFor(sessionId),
        ...(appended?.names.length ? { appendPrompts: appended.names, customAppend: appended.fileAppend } : {}),
      },
    };
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
