import type { AssistantMessage } from "@earendil-works/pi-ai";
import { AGENT_MEMORY_CONTENT_MAX, AGENT_MEMORY_TITLE_MAX, MEMORY_HOOK_MAX, isMemoryKind, type MemoryKind } from "@pi-desktop/shared";

/**
 * mc-agent (MC-ADR-0024): the request that looks back over a conversation
 * for memory worth keeping, and the reading of its answer. Suggestions are
 * only suggestions: the desktop stores them as waiting for the user.
 */

/** An automatic review waits for this many new user messages. */
export const MEMORY_REVIEW_MIN_NEW_MESSAGES = 2;
export const MEMORY_REVIEW_MAX_SUGGESTIONS = 3;

export type MemoryReviewSuggestion = {
  action: "add" | "update" | "remove";
  scope: "project" | "user";
  /** The note an update or removal is about. */
  target?: string;
  kind?: MemoryKind;
  title: string;
  hook?: string;
  content: string;
  reason?: string;
};

export function memoryReviewRequest(memory: string, mode: "auto" | "consolidate"): string {
  return [
    "[Memory review — not a message from the user. Do not reply to the conversation and do not call tools.]",
    mode === "consolidate"
      ? "Review the memory notes below for duplicates, notes that the conversation or other notes show are outdated or wrong, and vague notes. Suggest updates or removals; suggest additions only for clear gaps."
      : "Look back over this conversation and suggest what is worth keeping for future conversations.",
    "Keep: corrections or confirmed approaches the user gave about how to work, with the reason (kind feedback); facts about the user that hold across projects (kind user, scope user); decisions, constraints or goals of this project that the code and docs do not record (kind project, with absolute dates); pointers to external resources (kind reference).",
    "Do not keep: code structure, file contents, anything the repository or its docs already say, temporary task state, or anything secret.",
    "Prefer updating an existing note over adding a near-duplicate. Only notes marked (editable) may be updated or removed.",
    `Suggest at most ${MEMORY_REVIEW_MAX_SUGGESTIONS}, and none when nothing qualifies; most conversations need none.`,
    "Answer with JSON only, no prose: {\"suggestions\":[{\"action\":\"add|update|remove\",\"scope\":\"project|user\",\"target\":\"<id, for update/remove>\",\"kind\":\"user|feedback|project|reference\",\"title\":\"<short>\",\"hook\":\"<one line>\",\"content\":\"<the note>\",\"reason\":\"<why, one line>\"}]}",
    "",
    "Current notes:",
    memory.trim() || "(none)",
  ].join("\n");
}

function text(message: AssistantMessage): string {
  return message.content
    .flatMap((part) => (part.type === "text" ? [part.text] : []))
    .join("")
    .trim();
}

function clip(value: unknown, max: number): string {
  return typeof value === "string" ? value.replace(/\r/g, "").trim().slice(0, max) : "";
}

/** The suggestions in a review answer; an answer that is not JSON gives none. */
export function parseMemoryReview(message: AssistantMessage): MemoryReviewSuggestion[] | null {
  const raw = text(message);
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return [];
  }
  const list = (parsed as { suggestions?: unknown })?.suggestions;
  if (!Array.isArray(list)) return [];
  const suggestions: MemoryReviewSuggestion[] = [];
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const entry = item as Record<string, unknown>;
    const action = entry.action === "update" || entry.action === "remove" ? entry.action : entry.action === "add" ? "add" : null;
    if (!action) continue;
    const target = clip(entry.target, 200);
    if (action !== "add" && !target) continue;
    const title = clip(entry.title, AGENT_MEMORY_TITLE_MAX);
    const content = clip(entry.content, AGENT_MEMORY_CONTENT_MAX);
    if (action !== "remove" && (!title || !content)) continue;
    const hook = clip(entry.hook, MEMORY_HOOK_MAX).replace(/\s+/g, " ");
    const reason = clip(entry.reason, 300).replace(/\s+/g, " ");
    suggestions.push({
      action,
      scope: entry.scope === "user" ? "user" : "project",
      ...(target ? { target } : {}),
      ...(isMemoryKind(entry.kind) ? { kind: entry.kind } : {}),
      title,
      ...(hook ? { hook } : {}),
      content,
      ...(reason ? { reason } : {}),
    });
    if (suggestions.length >= MEMORY_REVIEW_MAX_SUGGESTIONS) break;
  }
  return suggestions;
}
