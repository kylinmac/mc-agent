import { ErrorCodes, IPC } from "@pi-desktop/shared";
import { alchemyProposalDecisionOf, alchemyProposals } from "../mc-alchemy";
import type { IpcRegistrar } from "./types";

/**
 * mc-agent (R41): IPC bridge for Alchemy artifact proposal cards.
 */
export type McAlchemyIpcDependencies = {
  registrar: IpcRegistrar;
  sendToRenderer: (channel: string, payload: unknown) => void;
};

function invalid(message: string): Error {
  return Object.assign(new Error(message), { errorCode: ErrorCodes.INVALID_ARGUMENT });
}

export function registerMcAlchemyIpc({
  registrar,
  sendToRenderer,
}: McAlchemyIpcDependencies): () => void {
  const unsubscribe = alchemyProposals.subscribe((proposals) =>
    sendToRenderer(IPC.event.mcAlchemyProposalsChanged, { proposals }),
  );

  registrar.handle(IPC.invoke.mcAlchemyProposals, async () => ({
    proposals: alchemyProposals.list(),
  }));

  registrar.handle(
    IPC.invoke.mcAlchemyProposalResolve,
    async (input: { requestId?: unknown; decision?: unknown } = {}) => {
      if (typeof input?.requestId !== "string" || !input.requestId) {
        throw invalid("requestId required");
      }
      return {
        ok: alchemyProposals.resolve(input.requestId, alchemyProposalDecisionOf(input.decision)),
      };
    },
  );

  return unsubscribe;
}
