import type { ProjectMemoryEntry } from "./types/filesystem.js";

/**
 * mc-agent (MC-ADR-0024): how memory notes reach the system prompt.
 *
 * Small memories go in whole. Once one grows past its budget only an index
 * goes in — one line per note with its id, kind, title and hook — and the
 * agent reads a note with `Recall`. Suggestions waiting for the user never
 * go in.
 */

export const MEMORY_KINDS = ["user", "feedback", "project", "reference"] as const;
export type MemoryKind = (typeof MEMORY_KINDS)[number];

export const RECALL_TOOL_NAME = "Recall";
export const MEMORY_HOOK_MAX = 150;
/** Project memory above this many characters is indexed instead of inlined. */
export const PROJECT_MEMORY_INLINE_BUDGET = 6_000;
export const USER_MEMORY_INLINE_BUDGET = 3_000;
/** Notes about the user kept across projects. */
export const USER_MEMORY_MAX_ENTRIES = 60;
export const USER_MEMORY_ID_PREFIX = "user-";

export function isMemoryKind(value: unknown): value is MemoryKind {
  return typeof value === "string" && (MEMORY_KINDS as readonly string[]).includes(value);
}

/** Notes in force: everything but the suggestions waiting for the user. */
export function activeMemoryEntries(entries: readonly ProjectMemoryEntry[]): ProjectMemoryEntry[] {
  return entries.filter((entry) => !entry.pending && entry.content.trim());
}

function renderWhole(entries: readonly ProjectMemoryEntry[]): string {
  return entries
    .map((entry) => {
      const title = entry.title.trim();
      const tag = entry.kind ? ` (${entry.kind})` : "";
      return title ? `### ${title}${tag}\n\n${entry.content.trim()}` : entry.content.trim();
    })
    .join("\n\n");
}

function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function renderIndex(entries: readonly ProjectMemoryEntry[]): string {
  return entries
    .map((entry) => {
      const title = entry.title.trim() || oneLine(entry.content, 60);
      const hook = entry.hook?.trim() || oneLine(entry.content, 100);
      return `- [${entry.id}]${entry.kind ? ` (${entry.kind})` : ""} ${title} — ${hook}`;
    })
    .join("\n");
}

/** One memory as it goes into the prompt: whole when small, else its index. */
export function memorySection(entries: readonly ProjectMemoryEntry[], budget: number): { text: string; indexed: boolean } | null {
  const active = activeMemoryEntries(entries);
  if (!active.length) return null;
  const whole = renderWhole(active);
  if (whole.length <= budget) return { text: whole, indexed: false };
  return { text: renderIndex(active), indexed: true };
}

/**
 * The memory text a session starts with: this project's notes, then the
 * notes about the user. `legacyContent` is a project memory written as one
 * block before notes existed.
 */
export function composeMemoryPrompt(input: {
  projectEntries?: readonly ProjectMemoryEntry[] | null;
  legacyContent?: string;
  userEntries?: readonly ProjectMemoryEntry[] | null;
}): string | undefined {
  const parts: string[] = [];
  let indexed = false;
  const project = input.projectEntries
    ? memorySection(input.projectEntries, PROJECT_MEMORY_INLINE_BUDGET)
    : input.legacyContent?.trim()
      ? { text: input.legacyContent.trim(), indexed: false }
      : null;
  if (project) {
    parts.push(`## This project\n\n${project.text}`);
    indexed ||= project.indexed;
  }
  const user = input.userEntries ? memorySection(input.userEntries, USER_MEMORY_INLINE_BUDGET) : null;
  if (user) {
    parts.push(`## About the user (all projects)\n\n${user.text}`);
    indexed ||= user.indexed;
  }
  if (!parts.length) return undefined;
  if (indexed) {
    parts.push(
      `Lines in the form \`- [id] (kind) title — summary\` are an index: call \`${RECALL_TOOL_NAME}\` with the id to read a note in full before relying on it.`,
    );
  }
  parts.push(
    "Notes reflect what was true when written; check a file, function or flag a note names before acting on it.",
  );
  return parts.join("\n\n");
}

/**
 * Apply the user's answer to a suggestion waiting in `entries`. Keeping an
 * addition makes it a note; keeping an update rewrites the note it names
 * (which keeps its id) and drops the suggestion; keeping a removal deletes
 * that note. Declining only drops the suggestion.
 */
export function resolveMemorySuggestion(
  entries: readonly ProjectMemoryEntry[],
  id: string,
  keep: boolean,
  now = Date.now(),
): ProjectMemoryEntry[] {
  const suggestion = entries.find((entry) => entry.id === id && entry.pending);
  if (!suggestion?.pending) return [...entries];
  const rest = entries.filter((entry) => entry.id !== id);
  if (!keep) return rest;
  const { pending, ...note } = suggestion;
  const target = pending.replaces;
  if (target && pending.remove) return rest.filter((entry) => entry.id !== target);
  if (target && rest.some((entry) => entry.id === target)) {
    return rest.map((entry) =>
      entry.id === target
        ? {
            ...entry,
            title: note.title,
            content: note.content,
            ...(note.kind ? { kind: note.kind } : {}),
            ...(note.hook ? { hook: note.hook } : {}),
            ...(note.source ? { source: note.source } : {}),
            updatedAt: now,
          }
        : entry,
    );
  }
  return [...rest, { ...note, updatedAt: now }];
}

/** The notes as a review sees them: id, kind, title, whether it may change it, and the text. */
export function memoryForReview(
  sections: Array<{ scope: "project" | "user"; entries: readonly ProjectMemoryEntry[]; editable: (entry: ProjectMemoryEntry) => boolean }>,
): string {
  return sections
    .flatMap(({ scope, entries, editable }) =>
      activeMemoryEntries(entries).map((entry) => {
        const tags = [scope, entry.kind, editable(entry) ? "editable" : "user's own"].filter(Boolean).join(", ");
        return `- [${entry.id}] (${tags}) ${entry.title.trim() || "(untitled)"}: ${oneLine(entry.content, 400)}`;
      }),
    )
    .join("\n");
}
