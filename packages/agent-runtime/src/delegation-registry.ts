import type { DelegationRecord } from "./delegation-status.js";

const MAX_RETAINED_DELEGATIONS = 100;

export class DelegationRegistry {
  private readonly records = new Map<string, DelegationRecord>();

  register(record: DelegationRecord): void {
    this.records.set(record.delegationId, record);
  }

  get(id: string): DelegationRecord | undefined {
    return this.records.get(id);
  }

  all(): DelegationRecord[] {
    return [...this.records.values()];
  }

  /** Cap retained history so a long session cannot grow the registry forever.
   * Finished records are dropped oldest-first; running ones never are. */
  prune(): void {
    const finished = this.all()
      .filter((record) => record.status !== "running")
      .sort((left, right) => (left.completedAt ?? 0) - (right.completedAt ?? 0));
    const excess = finished.length - MAX_RETAINED_DELEGATIONS;
    for (const record of finished.slice(0, Math.max(0, excess))) {
      this.records.delete(record.delegationId);
    }
  }

  running(): DelegationRecord[] {
    return this.all().filter(
      (record) => record.status === "running",
    );
  }

  /** Abort every running delegation (user Stop, dispose, parent fatal error). */
  abortRunning(parentErrorInterrupted = false): void {
    for (const record of this.running()) {
      record.parentErrorInterrupted = parentErrorInterrupted;
      record.abort();
    }
  }

  runningForTurn(epoch: number): DelegationRecord[] {
    return this.running().filter(
      (record) => record.startedEpoch === epoch,
    );
  }

  /**
   * Current-turn delegates whose report the parent has not seen yet: still
   * running, or settled before the parent idled and never read through
   * `TaskWait`. A delegate that finished in a few hundred milliseconds is
   * "done and unpublished", not "unfinished"; keying the idle resume on
   * running delegates alone dropped such reports (#226). Stopped and
   * aborted runs are not auto-delivered.
   */
  unreportedForTurn(epoch: number): DelegationRecord[] {
    return this.all().filter(
      (record) =>
        record.startedEpoch === epoch &&
        !record.reportDelivered &&
        record.status !== "stopped" &&
        record.status !== "aborted",
    );
  }

  abortPreviousTurns(epoch: number): void {
    for (const record of this.running()) {
      if (record.startedEpoch !== epoch) record.abort();
    }
  }
}
