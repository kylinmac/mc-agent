/*
  mc-agent diff annotations model (MC-ADR-0029 / R37): pure helpers for
  pinning line-level review notes to AI-generated diffs and formatting them
  into a single batch revision prompt. Zero store/DOM imports for `node --test`.
*/

export type DiffAnnotation = {
  id: string;
  lineKey: string;
  sessionId: string;
  snapshotId: string;
  path: string;
  /** Execution worktree root when resolved by review history or tool details. */
  root?: string;
  /** Provenance key matching `groupReviewFiles` (`root`, `unknown:<callId>`, or `"workspace"`). */
  rootIdentity?: string;
  side: "old" | "new";
  line: number | null;
  lineType: "add" | "del" | "context";
  code: string;
  note: string;
  createdAt: number;
};

/**
 * Anchor an annotation to its immutable file coordinate `(snapshotId, side, lineNumber)`
 * so switching Diff context lines (1 / 3 / 10 / full) never shifts keys onto
 * neighbouring lines. Falls back to raw hunk/line indices only when a hunk lacks
 * numeric coordinates (`lineNumber === null`).
 */
export function annotationLineKey(
  snapshotId: string,
  side: "old" | "new",
  lineNumber: number | null,
  fallbackHunkIndex = 0,
  fallbackLineIndex = 0,
): string {
  return lineNumber !== null
    ? `${snapshotId}:${side}:${lineNumber}`
    : `${snapshotId}:raw:${fallbackHunkIndex}:${fallbackLineIndex}`;
}

export function resolveAnnotationRootIdentity(
  root?: string | null,
  parentToolCallId?: string | null,
): string {
  const cleanRoot = root?.trim();
  if (cleanRoot) return cleanRoot;
  if (parentToolCallId?.trim()) return `unknown:${parentToolCallId.trim()}`;
  return "workspace";
}

export function upsertAnnotationItem(
  list: readonly DiffAnnotation[],
  item: Omit<DiffAnnotation, "id" | "createdAt"> & { id?: string; createdAt?: number },
): DiffAnnotation[] {
  const trimmed = item.note.trim();
  if (!trimmed) return [...list];
  const existingIndex = list.findIndex(
    (entry) => (item.id && entry.id === item.id) || entry.lineKey === item.lineKey,
  );
  if (existingIndex >= 0) {
    const current = list[existingIndex]!;
    const updated: DiffAnnotation = {
      ...current,
      ...item,
      id: current.id,
      createdAt: current.createdAt,
      note: trimmed,
    };
    return list.map((entry, idx) => (idx === existingIndex ? updated : entry));
  }
  const created: DiffAnnotation = {
    ...item,
    id: item.id ?? `${item.lineKey}:${Date.now()}:${list.length}`,
    createdAt: item.createdAt ?? Date.now(),
    note: trimmed,
  };
  return [...list, created];
}

export function removeAnnotationItem(
  list: readonly DiffAnnotation[],
  id: string,
): DiffAnnotation[] {
  return list.filter((entry) => entry.id !== id);
}

/**
 * Remove only annotations that were part of `sentBatch` AND whose `note` and
 * `lineKey` remained unchanged while the async send was in flight. Any note
 * added or edited during send stays queued for the next batch.
 */
export function pruneSentAnnotations(
  current: readonly DiffAnnotation[],
  sentBatch: readonly Pick<DiffAnnotation, "id" | "lineKey" | "note">[],
): DiffAnnotation[] {
  const sentById = new Map(sentBatch.map((item) => [item.id, item]));
  return current.filter((entry) => {
    const sent = sentById.get(entry.id);
    if (!sent) return true;
    return sent.note !== entry.note || sent.lineKey !== entry.lineKey;
  });
}

/**
 * Restore a sent batch when smart-stop retracts the prompt before any assistant
 * output, without overwriting annotations added or edited after capture.
 */
