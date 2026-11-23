import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { checkpointGeneration, type ContextCompactionRecord } from "@pi-desktop/shared";
import { isRecord } from "./agent-messages.js";
import { COMPACTION_RETAINED_TAIL_SHAPE, replayRetainedTail, selectRecentTail } from "./compaction-tail.js";
import type { ContextBudget } from "./context-budget.js";
import type { CompactionPreparation } from "./pi-runtime-types.js";

export type CompactionRetentionMode = "active_turn" | "completed_turn";

export const COMPACTION_FALLBACK_MAX_SUMMARY_CHARS = 12_000;
/**
 * Room held back from a fallback's tail for the recovery notice the checkpoint
 * appends after the carried-forward summary.
 */
const COMPACTION_FALLBACK_NOTICE_TOKENS = 512;
/**
 * Share of the safe budget a failure's retained window may occupy. The window
 * is bounded by the keep-recent target as well, so it never carries more
 * history than a successful checkpoint would (`fallbackRetainedTail`).
 */
export const COMPACTION_FALLBACK_KEEP_RECENT_RATIO = 0.25;
export const COMPACTION_FALLBACK_MARKER =
  "[automatic context recovery: older context was omitted after summary generation failed]";
/** Stored in place of a carried-forward summary when a fallback had none. */
const COMPACTION_FALLBACK_NO_SUMMARY =
  "No previous context checkpoint is available.";

/**
 * A retained-tail fallback stores any carried-forward summary ahead of the
 * recovery notice, separated by `COMPACTION_FALLBACK_MARKER` (see
 * `createFallbackCheckpoint`). Only the notice is synthetic: the text before
 * the marker is the real summary the failed compaction was carrying forward.
 * Strip the notice — and the "no previous summary" placeholder — so the next
 * summarization rebuilds from that real summary instead of updating a notice
 * that never was a summary (#224), without discarding the history it carried.
 */
export function stripCompactionFallbackNotice(
  summary: string | undefined,
): string | undefined {
  if (!summary) return undefined;
  const markerIndex = summary.indexOf(COMPACTION_FALLBACK_MARKER);
  if (markerIndex === -1) return summary;
  const carried = summary.slice(0, markerIndex).trim();
  if (carried.length === 0 || carried === COMPACTION_FALLBACK_NO_SUMMARY) {
    return undefined;
  }
  return carried;
}

export function checkpointFileDetails(preparation: CompactionPreparation) {
  return {
    readFiles: [...preparation.fileOps.read].sort(),
    modifiedFiles: [
      ...new Set([
        ...preparation.fileOps.written,
        ...preparation.fileOps.edited,
      ]),
    ].sort(),
  };
}

/**
 * Stamp the checkpoint with its generation so the context inspector can show
 * how many times a session has been compacted. A non-object `details` value
 * is nested rather than dropped: it belongs to whoever produced it.
 */
export function checkpointDetailsWithGeneration(details: unknown, previous?: ContextCompactionRecord): unknown {
  const base =
    details && typeof details === "object" && !Array.isArray(details)
      ? (details as Record<string, unknown>)
      : details === undefined
        ? {}
        : { value: details };
  return {
    ...base,
    generation: previous
      ? checkpointGeneration(previous.details) + 1
      : 1,
  };
}

function boundedText(value: string, maxChars: number): string {
  const text = value.trim();
  if (text.length <= maxChars) return text;
  const marker = "\n\n[context recovery summary shortened]\n\n";
  const available = Math.max(2, maxChars - marker.length);
  const headChars = Math.ceil(available / 2);
  const tailChars = Math.floor(available / 2);
  return `${text.slice(0, headChars)}${marker}${text.slice(-tailChars)}`;
}

export function fallbackSummary(previous: string | undefined, maxSummaryChars: number, retentionMode: CompactionRetentionMode): string {
  const previousSummary = previous
    ? boundedText(
        previous,
        Math.min(COMPACTION_FALLBACK_MAX_SUMMARY_CHARS, maxSummaryChars),
      )
    : COMPACTION_FALLBACK_NO_SUMMARY;
  const continuation =
    retentionMode === "active_turn"
      ? "The provider is continuing the active turn: the recent messages carried below are the tail of that turn and the carried summary is the older history. Continue the work they describe."
      : "The previous turn is complete. Treat this summary and the recent messages below as historical context; the next user message is the only new task to execute.";
  return [
    previousSummary,
    COMPACTION_FALLBACK_MARKER,
    "The automatic summary request did not complete. Older messages before this checkpoint are omitted from the next model request.",
    `The complete transcript remains available in the session. ${continuation}`,
  ].join("\n\n");
}

/**
 * The recent window a fallback retains. Bounded by the keep-recent target so a
 * failure never carries more history than a successful checkpoint would, and
 * by what the safe budget leaves once the carried-forward summary and the
 * recovery notice are paid for — `persistCheckpoint` re-estimates the installed
 * context, and an oversized fallback would fail the run outright.
 */
export function fallbackRetainedTail(
  preparation: CompactionPreparation,
  budget: ContextBudget,
  maxSummaryChars: number,
  retentionMode: CompactionRetentionMode,
): AgentMessage[] {
  const summaryTokens = Math.ceil(maxSummaryChars / 4);
  const available = Math.max(
    1,
    budget.hardLimit - summaryTokens - COMPACTION_FALLBACK_NOTICE_TOKENS,
  );
  const target = Math.max(
    1,
    Math.min(
      budget.keepRecentTokens,
      Math.floor(budget.hardLimit * COMPACTION_FALLBACK_KEEP_RECENT_RATIO),
    ),
  );
  return selectRecentTail(
    preparation.messagesToSummarize,
    Math.min(target, available),
    { latestUserGoal: retentionMode === "active_turn" },
  );
}

function compactionRetentionMode(details: unknown): CompactionRetentionMode {
  // Checkpoints written before the task-boundary fix did not record whether
  // their retained users belonged to an in-progress turn. Treat those
  // records as active, but still reduce them to one latest user message so a
  // restart cannot restore a sequence of executable-looking old requests.
  return isRecord(details) && details.retainedTailMode === "completed_turn"
    ? "completed_turn"
    : "active_turn";
}

/**
 * The messages a stored checkpoint replays as real context after its summary.
 *
 * A checkpoint that recorded {@link COMPACTION_RETAINED_TAIL_SHAPE} keeps the
 * whole window it stored: it is a failed compaction's only record of the range
 * behind it, so narrowing the tail back to one user message would reinstate
 * exactly the amnesia the window fixes (#827). Records written before that
 * marker existed — and every successful checkpoint — keep the older
 * normalization: at most the latest user message, and none at all once the turn
 * is complete, so a restart cannot restore a sequence of executable-looking old
 * requests.
 */
export function retainedTailForContext(
  value: unknown,
  details?: unknown,
): AgentMessage[] | undefined {
  if (!Array.isArray(value)) return undefined;
  if (
    isRecord(details) &&
    details.retainedTailShape === COMPACTION_RETAINED_TAIL_SHAPE
  ) {
    return replayRetainedTail(value) ?? [];
  }
  const messages = value
    .filter(isRecord)
    .filter((message) => message.role === "user") as unknown as AgentMessage[];
  if (compactionRetentionMode(details) === "completed_turn") return [];
  const latestUser = messages.at(-1);
  return latestUser ? [latestUser] : [];
}
