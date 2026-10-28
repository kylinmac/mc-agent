import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  AGENT_MEMORY_CONTENT_MAX,
  AGENT_MEMORY_ID_PREFIX,
  AGENT_MEMORY_TITLE_MAX,
  MEMORY_HOOK_MAX,
  USER_MEMORY_ID_PREFIX,
  USER_MEMORY_MAX_ENTRIES,
  activeMemoryEntries,
  composeMemoryPrompt,
  isAgentMemoryEntry,
  isMemoryKind,
  memoryForReview,
  type ProjectMemoryEntry,
} from "@pi-desktop/shared";
import type { LocalToolHandler } from "./agent-sidecar";
import { memoryTarget } from "./mc-agent-memory.ts";

/*
  mc-agent (MC-ADR-0024): the memory about the user (one file in the data
  directory, shared by every project), the `Recall` tool, the memory text a
  session starts with, and the review that suggests notes once a
  conversation went idle. Suggestions are stored as `pending` notes and stay
  out of the prompt until the user keeps them.
*/

type Entry = ProjectMemoryEntry;
type Host = { call<T>(method: string, params?: Record<string, unknown>): Promise<T> };

const FILE_NAME = "mc-memory.json";
/** A conversation is reviewed once it has been idle this long after a reply. */
export const MEMORY_REVIEW_IDLE_MS = 90_000;
/** Suggestions waiting in one memory; older ones make room for newer. */
const MAX_PENDING = 12;

export type MemorySettings = { user: Entry[]; review: boolean };

function text(value: unknown, max: number): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

/** A stored or submitted note, bounded like the project memory notes. */
export function normalizeMemoryEntry(value: unknown): Entry | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const id = text(raw.id, 200);
  const content = text(raw.content, AGENT_MEMORY_CONTENT_MAX);
  if (!id || !content) return null;
  const hook = text(raw.hook, MEMORY_HOOK_MAX).replace(/\s+/g, " ");
  const source = raw.source && typeof raw.source === "object" ? (raw.source as Record<string, unknown>) : null;
  const pending = raw.pending && typeof raw.pending === "object" ? (raw.pending as Record<string, unknown>) : null;
  return {
    id,
    title: text(raw.title, AGENT_MEMORY_TITLE_MAX),
    content,
    ...(isMemoryKind(raw.kind) ? { kind: raw.kind } : {}),
    ...(hook ? { hook } : {}),
    ...(source && typeof source.sessionId === "string" && typeof source.at === "number"
      ? {
          source: {
            sessionId: source.sessionId.slice(0, 200),
            at: source.at,
            ...(typeof source.title === "string" ? { title: source.title.slice(0, 200) } : {}),
          },
        }
      : {}),
    ...(pending
      ? {
          pending: {
            ...(typeof pending.reason === "string" ? { reason: pending.reason.slice(0, 300) } : {}),
            ...(typeof pending.replaces === "string" ? { replaces: pending.replaces.slice(0, 200) } : {}),
            ...(pending.remove === true ? { remove: true } : {}),
          },
        }
      : {}),
    ...(typeof raw.updatedAt === "number" ? { updatedAt: raw.updatedAt } : {}),
  };
}

function normalizeEntries(value: unknown): Entry[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const entries: Entry[] = [];
  for (const item of value) {
    const entry = normalizeMemoryEntry(item);
    if (!entry || seen.has(entry.id)) continue;
    seen.add(entry.id);
    entries.push(entry);
  }
  return entries.slice(0, USER_MEMORY_MAX_ENTRIES + MAX_PENDING);
}

export async function loadMemorySettings(dataDir: string): Promise<MemorySettings> {
  try {
    const parsed = JSON.parse(await readFile(join(dataDir, FILE_NAME), "utf8")) as { user?: unknown; review?: unknown };
    return { user: normalizeEntries(parsed?.user), review: parsed?.review === true };
  } catch {
    return { user: [], review: false };
  }
}

