import type { SessionDetail, UiMessage } from "@pi-desktop/shared";
import { dedupeSessionMessages, mergeLiveSessionMessages, upsertLiveSessionMessage } from "./session-transcript";
import {
  getSessionMessageSnapshot,
  registerSessionMessageReplacement,
  registerSessionMessageReplacements,
  type SessionMessageSnapshot,
} from "./session-transcript-updates";

export type TranscriptSearchTarget = {
  sessionId: string;
  messageId: string;
  query: string;
  requestId: number;
};

/** One renderer reading range, shared by ordinary history and search navigation. */
export type TranscriptView = {
  messages: UiMessage[];
  messageStart: number;
  messageEnd?: number;
  hasMoreBefore: boolean;
  hasMoreAfter: boolean;
  parentMessage?: UiMessage;
  messageParents?: UiMessage[];
  focus: TranscriptSearchTarget | null;
  /** A bookmarked historical range, without search navigation/highlighting. */
  restored?: boolean;
  loading: "target" | "before" | "after" | null;
};

export const EMPTY_TRANSCRIPT: UiMessage[] = [];
export const TRANSCRIPT_PAGE_SIZE = 100;
export const TRANSCRIPT_SEARCH_PAGE_SIZE = 60;
export const TRANSCRIPT_CONTENT_LIMIT = 64 * 1024;

export function transcriptViewFromSession(
  session: SessionDetail,
  focus: TranscriptSearchTarget | null = null,
): TranscriptView {
  return {
    messages: session.messages,
    messageStart: session.messageStart ?? 0,
    messageEnd: session.messageEnd,
    hasMoreBefore: session.hasMoreBefore === true,
    hasMoreAfter: session.hasMoreAfter === true,
    parentMessage: session.navigationParent,
    messageParents: session.messageParents,
    focus,
    loading: null,
  };
}

type ReadingProjection = {
  source: SessionMessageSnapshot;
  messages: UiMessage[];
};

// One current projection per reading view/live owner, not a linked generation
// history. Replacing/evicting a view releases its cache. A new live owner or
// structural edit takes the full merge path; skipped renders compare blocks.
const readingProjections = new WeakMap<TranscriptView, WeakMap<object, ReadingProjection>>();

function withNavigationParent(messages: UiMessage[], parent?: UiMessage): UiMessage[] {
  if (!parent) return messages;
  const snapshot = getSessionMessageSnapshot(messages);
  const index = snapshot.positions.get(parent.id);
  if (index === undefined) return [parent, ...messages];
  if (messages[index] === parent) return messages;
  // A neighboring page may contain an earlier physical copy of the Task.
  if (!snapshot.unique) return messages.map((message) => message.id === parent.id ? parent : message);
  const next = messages.slice();
  next[index] = parent;
  return registerSessionMessageReplacement(messages, next, index);
}

function withMessageParents(messages: UiMessage[], parents?: UiMessage[], live = messages): UiMessage[] {
  if (!parents?.length) return messages;
  const positions = getSessionMessageSnapshot(messages).positions;
  const livePositions = getSessionMessageSnapshot(live).positions;
  const missing: UiMessage[] = [];
  let next = messages;
  for (const parent of dedupeSessionMessages(parents)) {
    const index = positions.get(parent.id);
    if (index === undefined) missing.push(parent);
    else if (!livePositions.has(parent.id) && messages[index] !== parent) {
      if (next === messages) next = messages.slice();
      next[index] = parent;
    }
  }
  return missing.length ? [...missing, ...next] : next;
}

