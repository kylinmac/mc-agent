import { type AssistantMessage } from "@earendil-works/pi-ai";


/**
 * mc-agent: the request appended after a finished reply to suggest the user's
 * next message. Everything before it is the conversation exactly as the last
 * request sent it, so the provider's prompt cache covers it.
 */
export const NEXT_PROMPT_SUGGESTION_REQUEST = [
  "[Input suggestion request from the app, not from the user]",
  "Predict the next message the user is most likely to send in this conversation.",
  "Write it as the user would type it, in the language the user writes in, as one short sentence or command.",
  "Reply with only that text: no quotes, no explanation, no tool calls.",
  "If there is no clear next step, reply with nothing.",
].join("\n");
const NEXT_PROMPT_SUGGESTION_MAX_CHARS = 300;
const NEXT_PROMPT_SUGGESTION_TIMEOUT_MS = 60_000;
export const NEXT_PROMPT_SUGGESTION_SETTLE_MS = 5_000;

/** The suggestion text from a model reply, or null when there is none to show. */
export function nextPromptSuggestionText(message: AssistantMessage): string | null {
  if (message.stopReason === "error" || message.stopReason === "aborted") return null;
  if (message.content.some((block) => block.type === "toolCall")) return null;
  const text = message.content
    .flatMap((block) => (block.type === "text" ? [block.text] : []))
    .join("")
    .trim();
  const line = text.split(/\r?\n/).find((part) => part.trim())?.trim() ?? "";
  const unquoted = line.replace(/^["'“”「『](.*)["'“”」』]$/u, "$1").trim();
  if (!unquoted || unquoted.length > NEXT_PROMPT_SUGGESTION_MAX_CHARS) return null;
  return unquoted;
}

export class NextPromptSuggestions {
  private cached?: { reply: object; text: string | null };
  private pending?: { reply: object; controller: AbortController; result: Promise<string | null> };

  cancel(): void {
    this.pending?.controller.abort();
  }

  async forReply(
    reply: object,
    request: (signal: AbortSignal) => Promise<string | null | undefined>,
  ): Promise<string | null> {
    if (this.cached?.reply === reply) return this.cached.text;
    if (this.pending?.reply === reply) return this.pending.result;
    this.cancel();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), NEXT_PROMPT_SUGGESTION_TIMEOUT_MS);
    try {
      const result = request(controller.signal).then((text) => {
        if (controller.signal.aborted || text === undefined) return null;
        this.cached = { reply, text };
        return text;
      });
      this.pending = { reply, controller, result };
      return await result;
    } finally {
      clearTimeout(timer);
      if (this.pending?.controller === controller) this.pending = undefined;
    }
  }
}