export function restoreSentAnnotations(
  current: readonly DiffAnnotation[],
  sentBatch: readonly DiffAnnotation[],
): DiffAnnotation[] {
  if (sentBatch.length === 0) return [...current];
  const existingIds = new Set(current.map((entry) => entry.id));
  const existingLineKeys = new Set(current.map((entry) => entry.lineKey));
  const restored: DiffAnnotation[] = [];
  for (const item of sentBatch) {
    if (existingIds.has(item.id) || existingLineKeys.has(item.lineKey)) continue;
    existingIds.add(item.id);
    existingLineKeys.add(item.lineKey);
    restored.push(item);
  }
  return restored.length === 0 ? [...current] : [...restored, ...current];
}

/**
 * Drop cached annotation buckets for sessions that have been deleted.
 */
export function pruneAnnotationsForExistingSessions(
  bySession: Readonly<Record<string, DiffAnnotation[]>>,
  existingSessionIds: ReadonlySet<string>,
): Record<string, DiffAnnotation[]> {
  let changed = false;
  const next: Record<string, DiffAnnotation[]> = {};
  for (const [id, list] of Object.entries(bySession)) {
    if (existingSessionIds.has(id)) {
      next[id] = list;
    } else {
      changed = true;
    }
  }
  return changed ? next : (bySession as Record<string, DiffAnnotation[]>);
}

