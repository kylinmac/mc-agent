import { create } from "zustand";
import type { AlchemyProposal } from "@pi-desktop/shared";
import { api } from "../../lib/api";

/*
 * mc-agent (R41): pending `ProposeAlchemyArtifact` proposals waiting for user
 * confirmation. Electron main owns the queue; this store mirrors it so reloads
 * or session switches keep showing the pending card.
 */

type AlchemyProposalState = {
  proposals: AlchemyProposal[];
  saving: Record<string, boolean>;
};

export const useAlchemyProposals = create<AlchemyProposalState>(() => ({
  proposals: [],
  saving: {},
}));

export function setAlchemySaving(requestId: string, saving: boolean): void {
  useAlchemyProposals.setState((current) => {
    const next = { ...current.saving };
    if (saving) next[requestId] = true;
    else delete next[requestId];
    return { saving: next };
  });
}

let started = false;

export function startAlchemyProposalSync(): void {
  if (started) return;
  started = true;
  api.mcAlchemy.onChanged((proposals) => useAlchemyProposals.setState({ proposals }));
  void api.mcAlchemy
    .proposals()
    .then(({ proposals }) => useAlchemyProposals.setState({ proposals }))
    .catch(() => {
      // Main notifies again on the next change; an empty list is the safe view.
    });
}

export function useSessionAlchemyProposal(sessionId: string | null | undefined): AlchemyProposal | undefined {
  return useAlchemyProposals((state) =>
    sessionId ? state.proposals.find((proposal) => proposal.sessionId === sessionId) : undefined,
  );
}
