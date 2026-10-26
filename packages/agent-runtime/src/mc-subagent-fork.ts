import type { AgentMessage } from "@earendil-works/pi-agent-core";

/**
 * mc-agent (MC-ADR-0022): a forked subagent starts from the parent's model
 * context instead of a blank one, so the parent does not have to restate
 * what the conversation already established.
 *
 * The parent's context ends with the assistant message that is calling
 * `Task` right now, possibly followed by results of calls made beside it.
 * Those calls have no results yet, and providers reject a tool call without
 * its result, so that tail is cut. Only user, assistant and tool-result
 * messages are carried; runtime-internal entries stay with the parent.
 */
export function forkableParentMessages(messages: readonly AgentMessage[]): AgentMessage[] {
  const kept = messages.filter((message) => {
    const role = (message as { role?: string }).role;
    return role === "user" || role === "assistant" || role === "toolResult";
  });
  let end = kept.length;
  while (end > 0 && (kept[end - 1] as { role?: string }).role === "toolResult") end -= 1;
  const last = kept[end - 1] as { role?: string; content?: unknown } | undefined;
  const callsTools = last?.role === "assistant" && Array.isArray(last.content)
    && (last.content as Array<{ type?: string }>).some((block) => block.type === "toolCall");
  if (callsTools) end -= 1;
  return kept.slice(0, end);
}

/** The forked delegate's brief: what it is, then the parent's task. */
export function forkBrief(task: string): string {
  return [
    "You are a fork of the conversation above: you have its full context up to this point, but you run separately and the user does not see your messages.",
    "Do only the task below, do not start other work the conversation mentions, and end with a report for the parent: what you did, what you found, and anything left open.",
    "",
    `Task: ${task}`,
  ].join("\n");
}