function inlineMarkdownCode(raw: string): string {
  const singleLine = raw.replace(/\r?\n/g, " ");
  let maxRun = 0;
  for (const match of singleLine.matchAll(/`+/g)) {
    if (match[0].length > maxRun) maxRun = match[0].length;
  }
  const fence = "`".repeat(maxRun + 1);
  const needsPad =
    singleLine.startsWith("`") ||
    singleLine.endsWith("`") ||
    (singleLine.startsWith(" ") && singleLine.endsWith(" ") && singleLine.trim().length > 0);
  return needsPad ? `${fence} ${singleLine} ${fence}` : `${fence}${singleLine}${fence}`;
}

function formatNoteBody(note: string): string {
  const lines = note.trim().split(/\r?\n/);
  if (lines.length <= 1) return lines[0] ?? "";
  return lines.map((line, index) => (index === 0 ? line : `  ${line}`)).join("\n");
}

function formatWorktreeHeading(
  filePath: string,
  root: string | undefined,
  identity: string,
  hasSamePathCollision: boolean,
): string {
  const trimmedRoot = root?.trim();
  const pathSpan = inlineMarkdownCode(filePath);
  if (trimmedRoot) {
    return `### ${pathSpan} (${inlineMarkdownCode(trimmedRoot)})`;
  }
  if (identity.startsWith("unknown:")) {
    return `### ${pathSpan} (${inlineMarkdownCode(`delegated:${identity.slice("unknown:".length)}`)})`;
  }
  if (hasSamePathCollision || identity !== "workspace") {
    return `### ${pathSpan} (${inlineMarkdownCode(identity)})`;
  }
  return `### ${pathSpan}`;
}

/**
 * Format all pending line-anchored review notes of a session into a single
 * structured revision prompt, grouped by `(rootIdentity, path)` (matching
 * `groupReviewFiles` in `review-history.ts`) and ordered by line number.
 */
export function formatDiffAnnotationsPrompt(
  intro: string,
  items: readonly DiffAnnotation[],
): string {
  if (items.length === 0) return "";
  type FileGroup = {
    filePath: string;
    root?: string;
    identity: string;
    entries: DiffAnnotation[];
  };

  const groups = new Map<string, FileGroup>();
  for (const item of items) {
    const filePath = item.path || "(unknown)";
    const identity = item.rootIdentity?.trim() || item.root?.trim() || "workspace";
    const groupKey = JSON.stringify([identity, filePath]);
    const existing = groups.get(groupKey);
    if (existing) {
      if (!existing.root && item.root?.trim()) existing.root = item.root.trim();
      existing.entries.push(item);
    } else {
      groups.set(groupKey, {
        filePath,
        root: item.root?.trim() || undefined,
        identity,
        entries: [item],
      });
    }
  }

  const pathCounts = new Map<string, number>();
  for (const group of groups.values()) {
    pathCounts.set(group.filePath, (pathCounts.get(group.filePath) ?? 0) + 1);
  }

  const sections: string[] = [intro.trim()];
  for (const group of groups.values()) {
    const sorted = [...group.entries].sort((a, b) => (a.line ?? 0) - (b.line ?? 0));
    const hasCollision = (pathCounts.get(group.filePath) ?? 0) > 1;
    const lines: string[] = [
      formatWorktreeHeading(group.filePath, group.root, group.identity, hasCollision),
    ];
    for (const entry of sorted) {
      const prefix = entry.lineType === "add" ? "+" : entry.lineType === "del" ? "-" : " ";
      const loc =
        entry.line !== null
          ? entry.side === "old"
            ? `old L${entry.line}`
            : `L${entry.line}`
          : "diff line";
      const snippet = entry.code.trim();
      const noteText = formatNoteBody(entry.note);
      lines.push(
        snippet
          ? `- **${loc}** (${inlineMarkdownCode(`${prefix}${snippet.slice(0, 140)}`)}): ${noteText}`
          : `- **${loc}**: ${noteText}`,
      );
    }
    sections.push(lines.join("\n"));
  }

  return sections.join("\n\n");
}

export type BatchAnnotationSendResult = {
  sent: boolean;
  count: number;
  queued: boolean;
  blockedReason?: "sending" | "plan_pending";
};

export async function executeBatchAnnotationSend(params: {
  sessionId: string;
  intro: string;
  getSessionItems: (sessionId: string) => readonly DiffAnnotation[];
  pruneSent: (
    sessionId: string,
    sentBatch: readonly Pick<DiffAnnotation, "id" | "lineKey" | "note">[],
  ) => void;
  restoreSent?: (sessionId: string, sentBatch: readonly DiffAnnotation[]) => void;
  isBusy: (sessionId: string) => boolean;
  isSending?: (sessionId: string) => boolean;
  setSending?: (sessionId: string, sending: boolean) => void;
  isPlanPending?: (sessionId: string) => boolean;
  sendPrompt: (prompt: string, sessionId: string, onUndo: () => void) => Promise<boolean>;
  enqueuePrompt: (prompt: string, sessionId: string, onUndo: () => void) => Promise<boolean>;
}): Promise<BatchAnnotationSendResult> {
  const {
    sessionId,
    intro,
    getSessionItems,
    pruneSent,
    restoreSent,
    isBusy,
    isSending,
    setSending,
    isPlanPending,
    sendPrompt,
    enqueuePrompt,
  } = params;
  if (isSending?.(sessionId)) {
    return { sent: false, count: 0, queued: false, blockedReason: "sending" };
  }
  const snapshot = [...getSessionItems(sessionId)];
  if (snapshot.length === 0) return { sent: false, count: 0, queued: false };
  if (isPlanPending?.(sessionId)) {
    return {
      sent: false,
      count: snapshot.length,
      queued: false,
      blockedReason: "plan_pending",
    };
  }
  const prompt = formatDiffAnnotationsPrompt(intro, snapshot);
  const busy = isBusy(sessionId);
  const onUndo = () => restoreSent?.(sessionId, snapshot);
  setSending?.(sessionId, true);
  try {
    let ok = false;
    try {
      ok = busy
        ? await enqueuePrompt(prompt, sessionId, onUndo)
        : await sendPrompt(prompt, sessionId, onUndo);
    } catch {
      ok = false;
    }
    if (!ok) return { sent: false, count: snapshot.length, queued: busy };
    pruneSent(sessionId, snapshot);
    return { sent: true, count: snapshot.length, queued: busy };
  } finally {
    setSending?.(sessionId, false);
  }
}
