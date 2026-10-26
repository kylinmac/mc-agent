import { useEffect } from "react";
import { ProjectProposalCard } from "./ProjectProposalCard";
import { startProjectProposalSync, useSessionProposal } from "./proposal-store";

/** mc-agent (MC-ADR-0023): the waiting `CreateProject` card of this conversation. */
export function ProjectProposalSlot({ sessionId }: { sessionId: string | null | undefined }) {
  useEffect(startProjectProposalSync, []);
  const proposal = useSessionProposal(sessionId);
  return proposal ? <ProjectProposalCard key={proposal.requestId} proposal={proposal} /> : null;
}
