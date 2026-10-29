import { randomUUID } from "node:crypto";
import {
  AGENT_MEMORY_CONTENT_MAX,
  AGENT_MEMORY_ID_PREFIX,
  AGENT_MEMORY_MAX_ENTRIES,
  AGENT_MEMORY_TITLE_MAX,
  isAgentMemoryEntry,
  type ProjectMemory,
} from "@pi-desktop/shared";
import type { LocalToolHandler } from "./agent-sidecar";

/*
  mc-agent (MC-ADR-0019): the agent's `Remember` tool. A note goes into the
  memory of the project the conversation belongs to, beside the user's own
  entries, with an `agent-` id. The agent can replace or remove only its own
  notes, matched by title; the user's entries are never touched.
*/

type Host = { call<T>(method: string, params?: Record<string, unknown>): Promise<T> };
type Entry = { id: string; title: string; content: string };

export type RememberOutcome =
  | { action: "saved" | "replaced" | "removed"; title: string; agentNotes: number }
  | { error: string; message: string };

const sameTitle = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/** The entries after applying one `Remember` call, or why it cannot apply. */
export function applyRemember(
  entries: readonly Entry[],
  input: { title?: unknown; content?: unknown },
  newId: () => string = () => `${AGENT_MEMORY_ID_PREFIX}${randomUUID()}`,
): { entries: Entry[]; outcome: RememberOutcome } {
  const fail = (error: string, message: string) => ({ entries: [...entries], outcome: { error, message } });
  const title = typeof input.title === "string" ? input.title.trim() : "";
  const content = typeof input.content === "string" ? input.content.trim() : "";
  if (!title) return fail("INVALID_ARGUMENT", "title is required.");
  if (title.length > AGENT_MEMORY_TITLE_MAX) return fail("INVALID_ARGUMENT", `title is longer than ${AGENT_MEMORY_TITLE_MAX} characters.`);
  if (content.length > AGENT_MEMORY_CONTENT_MAX) {
    return fail("INVALID_ARGUMENT", `content is longer than ${AGENT_MEMORY_CONTENT_MAX} characters; save one fact per note.`);
  }
  const index = entries.findIndex((entry) => isAgentMemoryEntry(entry) && sameTitle(entry.title, title));
  const count = (list: Entry[]) => list.filter(isAgentMemoryEntry).length;
  if (!content) {
    if (index < 0) return fail("NOT_FOUND", `You have no note titled "${title}".`);
    const next = entries.filter((_, position) => position !== index);
    return { entries: next, outcome: { action: "removed", title, agentNotes: count(next) } };
  }
  if (index >= 0) {
    const next = entries.map((entry, position) => (position === index ? { ...entry, title, content } : entry));
    return { entries: next, outcome: { action: "replaced", title, agentNotes: count(next) } };
  }
  if (count([...entries]) >= AGENT_MEMORY_MAX_ENTRIES) {
    return fail("LIMIT_REACHED", `This project already holds ${AGENT_MEMORY_MAX_ENTRIES} of your notes; replace or remove one first.`);
  }
  const next = [...entries, { id: newId(), title, content }];
  return { entries: next, outcome: { action: "saved", title, agentNotes: count(next) } };
}

/** Where a session's project memory lives: its project group, or the bare folder. */
async function memoryTarget(host: Host, sessionId: string) {
  const { session } = await host.call<{ session?: { projectPath?: string } }>("session.get", { id: sessionId, messageLimit: 1 });
  const projectPath = session?.projectPath?.trim();
  if (!projectPath) return null;
  const { context } = await host.call<{ context?: { groupId: string } | null }>("project.group.context", { path: projectPath });
  if (context) {
    return {
      read: async () => (await host.call<{ memory: ProjectMemory }>("project.group.memory.get", { groupId: context.groupId })).memory,
      write: (entries: Entry[], expectedMemory: ProjectMemory) => host.call("project.group.memory.set", { groupId: context.groupId, entries, expectedMemory }),
    };
  }
  return {
    read: async () => (await host.call<{ memory: ProjectMemory }>("project.memory.get", { path: projectPath })).memory,
    write: (entries: Entry[], expectedMemory: ProjectMemory) => host.call("project.memory.set", { path: projectPath, entries, expectedMemory }),
  };
}

export function createRememberTool(getHost: () => Host | null): LocalToolHandler {
  return async ({ sessionId, args }) => {
    const fail = (errorCode: string, message: string) => ({ ok: false, isError: true, errorCode, content: { kind: "remember-error", errorCode, message } });
    const host = getHost();
    if (!host) return fail("HOST_UNAVAILABLE", "Host unavailable.");
    const target = await memoryTarget(host, sessionId);
    if (!target) return fail("NO_PROJECT", "This conversation is not in a project, so there is no project memory to save to.");
    for (let attempt = 0; attempt < 3; attempt++) {
      const memory = await target.read();
      // Memory written as one free-text block before entries existed becomes
      // the first entry, so a note never wipes it.
      const legacy = memory.content.trim();
      const entries: Entry[] = memory.entries ?? (legacy ? [{ id: randomUUID(), title: "", content: legacy }] : []);
      const { entries: next, outcome } = applyRemember(entries, (args ?? {}) as { title?: unknown; content?: unknown });
      if ("error" in outcome) return fail(outcome.error, outcome.message);
      try {
        await target.write(next, memory);
      } catch (error) {
        if (typeof error === "object" && error !== null && "errorCode" in error && error.errorCode === "MEMORY_CONFLICT") continue;
        return fail("SAVE_FAILED", error instanceof Error ? error.message : String(error));
      }
      return {
        ok: true,
        content: {
          kind: "remember",
          ...outcome,
          note: "Saved to project memory. It loads in new conversations of this project; the user can edit or delete it there.",
        },
      };
    }
    return fail("MEMORY_CONFLICT", "Project memory is changing concurrently. Try saving this note again.");
  };
}
