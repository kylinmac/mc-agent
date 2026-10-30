/**
 * mc-agent (R21.2): after a compaction, re-read a few files the summarized
 * range worked on so the model does not edit from memory.
 *
 * Optional by design: zero files is a valid outcome (no budget, nothing
 * readable, a read would need approval). Snapshots live in the checkpoint's
 * details next to the summary, are read once at compaction time and never
 * re-read on rebuild. See docs/mc-agent/compaction-context-restore.md.
 */
import type { AgentMessage } from "@earendil-works/pi-agent-core";

export const RESTORE_MAX_FILES = 5;
export const RESTORE_FILE_MAX_TOKENS = 5_000;
export const RESTORE_TOTAL_MAX_TOKENS = 8_000;
export const RESTORE_TIME_BUDGET_MS = 10_000;
export const RESTORE_CONCURRENCY = 2;
const CHARS_PER_TOKEN = 4;

export type RestoredFile = {
  path: string;
  offset?: number;
  limit?: number;
  readAt: string;
  text: string;
  truncated: boolean;
};

export type RestoreCandidate = { path: string; offset?: number; limit?: number };

export type RestoreSkip = { path: string; reason: string };

type ToolCallBlock = { id: string; name: string; arguments?: Record<string, unknown> };

function toolCalls(message: AgentMessage): ToolCallBlock[] {
  if (message.role !== "assistant" || !Array.isArray(message.content)) return [];
  const calls: ToolCallBlock[] = [];
  for (const block of message.content as unknown[]) {
    if (!block || typeof block !== "object") continue;
    const candidate = block as { type?: unknown; id?: unknown; name?: unknown; arguments?: unknown };
    if (candidate.type !== "toolCall" || typeof candidate.id !== "string" || typeof candidate.name !== "string") continue;
    calls.push({
      id: candidate.id,
      name: candidate.name,
      ...(candidate.arguments && typeof candidate.arguments === "object"
        ? { arguments: candidate.arguments as Record<string, unknown> } : {}),
    });
  }
  return calls;
}

function succeededCalls(messages: readonly AgentMessage[]): Set<string> {
  const ok = new Set<string>();
  for (const message of messages) {
    if (message.role !== "toolResult") continue;
    const result = message as { toolCallId?: unknown; isError?: unknown };
    if (typeof result.toolCallId === "string" && result.isError !== true) ok.add(result.toolCallId);
  }
  return ok;
}

type FileOp = { kind: "read" | "write"; path: string; offset?: number; limit?: number };

/** Successful file operations in message order. Accepts pi's lowercase names too. */
function fileOps(messages: readonly AgentMessage[]): FileOp[] {
  const ok = succeededCalls(messages);
  const ops: FileOp[] = [];
  for (const message of messages) {
    for (const call of toolCalls(message)) {
      if (!ok.has(call.id)) continue;
      const path = typeof call.arguments?.path === "string" ? call.arguments.path.trim() : "";
      if (!path) continue;
      const name = call.name.toLowerCase();
      if (name === "read") {
        const offset = call.arguments?.offset;
        const limit = call.arguments?.limit;
        ops.push({
          kind: "read",
          path,
          ...(typeof offset === "number" && offset > 0 ? { offset: Math.floor(offset) } : {}),
          ...(typeof limit === "number" && limit > 0 ? { limit: Math.floor(limit) } : {}),
        });
      } else if (name === "edit" || name === "write") {
        ops.push({ kind: "write", path });
      }
    }
  }
  return ops;
}

/**
 * Most recent files first. A file whose latest read is still in the retained
 * tail, with no later write there, is already in context and is skipped. A
 * file that was only written is read whole; a read keeps its range.
 */
export function restoreCandidates(
  summarized: readonly AgentMessage[],
  retainedTail: readonly AgentMessage[],
): RestoreCandidate[] {
  const inTail = new Set<string>();
  const tailOps = fileOps(retainedTail);
  tailOps.forEach((op, index) => {
    if (op.kind !== "read") return;
    const rewritten = tailOps.slice(index + 1).some((later) => later.kind === "write" && later.path === op.path);
    if (!rewritten) inTail.add(op.path);
  });
  const latest = new Map<string, RestoreCandidate>();
  for (const op of fileOps(summarized)) {
    latest.delete(op.path);
    latest.set(op.path, op.kind === "read"
      ? { path: op.path, ...(op.offset ? { offset: op.offset } : {}), ...(op.limit ? { limit: op.limit } : {}) }
      : { path: op.path });
  }
  return [...latest.values()].reverse().filter((candidate) => !inTail.has(candidate.path));
}

