/**
 * mc-agent (#120): the recovery state of one agent run, in one place.
 *
 * A finished loop can arm one of four recoveries for itself — context
 * overflow, a retriable provider failure, a silent turn, or an autonomous
 * progress-only turn. Each suppresses its run's `turn_end` / `agent_end` and
 * leaves a pending marker for the caller to act on once the loop is idle.
 *
 * These used to be sixteen independent fields on the runtime, and every
 * question about them ("does anything suppress the end events?", "is anything
 * pending?", "is one running?", "reset for the next run") was a hand-written
 * list of all four.
 * A list that missed one was a real failure: a flag left set suppresses the
 * *next* run's end events, so the following turn ends invisibly. Here the
 * lists are derived from the phases themselves, so a recovery added later is
 * covered by all of them without anyone remembering to add it.
 */

export type RecoveryPhase<TPending> = {
  /** Armed by the finished loop; consumed by the caller that runs the recovery. */
  pending: TPending;
  /** This run already spent its one automatic attempt. */
  attempted: boolean;
  /** The recovery's own request is in flight. */
  inProgress: boolean;
  /** Hold back this run's `turn_end` / `agent_end`; the recovery closes the run. */
  suppressRunEnd: boolean;
};

const RECOVERY_KINDS = ["overflow", "providerRetry", "silentTurn", "progressTurn"] as const;
export type RecoveryKind = (typeof RECOVERY_KINDS)[number];

function idle<TPending>(pending: TPending): RecoveryPhase<TPending> {
  return { pending, attempted: false, inProgress: false, suppressRunEnd: false };
}

/** `TRetry` is the classified provider error a retry is armed with. */
export class RunRecoveryState<TRetry> {
  readonly overflow: RecoveryPhase<boolean> = idle(false);
  readonly providerRetry: RecoveryPhase<TRetry | undefined> = idle<TRetry | undefined>(undefined);
  readonly silentTurn: RecoveryPhase<boolean> = idle(false);
  readonly progressTurn: RecoveryPhase<boolean> = idle(false);

  private phases(): RecoveryPhase<unknown>[] {
    return RECOVERY_KINDS.map((kind) => this[kind]);
  }

  /** A recovery owns this run's ending: its end events must not reach the UI. */
  suppressesRunEnd(): boolean {
    return this.phases().some((phase) => phase.suppressRunEnd);
  }

  /** A recovery's own request is running: its start events continue the visible run. */
  isRecovering(): boolean {
    return this.phases().some((phase) => phase.inProgress);
  }

  /** A recovery is armed and waiting for the loop to go idle. */
  hasPending(): boolean {
    return this.phases().some((phase) => Boolean(phase.pending));
  }

  /** Return every phase to idle, for the next run. */
  reset(): void {
    for (const kind of RECOVERY_KINDS) {
      const phase = this[kind] as RecoveryPhase<unknown>;
      phase.pending = kind === "providerRetry" ? undefined : false;
      phase.attempted = false;
      phase.inProgress = false;
      phase.suppressRunEnd = false;
    }
  }
}
