/**
 * mc-agent (#118): notice a model that keeps making the same tool call and
 * getting the same answer.
 *
 * The run had no guard for this: a model that re-issued one call with the same
 * arguments went on until compaction or a manual stop. Only an exact repeat
 * counts — same tool, same arguments, same result — and it has to be
 * consecutive: any other call, or the same call returning something new (a
 * log that grew, a check that changed state), is progress and resets the count.
 */

/** Consecutive identical call-and-result pairs before the result carries a reminder. */
export const REPEATED_TOOL_CALL_WARN_AT = 3;
/** Consecutive identical call-and-result pairs that end the run. */
export const REPEATED_TOOL_CALL_STOP_AT = 5;

/**
 * Tools that are meant to be called again unchanged while waiting on
 * something else. An unchanged answer from these means "not yet".
 */
export const REPEATED_TOOL_CALL_EXEMPT: ReadonlySet<string> = new Set([
  "TaskWait",
  "TaskList",
  "BashOutput",
]);

export const REPEATED_TOOL_CALL_ERROR_CODE = "REPEATED_TOOL_CALL_LIMIT";

export type RepeatedToolCallVerdict =
  | { action: "none"; count: number }
  | { action: "warn"; count: number; notice: string }
  | { action: "stop"; count: number; notice: string };

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stable(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/** Identity of one call: tool name plus arguments, independent of key order. */
export function toolCallFingerprint(toolName: string, args: unknown): string {
  return `${toolName}\u0000${stable(args)}`;
}

export function repeatedToolCallNotice(
  toolName: string,
  count: number,
  stopping: boolean,
): string {
  return [
    "<repeated_tool_call>",
    `This is the ${count}${count === 3 ? "rd" : "th"} consecutive ${toolName} call with identical arguments and an identical result. Calling it again will not change the outcome.`,
    stopping
      ? "The run is stopping here so it does not loop. The user can ask you to continue."
      : "Change the approach: use different arguments or a different tool, or tell the user what is blocking you.",
    "</repeated_tool_call>",
  ].join("\n");
}

/** Consecutive-repeat counter for one agent (the session agent or one delegate). */
export class RepeatedToolCallTracker {
  private fingerprint?: string;
  private result?: string;
  private count = 0;

  /** Record a finished call and say whether it repeats the one before it. */
  note(toolName: string, args: unknown, resultText: string): RepeatedToolCallVerdict {
    if (REPEATED_TOOL_CALL_EXEMPT.has(toolName)) {
      this.reset();
      return { action: "none", count: 0 };
    }
    const fingerprint = toolCallFingerprint(toolName, args);
    if (fingerprint === this.fingerprint && resultText === this.result) {
      this.count += 1;
    } else {
      this.fingerprint = fingerprint;
      this.result = resultText;
      this.count = 1;
    }
    if (this.count >= REPEATED_TOOL_CALL_STOP_AT) {
      return { action: "stop", count: this.count, notice: repeatedToolCallNotice(toolName, this.count, true) };
    }
    if (this.count >= REPEATED_TOOL_CALL_WARN_AT) {
      return { action: "warn", count: this.count, notice: repeatedToolCallNotice(toolName, this.count, false) };
    }
    return { action: "none", count: this.count };
  }

  reset(): void {
    this.fingerprint = undefined;
    this.result = undefined;
    this.count = 0;
  }
}
