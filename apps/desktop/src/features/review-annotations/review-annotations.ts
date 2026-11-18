import { create } from "zustand";
import { useAppStore } from "../../stores/app-store";
import {
  executeBatchAnnotationSend,
  pruneAnnotationsForExistingSessions,
  pruneSentAnnotations,
  removeAnnotationItem,
  restoreSentAnnotations,
  upsertAnnotationItem,
  type BatchAnnotationSendResult,
  type DiffAnnotation,
} from "./review-annotations-model";

export {
  annotationLineKey,
  executeBatchAnnotationSend,
  formatDiffAnnotationsPrompt,
  pruneAnnotationsForExistingSessions,
  pruneSentAnnotations,
  resolveAnnotationRootIdentity,
  restoreSentAnnotations,
  type BatchAnnotationSendResult,
  type DiffAnnotation,
} from "./review-annotations-model";

type ReviewAnnotationsState = {
  bySession: Record<string, DiffAnnotation[]>;
  sendingBySession: Record<string, boolean>;
  upsert: (
    input: Omit<DiffAnnotation, "id" | "createdAt"> & { id?: string; createdAt?: number },
  ) => void;
  remove: (sessionId: string, id: string) => void;
  pruneSent: (
    sessionId: string,
    sentBatch: readonly Pick<DiffAnnotation, "id" | "lineKey" | "note">[],
  ) => void;
  restoreSent: (sessionId: string, sentBatch: readonly DiffAnnotation[]) => void;
  pruneSessions: (existingSessionIds: ReadonlySet<string>) => void;
  setSending: (sessionId: string, sending: boolean) => void;
  clear: (sessionId: string) => void;
};

const EMPTY: DiffAnnotation[] = [];

export const useReviewAnnotations = create<ReviewAnnotationsState>((set) => ({
  bySession: {},
  sendingBySession: {},
  upsert: (input) =>
    set((state) => ({
      bySession: {
        ...state.bySession,
        [input.sessionId]: upsertAnnotationItem(
          state.bySession[input.sessionId] ?? EMPTY,
          input,
        ),
      },
    })),
  remove: (sessionId, id) =>
    set((state) => {
      const remaining = removeAnnotationItem(state.bySession[sessionId] ?? EMPTY, id);
      if (remaining.length === 0) {
        if (!state.bySession[sessionId]) return state;
        const { [sessionId]: _removed, ...rest } = state.bySession;
        return { bySession: rest };
      }
      return {
        bySession: {
          ...state.bySession,
          [sessionId]: remaining,
        },
      };
    }),
  pruneSent: (sessionId, sentBatch) =>
    set((state) => {
      const current = state.bySession[sessionId];
      if (!current?.length) return state;
      const remaining = pruneSentAnnotations(current, sentBatch);
      if (remaining.length === 0) {
        const { [sessionId]: _removed, ...rest } = state.bySession;
        return { bySession: rest };
      }
      return {
        bySession: {
          ...state.bySession,
          [sessionId]: remaining,
        },
      };
    }),
  restoreSent: (sessionId, sentBatch) =>
    set((state) => {
      const current = state.bySession[sessionId] ?? EMPTY;
      const merged = restoreSentAnnotations(current, sentBatch);
      if (merged.length === current.length) return state;
      return {
        bySession: {
          ...state.bySession,
          [sessionId]: merged,
        },
      };
    }),
  pruneSessions: (existingSessionIds) =>
    set((state) => {
      const pruned = pruneAnnotationsForExistingSessions(
        state.bySession,
        existingSessionIds,
      );
      return pruned === state.bySession ? state : { bySession: pruned };
    }),
  setSending: (sessionId, sending) =>
    set((state) => {
      const current = Boolean(state.sendingBySession[sessionId]);
      if (current === sending) return state;
      if (!sending) {
        const { [sessionId]: _removed, ...rest } = state.sendingBySession;
        return { sendingBySession: rest };
      }
      return {
        sendingBySession: {
          ...state.sendingBySession,
          [sessionId]: true,
        },
      };
    }),
  clear: (sessionId) =>
    set((state) => {
      if (!state.bySession[sessionId]?.length) return state;
      const { [sessionId]: _removed, ...rest } = state.bySession;
      return { bySession: rest };
    }),
}));

export function useSessionDiffAnnotations(sessionId?: string | null): readonly DiffAnnotation[] {
  return useReviewAnnotations((state) =>
    sessionId ? (state.bySession[sessionId] ?? EMPTY) : EMPTY,
  );
}

export function isSessionAwaitingPlanApproval(
  state: Pick<
    ReturnType<typeof useAppStore.getState>,
    "pendingPlans" | "planCheckpoints" | "planningStates"
  >,
  sessionId?: string | null,
): boolean {
  if (!sessionId) return false;
  return (
    state.pendingPlans[sessionId]?.status === "pending" ||
    state.planCheckpoints[sessionId]?.status === "pending" ||
    state.planningStates[sessionId] === "awaiting_approval"
  );
}

/**
 * Send all pending diff annotations of `sessionId` captured at invocation time:
 * immediately when idle, or queued behind the active turn when running.
 * Per-session in-flight lock (`sendingBySession`) survives tab/session switches
 * so switching away and back cannot send the same batch twice.
 */
export async function sendBatchAnnotationsToSession(
  sessionId: string,
  intro: string,
): Promise<BatchAnnotationSendResult> {
  return executeBatchAnnotationSend({
    sessionId,
    intro,
    getSessionItems: (id) => useReviewAnnotations.getState().bySession[id] ?? EMPTY,
    pruneSent: (id, sentBatch) => useReviewAnnotations.getState().pruneSent(id, sentBatch),
    restoreSent: (id, sentBatch) => useReviewAnnotations.getState().restoreSent(id, sentBatch),
    isSending: (id) => Boolean(useReviewAnnotations.getState().sendingBySession[id]),
    setSending: (id, sending) => useReviewAnnotations.getState().setSending(id, sending),
    isPlanPending: (id) => isSessionAwaitingPlanApproval(useAppStore.getState(), id),
    isBusy: (id) => {
      const store = useAppStore.getState();
      return store.runningSessions[id] === true || (store.activeSessionId === id && store.isRunning);
    },
    sendPrompt: (prompt, id, onUndo) =>
      useAppStore
        .getState()
        .sendPrompt(prompt, { text: prompt, fileReferences: [], onSmartStopUndo: onUndo }, id),
    enqueuePrompt: (prompt, id, onUndo) =>
      useAppStore
        .getState()
        .enqueuePrompt(prompt, { text: prompt, fileReferences: [], onSmartStopUndo: onUndo }, id),
  });
}
