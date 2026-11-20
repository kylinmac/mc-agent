import { useEffect } from "react";
import { AlchemyProposalCard } from "./AlchemyProposalCard";
import { startAlchemyProposalSync, useSessionAlchemyProposal } from "./alchemy-store";

/** mc-agent (R41): waiting `ProposeAlchemyArtifact` card of this conversation. */
export function AlchemyProposalSlot({ sessionId }: { sessionId: string | null | undefined }) {
  useEffect(startAlchemyProposalSync, []);
  const proposal = useSessionAlchemyProposal(sessionId);
  return proposal ? <AlchemyProposalCard key={proposal.requestId} proposal={proposal} /> : null;
}
