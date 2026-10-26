import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import {
  AGENT_MEMORY_CONTENT_MAX,
  AGENT_MEMORY_ID_PREFIX,
  AGENT_MEMORY_MAX_ENTRIES,
  AGENT_MEMORY_TITLE_MAX,
  MEMORY_HOOK_MAX,
  USER_MEMORY_MAX_ENTRIES,
  isAgentMemoryEntry,
  isMemoryKind,
  type ProjectMemoryEntry,
} from "@pi-desktop/shared";
import type { LocalToolHandler } from "./agent-sidecar";

/*
  mc-agent (MC-ADR-0019): the agent's `Remember` tool. A note goes into the
  memory of the project the conversation belongs to, beside the user's own
  entries, with an `agent-` id. The agent can replace or remove only its own
  notes, matched by title; the user's entries are never touched.
*/

type Host = { call<T>(method: string, params?: Record<string, unknown>): Promise<T> };
type Entry = ProjectMemoryEntry;
type GroupRecord = { id: string; roots: Array<{ path: string }> };

export type RememberOutcome =
  | { action: "saved" | "replaced" | "removed"; title: string; agentNotes: number }
  | { error: string; message: string };

const sameTitle = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/** The entries after applying one `Remember` call, or why it cannot apply. */
export function applyRemember(
  entries: readonly Entry[],
  input: { title?: unknown; content?: unknown; kind?: unknown; hook?: unknown },
  newId: () => string = () => `${AGENT_MEMORY_ID_PREFIX}${randomUUID()}`,
  /** mc-agent (MC-ADR-0024): where the note came from, and how many may exist. */
  context: { sessionId?: string; now?: number; limit?: number; isOwn?: (entry: Entry) => boolean } = {},
): { entries: Entry[]; outcome: RememberOutcome } {
  const isOwn = context.isOwn ?? isAgentMemoryEntry;
  const limit = context.limit ?? AGENT_MEMORY_MAX_ENTRIES;
  const fail = (error: string, message: string) => ({ entries: [...entries], outcome: { error, message } });
  const title = typeof input.title === "string" ? input.title.trim() : "";
  const content = typeof input.content === "string" ? input.content.trim() : "";
  if (!title) return fail("INVALID_ARGUMENT", "title is required.");
  if (title.length > AGENT_MEMORY_TITLE_MAX) return fail("INVALID_ARGUMENT", `title is longer than ${AGENT_MEMORY_TITLE_MAX} characters.`);
  if (content.length > AGENT_MEMORY_CONTENT_MAX) {
    return fail("INVALID_ARGUMENT", `content is longer than ${AGENT_MEMORY_CONTENT_MAX} characters; save one fact per note.`);
  }
  if (input.kind !== undefined && !isMemoryKind(input.kind)) {
    return fail("INVALID_ARGUMENT", "kind must be user, feedback, project or reference.");
  }
  const hook = typeof input.hook === "string" ? input.hook.replace(/\s+/g, " ").trim().slice(0, MEMORY_HOOK_MAX) : "";
  const fields: Partial<Entry> = {
    ...(isMemoryKind(input.kind) ? { kind: input.kind } : {}),
    ...(hook ? { hook } : {}),
    ...(context.now !== undefined ? { updatedAt: context.now } : {}),
    ...(context.sessionId && context.now !== undefined
      ? { source: { sessionId: context.sessionId, at: context.now } }
      : {}),
  };
  // A suggestion waiting for the user is not a note yet.
  const index = entries.findIndex((entry) => isOwn(entry) && !entry.pending && sameTitle(entry.title, title));
  const count = (list: Entry[]) => list.filter((entry) => isOwn(entry) && !entry.pending).length;
  if (!content) {
    if (index < 0) return fail("NOT_FOUND", `You have no note titled "${title}".`);
    const next = entries.filter((_, position) => position !== index);
    return { entries: next, outcome: { action: "removed", title, agentNotes: count(next) } };
  }
  if (index >= 0) {
    const next = entries.map((entry, position) => (position === index ? { ...entry, title, content, ...fields } : entry));
    return { entries: next, outcome: { action: "replaced", title, agentNotes: count(next) } };
  }
  if (count([...entries]) >= limit) {
    return fail("LIMIT_REACHED", `This memory already holds ${limit} of your notes; replace or remove one first.`);
  }
  const next = [...entries, { id: newId(), title, content, ...fields }];
  return { entries: next, outcome: { action: "saved", title, agentNotes: count(next) } };
}