function replaceReadingOverlap(
  cached: ReadingProjection,
  source: SessionMessageSnapshot,
  parent?: UiMessage,
): UiMessage[] | undefined {
  if (!source.unique || source.positions !== cached.source.positions) return undefined;
  if (source === cached.source) return cached.messages;
  const output = getSessionMessageSnapshot(cached.messages);
  let next: UiMessage[] | undefined;
  const changed: number[] = [];
  for (let blockIndex = 0; blockIndex < source.blocks.length; blockIndex++) {
    const block = source.blocks[blockIndex];
    const previous = cached.source.blocks[blockIndex];
    if (block === previous) continue;
    for (let index = 0; index < block.length; index++) {
      const message = block[index];
      if (message === previous[index]) continue;
      // Timestamp corrections can move live-only rows across the durable
      // window. Content/status/role updates cannot change that merge ordering.
      if (message.createdAt !== previous[index].createdAt) return undefined;
      if (parent && message.id === parent.id) continue;
      const position = output.positions.get(message.id);
      if (position === undefined) return undefined;
      if (cached.messages[position] === message) continue;
      next ??= cached.messages.slice();
      next[position] = message;
      changed.push(position);
    }
  }
  return next ? registerSessionMessageReplacements(cached.messages, next, changed) : cached.messages;
}

/** Live output remains authoritative outside an explicit historical search. */
export function transcriptViewMessages(live: UiMessage[], view?: TranscriptView, messageParents?: UiMessage[]): UiMessage[] {
  if (!view) return withMessageParents(live, messageParents);
  // Search holds its selected snapshot. Restoration only stays isolated while
  // unread physical pages separate it from the live tail.
  if (view.focus || (view.restored && view.hasMoreAfter))
    return withMessageParents(withNavigationParent(view.messages, view.parentMessage), view.messageParents);

  const normalized = dedupeSessionMessages(live);
  const source = getSessionMessageSnapshot(normalized);
  let projections = readingProjections.get(view);
  if (!projections) {
    projections = new WeakMap();
    readingProjections.set(view, projections);
  }
  const cached = projections.get(source.owner);
  let messages = cached && replaceReadingOverlap(cached, source, view.parentMessage);
  if (!messages) {
    // The live cache can start before a short restored range. Joining at the
    // first overlapping identity avoids prepending rows and moving the anchor;
    // without overlap, do not invent continuity across an unknown gap.
    const restoredStart = view.restored
      ? normalized.findIndex((message) => getSessionMessageSnapshot(view.messages).positions.has(message.id))
      : 0;
    const liveTail = restoredStart < 0 ? EMPTY_TRANSCRIPT : normalized.slice(restoredStart);
    messages = withNavigationParent(
      mergeLiveSessionMessages(view.messages, liveTail).map((message) => {
        // A stale reading snapshot must not outrank the canonical row, even
        // when a previously streaming row has just completed.
        const index = source.positions.get(message.id);
        return index === undefined ? message : normalized[index];
      }),
      view.parentMessage,
    );
    getSessionMessageSnapshot(messages);
  }
  projections.set(source.owner, { source, messages });
  return withMessageParents(messages, [...view.messageParents ?? [], ...messageParents ?? []], normalized);
}

export function extendTranscriptView(
  view: TranscriptView,
  session: SessionDetail,
  direction: "before" | "after",
): TranscriptView {
  const merged = dedupeSessionMessages(
    direction === "before"
      ? [...session.messages, ...view.messages]
      : [...view.messages, ...session.messages],
  );
  const focused = view.messages.find((message) => message.id === view.focus?.messageId);
  const messages = focused ? upsertLiveSessionMessage(merged, focused) : merged;
  return {
    ...view,
    messages,
    messageParents: dedupeSessionMessages([...view.messageParents ?? [], ...session.messageParents ?? []]),
    messageStart: Math.min(view.messageStart, session.messageStart ?? 0),
    messageEnd: Math.max(view.messageEnd ?? 0, session.messageEnd ?? 0),
    hasMoreBefore: direction === "before" ? session.hasMoreBefore === true : view.hasMoreBefore,
    hasMoreAfter: direction === "after" ? session.hasMoreAfter === true : view.hasMoreAfter,
    loading: null,
  };
}

/** Hydrating or appending is safe; a canonical rewrite invalidates older snapshots. */
export function transcriptWasRewritten(previous: UiMessage[], next: UiMessage[]): boolean {
  const current = new Map(next.map((message) => [message.id, message]));
  return previous.some((message) => {
    const replacement = current.get(message.id);
    return (
      !replacement ||
      replacement.content !== message.content ||
      replacement.activeRevision !== message.activeRevision
    );
  });
}