export function estimateRestoreTokens(files: readonly RestoredFile[]): number {
  return files.reduce((total, file) => total + Math.ceil((file.path.length + file.text.length + 80) / CHARS_PER_TOKEN), 0);
}

function clip(text: string, maxTokens: number): { text: string; truncated: boolean } {
  const maxChars = maxTokens * CHARS_PER_TOKEN;
  return text.length > maxChars
    ? { text: text.slice(0, maxChars), truncated: true }
    : { text, truncated: false };
}

export type RestoreRead = (candidate: RestoreCandidate, signal: AbortSignal) =>
  Promise<{ ok: true; text: string; truncated: boolean } | { ok: false; reason: string }>;

/**
 * Read candidates with bounded concurrency and one overall deadline. A read
 * that has not finished by the deadline or by Stop is abandoned (its signal
 * aborts); reads that already finished are kept.
 */
export async function readRestoreFiles(
  candidates: readonly RestoreCandidate[],
  read: RestoreRead,
  options: { signal?: AbortSignal; timeBudgetMs?: number; now?: () => Date } = {},
): Promise<{ files: RestoredFile[]; skipped: RestoreSkip[] }> {
  const picked = candidates.slice(0, RESTORE_MAX_FILES);
  const controller = new AbortController();
  const stop = () => controller.abort();
  if (options.signal?.aborted) stop();
  options.signal?.addEventListener("abort", stop, { once: true });
  const timer = setTimeout(stop, options.timeBudgetMs ?? RESTORE_TIME_BUDGET_MS);
  const results: Array<RestoredFile | RestoreSkip | undefined> = new Array(picked.length);
  let next = 0;
  const worker = async () => {
    while (!controller.signal.aborted && next < picked.length) {
      const index = next++;
      const candidate = picked[index]!;
      try {
        const outcome = await read(candidate, controller.signal);
        if (controller.signal.aborted) {
          results[index] = { path: candidate.path, reason: "cancelled" };
        } else if (outcome.ok) {
          const clipped = clip(outcome.text, RESTORE_FILE_MAX_TOKENS);
          results[index] = {
            ...candidate,
            readAt: (options.now?.() ?? new Date()).toISOString(),
            text: clipped.text,
            truncated: outcome.truncated || clipped.truncated,
          };
        } else {
          results[index] = { path: candidate.path, reason: outcome.reason };
        }
      } catch {
        results[index] = { path: candidate.path, reason: controller.signal.aborted ? "cancelled" : "read_failed" };
      }
    }
  };
  try {
    await Promise.all(Array.from({ length: Math.min(RESTORE_CONCURRENCY, picked.length) }, worker));
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", stop);
  }
  const files: RestoredFile[] = [];
  const skipped: RestoreSkip[] = [];
  picked.forEach((candidate, index) => {
    const result = results[index];
    if (!result) skipped.push({ path: candidate.path, reason: "cancelled" });
    else if ("text" in result) files.push(result);
    else skipped.push(result);
  });
  return { files, skipped };
}

/** Keep the most recent files that fit the token ceiling. */
export function fitRestoreBudget(files: readonly RestoredFile[], maxTokens: number): RestoredFile[] {
  const kept: RestoredFile[] = [];
  for (const file of files) {
    if (estimateRestoreTokens([...kept, file]) > Math.min(maxTokens, RESTORE_TOTAL_MAX_TOKENS)) continue;
    kept.push(file);
  }
  return kept;
}

export function restoredFilesFromDetails(details: unknown): RestoredFile[] {
  if (!details || typeof details !== "object") return [];
  const raw = (details as { restoredFiles?: unknown }).restoredFiles;
  if (!Array.isArray(raw)) return [];
  return raw.filter((file): file is RestoredFile =>
    !!file && typeof file === "object"
    && typeof (file as RestoredFile).path === "string"
    && typeof (file as RestoredFile).text === "string"
    && typeof (file as RestoredFile).readAt === "string");
}

/** Sent in the same user message as the summary; stored separately. */
export function formatRestoredFiles(files: readonly RestoredFile[]): string {
  const sections = files.map((file) => {
    const start = file.offset ?? 1;
    const lines = file.offset || file.limit
      ? ` lines="${start}-${file.limit ? start + file.limit - 1 : ""}"`
      : "";
    return `<restored-file path="${file.path}"${lines} read-at="${file.readAt}"${file.truncated ? ' truncated="true"' : ""}>\n${file.text}\n</restored-file>`;
  });
  return `These files were re-read when the context was compacted. They are snapshots from that moment and may differ from what was seen earlier or from the files now; read a file again before editing it if it may have changed.\n\n${sections.join("\n\n")}`;
}