export async function saveMemorySettings(dataDir: string, patch: Partial<MemorySettings>): Promise<MemorySettings> {
  const current = await loadMemorySettings(dataDir);
  const next: MemorySettings = {
    user: patch.user !== undefined ? normalizeEntries(patch.user) : current.user,
    review: patch.review !== undefined ? patch.review === true : current.review,
  };
  const path = join(dataDir, FILE_NAME);
  await mkdir(dataDir, { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify({ version: 1, ...next }, null, 2)}\n`, "utf8");
  await rename(temporary, path);
  return next;
}

export function userMemoryStore(dataDir: string) {
  return {
    read: async () => (await loadMemorySettings(dataDir)).user,
    write: (entries: Entry[]) => saveMemorySettings(dataDir, { user: entries }),
  };
}

/** The memory text a session starts with (see composeMemoryPrompt). */
export async function sessionMemoryPrompt(
  dataDir: string,
  project: { entries?: Entry[] | null; content?: string } | null | undefined,
): Promise<string | undefined> {
  const { user } = await loadMemorySettings(dataDir);
  return composeMemoryPrompt({
    projectEntries: project?.entries ?? null,
    legacyContent: project?.entries ? undefined : project?.content,
    userEntries: user,
  });
}

export function createRecallTool(getHost: () => Host | null, dataDir: string): LocalToolHandler {
  return async ({ sessionId, args }) => {
    const fail = (errorCode: string, message: string) => ({ ok: false, isError: true, errorCode, content: { kind: "recall-error", errorCode, message } });
    const id = text((args as { id?: unknown } | null)?.id, 200).replace(/^\[|\]$/g, "");
    if (!id) return fail("INVALID_ARGUMENT", "id is required.");
    const host = getHost();
    const target = host ? await memoryTarget(host, sessionId).catch(() => null) : null;
    const project = target ? ((await target.read().catch(() => undefined))?.entries ?? []) : [];
    const { user } = await loadMemorySettings(dataDir);
    const found =
      activeMemoryEntries(project).find((entry) => entry.id === id) ??
      activeMemoryEntries(user).find((entry) => entry.id === id);
    if (!found) return fail("NOT_FOUND", `No memory note with id ${id}. Use an id from the memory index.`);
    const { pending: _pending, ...note } = found;
    return { ok: true, content: { kind: "recall", scope: project.includes(found) ? "project" : "user", ...note } };
  };
}

export type ReviewSuggestion = {
  action: "add" | "update" | "remove";
  scope: "project" | "user";
  target?: string;
  kind?: Entry["kind"];
  title: string;
  hook?: string;
  content: string;
  reason?: string;
};

/**
 * The memory after adding a review's suggestions as `pending` notes. An
 * update or removal must name a note the agent may change; one whose title
 * already waits is skipped, and the oldest suggestions make room.
 */
export function addSuggestions(
  entries: readonly Entry[],
  suggestions: readonly ReviewSuggestion[],
  options: { editable: (entry: Entry) => boolean; newId: () => string; sessionId: string; sessionTitle?: string; now: number },
): { entries: Entry[]; added: number } {
  let next = [...entries];
  let added = 0;
  for (const suggestion of suggestions) {
    const waiting = next.some(
      (entry) => entry.pending && entry.title.trim().toLowerCase() === suggestion.title.trim().toLowerCase(),
    );
    if (waiting) continue;
    let target: Entry | undefined;
    if (suggestion.action !== "add") {
      target = next.find((entry) => entry.id === suggestion.target && !entry.pending);
      if (!target || !options.editable(target)) continue;
    }
    const removing = suggestion.action === "remove";
    next.push({
      id: options.newId(),
      title: removing ? target!.title : suggestion.title,
      content: removing ? target!.content : suggestion.content,
      ...(suggestion.kind ? { kind: suggestion.kind } : removing && target?.kind ? { kind: target.kind } : {}),
      ...(suggestion.hook ? { hook: suggestion.hook } : {}),
      source: { sessionId: options.sessionId, at: options.now, ...(options.sessionTitle ? { title: options.sessionTitle } : {}) },
      pending: {
        ...(suggestion.reason ? { reason: suggestion.reason } : {}),
        ...(target ? { replaces: target.id } : {}),
        ...(removing ? { remove: true } : {}),
      },
    });
    added += 1;
  }
  const pending = next.filter((entry) => entry.pending);
  if (pending.length > MAX_PENDING) {
    const drop = new Set(pending.slice(0, pending.length - MAX_PENDING).map((entry) => entry.id));
    next = next.filter((entry) => !drop.has(entry.id));
  }
  return { entries: next, added };
}

export type MemoryReviewDeps = {
  getHost: () => Host | null;
  dataDir: string;
  /** Asks the session's runtime; null when it has nothing (busy, not loaded). */
  review: (sessionId: string, memory: string, mode: "auto" | "consolidate") => Promise<ReviewSuggestion[] | null>;
  /** Tells the window that suggestions are waiting. */
  notify: (event: { sessionId: string; added: number }) => void;
  log?: (message: string, error?: unknown) => void;
  idleMs?: number;
};

/**
 * Schedules the review after a conversation goes idle, and runs one on
 * request (the memory panel's Tidy up). Timers are per session; a new turn
 * restarts the wait, and the runtime refuses while a turn runs.
 */
export function createMemoryReview(deps: MemoryReviewDeps) {
  const timers = new Map<string, ReturnType<typeof setTimeout>>();

  const run = async (sessionId: string, mode: "auto" | "consolidate"): Promise<{ added: number } | null> => {
    const host = deps.getHost();
    const target = host ? await memoryTarget(host, sessionId).catch(() => null) : null;
    const projectMemory = target ? await target.read().catch(() => undefined) : undefined;
    const project = projectMemory?.entries ?? [];
    const user = userMemoryStore(deps.dataDir);
    const userEntries = await user.read();
    const listing = memoryForReview([
      ...(target ? [{ scope: "project" as const, entries: project, editable: isAgentMemoryEntry }] : []),
      { scope: "user" as const, entries: userEntries, editable: () => true },
    ]);
    const suggestions = await deps.review(sessionId, listing, mode);
    if (!suggestions?.length) return suggestions ? { added: 0 } : null;
    const session = host
      ? await host.call<{ session?: { title?: string } }>("session.get", { id: sessionId, messageLimit: 1 }).catch(() => null)
      : null;
    const base = { sessionId, sessionTitle: session?.session?.title, now: Date.now() };
    let added = 0;
    const forProject = suggestions.filter((item) => item.scope === "project" && target);
    if (forProject.length && target) {
      const result = addSuggestions(project, forProject, {
        ...base,
        editable: isAgentMemoryEntry,
        newId: () => `${AGENT_MEMORY_ID_PREFIX}${randomUUID()}`,
      });
      if (result.added) await target.write(result.entries);
      added += result.added;
    }
    const forUser = suggestions.filter((item) => item.scope === "user" || !target);
    if (forUser.length) {
      const result = addSuggestions(userEntries, forUser.map((item) => ({ ...item, scope: "user" })), {
        ...base,
        editable: () => true,
        newId: () => `${USER_MEMORY_ID_PREFIX}${randomUUID()}`,
      });
      if (result.added) await user.write(result.entries);
      added += result.added;
    }
    if (added) deps.notify({ sessionId, added });
    return { added };
  };

  return {
    /** A turn of `sessionId` ended; review it once it stays idle. */
    turnEnded(sessionId: string, completed: boolean): void {
      const previous = timers.get(sessionId);
      if (previous) clearTimeout(previous);
      timers.delete(sessionId);
      if (!completed) return;
      const timer = setTimeout(() => {
        timers.delete(sessionId);
        void loadMemorySettings(deps.dataDir)
          .then((settings) => (settings.review ? run(sessionId, "auto") : null))
          .catch((error: unknown) => deps.log?.("memory review failed", error));
      }, deps.idleMs ?? MEMORY_REVIEW_IDLE_MS);
      timer.unref?.();
      timers.set(sessionId, timer);
    },
    /** The panel's Tidy up: a consolidating review on one session now. */
    consolidate: (sessionId: string) => run(sessionId, "consolidate"),
    dispose(): void {
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
    },
  };
}

/** The reviewer the app registered; turn ends are forwarded to it. */
let activeReview: ReturnType<typeof createMemoryReview> | null = null;

export function setMemoryReview(review: ReturnType<typeof createMemoryReview> | null): void {
  activeReview?.dispose();
  activeReview = review;
}

/** Called by the turn settlement for every turn that ends. */
export function noteTurnEndedForMemory(sessionId: string, reason: string): void {
  if (sessionId.startsWith("remote:") || sessionId.startsWith("native-pi:")) return;
  activeReview?.turnEnded(sessionId, reason === "completed");
}

export function consolidateMemory(sessionId: string): Promise<{ added: number } | null> {
  return activeReview ? activeReview.consolidate(sessionId) : Promise.resolve(null);
}
