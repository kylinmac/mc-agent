import { describe, expect, it } from "vitest";
import { RunRecoveryState, type RecoveryKind } from "./mc-run-recovery.js";

// mc-agent (#120): one state object for the four run recoveries.

const KINDS: RecoveryKind[] = ["overflow", "providerRetry", "silentTurn", "progressTurn"];
type RetryError = { code: string };

describe("RunRecoveryState", () => {
  it("starts idle", () => {
    const state = new RunRecoveryState<RetryError>();
    expect(state.suppressesRunEnd()).toBe(false);
    expect(state.hasPending()).toBe(false);
    expect(state.isRecovering()).toBe(false);
    expect(state.providerRetry.pending).toBeUndefined();
  });

  it.each(KINDS)("%s alone answers every query", (kind) => {
    const state = new RunRecoveryState<RetryError>();
    state[kind].suppressRunEnd = true;
    expect(state.suppressesRunEnd()).toBe(true);
    state[kind].suppressRunEnd = false;
    expect(state.suppressesRunEnd()).toBe(false);

    state[kind].inProgress = true;
    expect(state.isRecovering()).toBe(true);
    state[kind].inProgress = false;

    if (kind === "providerRetry") state.providerRetry.pending = { code: "PROVIDER_RATE_LIMITED" };
    else state[kind].pending = true;
    expect(state.hasPending()).toBe(true);
  });

  // The failure this object exists to prevent: a flag that survives the run
  // suppresses the next run's turn_end / agent_end, so that turn ends unseen.
  it.each(KINDS)("reset leaves nothing of %s behind for the next run", (kind) => {
    const state = new RunRecoveryState<RetryError>();
    if (kind === "providerRetry") state.providerRetry.pending = { code: "PROVIDER_UNAVAILABLE" };
    else state[kind].pending = true;
    state[kind].attempted = true;
    state[kind].inProgress = true;
    state[kind].suppressRunEnd = true;

    state.reset();

    expect(state.suppressesRunEnd()).toBe(false);
    expect(state.hasPending()).toBe(false);
    expect(state.isRecovering()).toBe(false);
    expect(state[kind]).toEqual({
      pending: kind === "providerRetry" ? undefined : false,
      attempted: false, inProgress: false, suppressRunEnd: false,
    });
  });

  it("covers every phase it declares, so a new kind cannot be left out of a query", () => {
    const state = new RunRecoveryState<RetryError>();
    const declared = Object.keys(state).sort();
    expect(declared).toEqual([...KINDS].sort());
  });
});
