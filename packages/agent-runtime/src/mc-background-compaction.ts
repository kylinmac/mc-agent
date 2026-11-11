/**
 * mc-agent (MC-ADR-0028, #121): prepare the compaction summary before the
 * turn has to wait for it.
 *
 * Automatic compaction runs inline at the turn boundary: at 90% of the safe
 * budget the summary request is issued and everything waits. On the installed
 * app that wait had a median of about two and a half minutes. With this option
 * on, the summary is requested at 80% while the turn keeps running, and at 90%
 * the finished checkpoint is installed: the summary covers history up to the
 * boundary it was prepared at, and whatever came after stays verbatim.
 *
 * This module holds the rules that do not need the runtime: when to start, and
 * when a prepared summary may no longer be used. The runtime owns the request
 * and the installation.
 */

/** Share of the safe budget at which a summary is prepared; below automatic compaction (0.9). */
export const BACKGROUND_SUMMARY_TRIGGER_RATIO = 0.8;

export type PrepareSummaryInput = {
  /** The user setting, already combined with the automatic-compaction switch. */
  enabled: boolean;
  tokens: number;
  hardLimit: number;
  /** Tokens at which automatic compaction runs (`automaticCompactionThresholdFor`). */
  automaticThreshold: number;
  /** A summary is already prepared, being prepared, or being generated inline. */
  busy: boolean;
};

/**
 * Start preparing only inside the band between the two lines. At or above the
 * automatic threshold the inline path is about to run and owns the request.
 */
export function shouldPrepareSummary(input: PrepareSummaryInput): boolean {
  if (!input.enabled || input.busy) return false;
  if (input.tokens >= input.automaticThreshold) return false;
  return input.tokens >= Math.floor(input.hardLimit * BACKGROUND_SUMMARY_TRIGGER_RATIO);
}

/** What a prepared summary was built against. */
export type PreparedSummaryBasis = {
  /** Last durable message the summary covers. */
  boundaryId: string;
  /** The checkpoint that was active while it was prepared, if any. */
  activeCheckpointId?: string;
  /** Provider, model and reasoning level that produced it. */
  modelKey: string;
};

export type PreparedSummaryDiscard =
  | "boundary_missing"
  | "checkpoint_changed"
  | "model_changed";

/**
 * Why a prepared summary can no longer be installed, or undefined when it can.
 *
 * Each condition means the summary describes a history, or was written by a
 * model, that is no longer the session's: the boundary message is gone (the
 * history was rewritten), another checkpoint was installed in the meantime, or
 * the model or reasoning level changed.
 */
export function preparedSummaryDiscardReason(
  basis: PreparedSummaryBasis,
  current: { hasMessage: (id: string) => boolean; activeCheckpointId?: string; modelKey: string },
): PreparedSummaryDiscard | undefined {
  if (!current.hasMessage(basis.boundaryId)) return "boundary_missing";
  if (current.activeCheckpointId !== basis.activeCheckpointId) return "checkpoint_changed";
  if (current.modelKey !== basis.modelKey) return "model_changed";
  return undefined;
}

/**
 * Whether the checkpoint keeps its retained user message when installed.
 *
 * A summary prepared mid-turn retains the turn's user message so the model
 * still reads the request verbatim. That is right only while the same turn is
 * running: once a newer user message sits after the boundary it is in the
 * verbatim tail already, and the retained one would replay an old request.
 */
export function keepsRetainedUserMessage(
  installingMidTurn: boolean,
  userMessageAfterBoundary: boolean,
): boolean {
  return installingMidTurn && !userMessageAfterBoundary;
}

/** Key in a checkpoint's `details`: usage reported before this time predates the install. */
export const USAGE_STALE_BEFORE_KEY = "usageStaleBefore";

/**
 * After a prepared summary is installed, the verbatim tail still holds
 * assistant messages whose usage reports describe the context *before* the
 * install. An estimate anchored on one of them reads the context as full. The
 * checkpoint records when it was installed, and anchors at or before that time
 * are ignored until a newer response reports usage.
 */
export function usageAnchorIsStale(
  anchorTimestamp: number | undefined,
  staleBefore: unknown,
): boolean {
  return (
    typeof anchorTimestamp === "number" &&
    typeof staleBefore === "number" &&
    Number.isFinite(staleBefore) &&
    anchorTimestamp <= staleBefore
  );
}
