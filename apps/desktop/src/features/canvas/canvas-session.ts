import { create } from "zustand";
import { sessionCanvasGroupId, type ProjectGroupRecord } from "@pi-desktop/shared";
import { api } from "../../lib/api";
import type { ComposerDraftSnapshot } from "../../lib/composer-smart-stop";
import { normalizeProjectPath } from "../../lib/sidebar-session-groups";
import { useAppStore } from "../../stores/app-store";
import {
  addAttachment,
  attachmentsText,
  hasViewContext,
  makeNonce,
  viewContextText,
  type CanvasAttachment,
  type CanvasViewState,
} from "./canvas-model";

/*
  mc-agent prototype canvas (docs/mc-agent/prototype-canvas.md): what a
  conversation's Canvas tab hands to its messages. Per session: the view the
  user is looking at (sent with the next message unless dismissed) and the
  comments, notes and errors queued for it. The composer prepends both, fenced
  as data, when it sends.
*/

type SessionCanvas = {
  view: CanvasViewState | null;
  /** The view context was dismissed for this selection; a new one brings it back. */
  dismissed: string | null;
  attachments: CanvasAttachment[];
};

type CanvasSessionState = {
  sessions: Record<string, SessionCanvas>;
  setView: (sessionId: string, view: CanvasViewState | null) => void;
  dismissView: (sessionId: string) => void;
  attach: (sessionId: string, attachment: CanvasAttachment) => void;
  detach: (sessionId: string, key: string) => void;
  detachKeys: (sessionId: string, keys: ReadonlySet<string>) => void;
  clear: (sessionId: string) => void;
};

const EMPTY: SessionCanvas = { view: null, dismissed: null, attachments: [] };

/** What identifies a selection: dismissing it lasts until it changes. */
export function selectionKey(view: CanvasViewState | null): string | null {
  if (!view) return null;
  return JSON.stringify([
    view.canvasId,
    view.selected.map((node) => node.address),
    view.selectedBoards,
    view.whiteboardSelectedIds ?? [],
  ]);
}

export const useCanvasSession = create<CanvasSessionState>((set) => {
  const update = (sessionId: string, change: (current: SessionCanvas) => SessionCanvas) =>
    set((state) => ({ sessions: { ...state.sessions, [sessionId]: change(state.sessions[sessionId] ?? EMPTY) } }));
  return {
    sessions: {},
    setView: (sessionId, view) =>
      update(sessionId, (current) => ({
        ...current,
        view,
        dismissed: current.dismissed === selectionKey(view) ? current.dismissed : null,
      })),
    dismissView: (sessionId) => update(sessionId, (current) => ({ ...current, dismissed: selectionKey(current.view) })),
    attach: (sessionId, attachment) =>
      update(sessionId, (current) => ({ ...current, attachments: addAttachment(current.attachments, attachment) })),
    detach: (sessionId, key) =>
      update(sessionId, (current) => ({
        ...current,
        attachments: current.attachments.filter((item) => item.key !== key),
      })),
    detachKeys: (sessionId, keys) =>
      update(sessionId, (current) => ({
        ...current,
        attachments: current.attachments.filter((item) => !keys.has(item.key)),
      })),
    clear: (sessionId) => update(sessionId, (current) => ({ ...current, attachments: [] })),
  };
});

/** The view this session's next message carries, or null. */
export function sentView(entry: SessionCanvas | undefined): CanvasViewState | null {
  if (!entry || !hasViewContext(entry.view)) return null;
  return entry.dismissed === selectionKey(entry.view) ? null : entry.view;
}

export function defaultCanvasPromptForSession(
  sessionId: string | null | undefined,
  t: (key: string) => string,
): string | undefined {
  if (!sessionId) return undefined;
  const attachments = useCanvasSession.getState().sessions[sessionId]?.attachments ?? [];
  if (!attachments.length) return undefined;
  return attachments.some((item) => item.kind === "whiteboard")
    ? t("mcProject.canvasHandleWhiteboard")
    : t("mcProject.canvasHandleThread");
}

/**
 * Non-destructively prepare a message with the session's canvas context and
 * merge any attached whiteboard snapshot images into `draft.fileReferences`.
 * Call `commit()` ONLY after `sendPrompt` / `steerPrompt` succeeds so a rejected
 * or failed submission never loses the user's queued canvas chips, and any chip
 * attached while the send was in flight stays intact.
 */
