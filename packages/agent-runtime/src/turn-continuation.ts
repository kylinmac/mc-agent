import { assistantContent, isRecord } from "./agent-messages.js";


/**
 * Appended for one automatic re-run after a turn that produced nothing the
 * user can see. Two shapes were observed: a wholly empty response, and a
 * finished conclusion written into reasoning while the visible text stayed
 * empty. The same nudge covers both, because both need the same next move.
 */
export const SILENT_TURN_NUDGE = [
  "<no_output_recovery>",
  "Your previous turn ended with no visible text and no tool call, so the user saw nothing happen.",
  "Your reasoning is never shown to the user. If you already reached the answer, state it now in plain text.",
  "Otherwise continue the unfinished work, starting with one sentence about what you are doing.",
  "</no_output_recovery>",
].join("\n");

/**
 * Autonomous plan/goal execution: collaboration prompts ask the model to
 * narrate progress ("Writing it now.") then call a tool. Models often emit
 * that narration as a finished assistant message with `finish_reason: stop`
 * and no toolCall, so the runtime treats it as the final answer and ends the
 * run mid-task (#43). One automatic continue with this nudge, then stop.
 */
export const PROGRESS_TURN_NUDGE = [
  "<progress_only_recovery>",
  "Your last message announced next steps but contained no tool call, so the autonomous run would have stopped mid-task.",
  "Continue the approved plan now: either call the tools for the work you just described, or write the final self-contained completion report.",
  "Do not announce intent without a tool call in the same message.",
  "</progress_only_recovery>",
].join("\n");

/**
 * Some OpenAI-style models emit their internal parallel-call wrapper as
 * assistant text (`to=multi_tool_use.parallel code:{"tool_uses":[…]}`) instead
 * of real tool calls. PI-Desktop has no such tool, so the whole batch lands as
 * prose and silently does nothing — the turn looks finished while no work ran.
 * Rare (2 occurrences across 255 recorded sessions) but indistinguishable from
 * a stuck agent when it happens.
 */
export function looksLikePseudoToolCall(text: string): boolean {
  return (
    text.includes("multi_tool_use.parallel") || text.includes('{"tool_uses":')
  );
}

export function messageRequestsTools(message: unknown): boolean {
  const content = isRecord(message) ? message.content : undefined;
  return (
    Array.isArray(content) &&
    content.some((part) => isRecord(part) && part.type === "toolCall")
  );
}

const PROGRESS_FORWARD_INTENT_PATTERNS = [
  /\b(?:about to|going to|will|next|then|still(?: need| have to)?|remaining|left to|working on|writing|reading|updating|implementing|checking|running|creating|fixing|reviewing|proceed(?:ing)?|continu(?:e|ing)|starting|moving on)\b/i,
  /(?:接下来|下一步|还需要|仍需|剩下|正在|将要|继续|开始)/i,
];
const PROGRESS_TERMINAL_LEAD =
  /^(?:done|all done|complete(?:d)?|finished|implemented|resolved|verified|successful(?:ly)?|the (?:approved )?(?:plan|goal) is complete)\b/i;

function hasProgressForwardIntent(text: string): boolean {
  return PROGRESS_FORWARD_INTENT_PATTERNS.some((pattern) => pattern.test(text));
}

/** Clearly forward-looking visible assistant text without a toolCall. */
export function isProgressOnlyAssistantTurn(message: unknown): boolean {
  if (!isRecord(message) || message.role !== "assistant") return false;
  if (messageRequestsTools(message)) return false;
  const content = isRecord(message) ? message.content : undefined;
  const text = assistantContent(content).text.trim();
  if (!text || !hasProgressForwardIntent(text)) return false;
  if (!PROGRESS_TERMINAL_LEAD.test(text)) return true;

  // A report can mention a completed step and still announce the next one.
  // Only recover a terminal-looking lead when a later clause carries the
  // forward intent that distinguishes it from a normal final report.
  return hasProgressForwardIntent(text.replace(PROGRESS_TERMINAL_LEAD, ""));
}
