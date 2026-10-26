import { create } from "zustand";
import type { ProjectCreateStep, ProjectProposal } from "@pi-desktop/shared";
import { planSteps, type ConfirmedPlan, type StepState } from "./plan";
import { api } from "../../lib/api";

/*
  mc-agent (MC-ADR-0023): the `CreateProject` proposals waiting for the user.
  Electron main owns them; this mirrors its list so a reload or a session
  switch shows the same card again.
*/
export type Creation = { plan: ConfirmedPlan; steps: Array<{ step: ProjectCreateStep; state: StepState }> };

type ProposalState = {
  proposals: ProjectProposal[];
  /**
   * Creation under way, by request: kept here rather than in the card, so a
   * session switch that remounts the card shows the progress instead of
   * offering Create a second time.
   */
  creating: Record<string, Creation>;
};

export const useProjectProposals = create<ProposalState>(() => ({ proposals: [], creating: {} }));

export function beginCreation(requestId: string, plan: ConfirmedPlan): void {
  useProjectProposals.setState((current) => ({
    creating: {
      ...current.creating,
      [requestId]: { plan, steps: planSteps(plan).map((step) => ({ step, state: "pending" as const })) },
    },
  }));
}

export function setCreationProgress(requestId: string, step: ProjectCreateStep, state: StepState): void {
  useProjectProposals.setState((current) => {
    const creation = current.creating[requestId];
    if (!creation) return {};
    const steps = creation.steps.map((item) => (item.step === step ? { step, state } : item));
    return { creating: { ...current.creating, [requestId]: { ...creation, steps } } };
  });
}

export function endCreation(requestId: string): void {
  useProjectProposals.setState((current) => {
    const creating = { ...current.creating };
    delete creating[requestId];
    return { creating };
  });
}

let started = false;

/** Load the pending list once and follow main's changes for the app's lifetime. */
export function startProjectProposalSync(): void {
  if (started) return;
  started = true;
  api.mcProjectCreate.onChanged((proposals) => useProjectProposals.setState({ proposals }));
  void api.mcProjectCreate
    .proposals()
    .then(({ proposals }) => useProjectProposals.setState({ proposals }))
    .catch(() => {
      // Main answers again on the next change; an empty list is the safe view.
    });
}

/** The oldest proposal for `sessionId`; one card at a time per conversation. */
export function useSessionProposal(sessionId: string | null | undefined): ProjectProposal | undefined {
  return useProjectProposals((state) =>
    sessionId ? state.proposals.find((proposal) => proposal.sessionId === sessionId) : undefined,
  );
}
