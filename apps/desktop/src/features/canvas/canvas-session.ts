import { create } from "zustand";
import type { ProjectGroupRecord } from "@pi-desktop/shared";
import { api } from "../../lib/api";
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
  clear: (sessionId: string) => void;
};

const EMPTY: SessionCanvas = { view: null, dismissed: null, attachments: [] };

/** What identifies a selection: dismissing it lasts until it changes. */
export function selectionKey(view: CanvasViewState | null): string | null {
  if (!view) return null;
  return JSON.stringify([view.canvasId, view.selected.map((node) => node.address), view.selectedBoards]);
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
    clear: (sessionId) => update(sessionId, (current) => ({ ...current, attachments: [] })),
  };
});

/** The view this session's next message carries, or null. */
export function sentView(entry: SessionCanvas | undefined): CanvasViewState | null {
  if (!entry || !hasViewContext(entry.view)) return null;
  return entry.dismissed === selectionKey(entry.view) ? null : entry.view;
}

/**
 * Prepend the session's canvas context to a message and spend its queued
 * attachments. A message with nothing from the canvas goes out unchanged.
 */
export function withCanvasContext(sessionId: string | undefined, content: string): string {
  if (!sessionId) return content;
  const entry = useCanvasSession.getState().sessions[sessionId];
  const view = sentView(entry);
  const attachments = entry?.attachments ?? [];
  if (!view && !attachments.length) return content;
  const nonce = makeNonce();
  const blocks = [view ? viewContextText(view, nonce) : "", attachmentsText(attachments, nonce)].filter(Boolean);
  useCanvasSession.getState().clear(sessionId);
  return `${blocks.join("\n\n")}\n\n${content}`;
}

/**
 * Send canvas data to a conversation now: as its next message, or after the
 * turn it is running. The text is what the user would have typed.
 */
export async function sendToSession(sessionId: string, attachment: CanvasAttachment, text: string): Promise<boolean> {
  const store = useAppStore.getState();
  const content = `${attachmentsText([attachment], makeNonce())}\n\n${text}`;
  return store.runningSessions[sessionId]
    ? store.enqueuePrompt(content, undefined, sessionId)
    : store.sendPrompt(content, undefined, sessionId);
}

/** The project a conversation's folder belongs to, a folder-only one included. */
export async function projectGroupForPath(projectPath: string | undefined): Promise<ProjectGroupRecord | null> {
  const wanted = normalizeProjectPath(projectPath);
  if (!wanted) return null;
  const { groups } = await api.listProjectGroups();
  return groups.find((group) => group.roots.some((root) => normalizeProjectPath(root.path) === wanted)) ?? null;
}