export function prepareCanvasSubmission(
  sessionId: string | undefined,
  content: string,
  draft?: ComposerDraftSnapshot,
  fallbackPrompt?: string,
): {
  content: string;
  draft?: ComposerDraftSnapshot;
  commit: (resolvedSessionId?: string) => void;
} {
  const noop = () => undefined;
  if (!sessionId) return { content, draft, commit: noop };
  const entry = useCanvasSession.getState().sessions[sessionId];
  const view = sentView(entry);
  const attachments = entry?.attachments ?? [];
  if (!view && !attachments.length) return { content, draft, commit: noop };
  const body = content.trim() ? content : attachments.length && fallbackPrompt ? fallbackPrompt : content;
  const imageFiles = attachments.flatMap((item) =>
    item.kind === "whiteboard" && item.imageFile ? [item.imageFile] : [],
  );
  const nonce = makeNonce();
  const blocks = [view ? viewContextText(view, nonce) : "", attachmentsText(attachments, nonce)].filter(Boolean);
  const spentKeys = new Set(attachments.map((item) => item.key));
  let committed = false;
  const commit = (resolvedSessionId?: string) => {
    if (committed || !spentKeys.size) return;
    committed = true;
    useCanvasSession.getState().detachKeys(sessionId, spentKeys);
    if (resolvedSessionId && resolvedSessionId !== sessionId) {
      useCanvasSession.getState().detachKeys(resolvedSessionId, spentKeys);
    }
  };
  const nextDraft: ComposerDraftSnapshot | undefined = imageFiles.length
    ? {
        text: draft?.text ?? body,
        fileReferences: [...(draft?.fileReferences ?? []), ...imageFiles],
        ...(draft?.onSmartStopUndo ? { onSmartStopUndo: draft.onSmartStopUndo } : {}),
      }
    : draft;
  return {
    content: body ? `${blocks.join("\n\n")}\n\n${body}` : blocks.join("\n\n"),
    draft: nextDraft,
    commit,
  };
}

/**
 * Prepend the session's canvas context to a message, merge any attached
 * whiteboard snapshot images into `draft.fileReferences` without clobbering
 * the user's draft text/attachments, and spend its queued attachments.
 */
export function consumeCanvasSubmission(
  sessionId: string | undefined,
  content: string,
  draft?: ComposerDraftSnapshot,
): { content: string; draft?: ComposerDraftSnapshot } {
  const prepared = prepareCanvasSubmission(sessionId, content, draft);
  prepared.commit();
  return { content: prepared.content, draft: prepared.draft };
}

export function withCanvasContext(sessionId: string | undefined, content: string): string {
  return consumeCanvasSubmission(sessionId, content).content;
}

/**
 * Send canvas data to a conversation now: as its next message, or after the
 * turn it is running. The text is what the user would have typed.
 */
export async function sendToSession(sessionId: string, attachment: CanvasAttachment, text: string): Promise<boolean> {
  const store = useAppStore.getState();
  const content = `${attachmentsText([attachment], makeNonce())}\n\n${text}`;
  const draft: ComposerDraftSnapshot | undefined =
    attachment.kind === "whiteboard" && attachment.imageFile
      ? { text, fileReferences: [attachment.imageFile] }
      : undefined;
  return store.runningSessions[sessionId]
    ? store.enqueuePrompt(content, draft, sessionId)
    : store.sendPrompt(content, draft, sessionId);
}

/** The project a conversation's folder belongs to, a folder-only one included. */
export async function projectGroupForPath(projectPath: string | undefined): Promise<ProjectGroupRecord | null> {
  const wanted = normalizeProjectPath(projectPath);
  if (!wanted) return null;
  const { groups } = await api.listProjectGroups();
  return groups.find((group) => group.roots.some((root) => normalizeProjectPath(root.path) === wanted)) ?? null;
}

/** Resolve the canvas storage scope for a local conversation: its project group, else `session:<id>`. */
export async function canvasGroupIdForSession(
  sessionId: string | null | undefined,
  projectPath: string | undefined,
): Promise<string | null> {
  if (!sessionId) return null;
  const group = await projectGroupForPath(projectPath);
  return group ? group.id : sessionCanvasGroupId(sessionId);
}