/** Where a session's project memory lives: its project group, or the bare folder. */
export async function memoryTarget(host: Host, sessionId: string) {
  const { session } = await host.call<{ session?: { projectPath?: string } }>("session.get", { id: sessionId, messageLimit: 1 });
  const projectPath = session?.projectPath?.trim();
  if (!projectPath) return null;
  const { groups } = await host.call<{ groups?: GroupRecord[] }>("project.groups.list");
  const group = (groups ?? []).find((candidate) =>
    candidate.roots.some((root) => resolve(root.path) === resolve(projectPath)));
  if (group) {
    return {
      read: async () => (await host.call<{ memory?: { entries?: Entry[]; content?: string } }>("project.group.memory.get", { groupId: group.id })).memory,
      write: (entries: Entry[]) => host.call("project.group.memory.set", { groupId: group.id, entries }),
    };
  }
  return {
    read: async () => (await host.call<{ memory?: { entries?: Entry[]; content?: string } }>("project.memory.get", { path: projectPath })).memory,
    write: (entries: Entry[]) => host.call("project.memory.set", { path: projectPath, entries }),
  };
}

export function createRememberTool(
  getHost: () => Host | null,
  userMemory?: { read: () => Promise<Entry[]>; write: (entries: Entry[]) => Promise<unknown> },
): LocalToolHandler {
  return async ({ sessionId, args }) => {
    const fail = (errorCode: string, message: string) => ({ ok: false, isError: true, errorCode, content: { kind: "remember-error", errorCode, message } });
    const host = getHost();
    if (!host) return fail("HOST_UNAVAILABLE", "Host unavailable.");
    const input = (args ?? {}) as { title?: unknown; content?: unknown; kind?: unknown; hook?: unknown; scope?: unknown };
    const now = Date.now();
    // mc-agent (MC-ADR-0024): notes about the user go to the memory every
    // project shares; a conversation outside any project has only that one.
    const target = input.scope === "user" ? null : await memoryTarget(host, sessionId);
    if (input.scope === "user" || !target) {
      if (!userMemory) {
        return fail("NO_PROJECT", "This conversation is not in a project, so there is no project memory to save to.");
      }
      const { entries: next, outcome } = applyRemember(await userMemory.read(), input, newUserNoteId, {
        sessionId,
        now,
        limit: USER_MEMORY_MAX_ENTRIES,
        isOwn: () => true,
      });
      if ("error" in outcome) return fail(outcome.error, outcome.message);
      try {
        await userMemory.write(next);
      } catch (error) {
        return fail("SAVE_FAILED", error instanceof Error ? error.message : String(error));
      }
      return {
        ok: true,
        content: {
          kind: "remember",
          ...outcome,
          scope: "user",
          note: "Saved to the memory about the user, which loads in every conversation; the user can edit or delete it in Settings → Memory.",
        },
      };
    }
    const memory = await target.read();
    // Memory written as one free-text block before entries existed becomes
    // the first entry, so a note never wipes it.
    const legacy = memory?.content?.trim();
    const entries: Entry[] = memory?.entries ?? (legacy ? [{ id: randomUUID(), title: "", content: legacy }] : []);
    const { entries: next, outcome } = applyRemember(entries, input, undefined, { sessionId, now });
    if ("error" in outcome) return fail(outcome.error, outcome.message);
    try {
      await target.write(next);
    } catch (error) {
      return fail("SAVE_FAILED", error instanceof Error ? error.message : String(error));
    }
    return {
      ok: true,
      content: {
        kind: "remember",
        ...outcome,
        scope: "project",
        note: "Saved to project memory. It loads in new conversations of this project; the user can edit or delete it there.",
      },
    };
  };
}

const newUserNoteId = () => `user-${randomUUID()}`;
