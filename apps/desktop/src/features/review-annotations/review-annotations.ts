import { create } from "zustand";
import { useAppStore } from "../../stores/app-store";
import {
  countReviewedFiles,
  executeBatchAnnotationSend,
  isReviewFileViewed,
  pruneAnnotationsForExistingSessions,
  pruneSentAnnotations,
  resolveDiffShiftRangeTarget,
  removeAnnotationItem,
  restoreSentAnnotations,
  reviewFileSignature,
  toggleReviewFileViewedMap,
  upsertAnnotationItem,
  type BatchAnnotationSendResult,
  type DiffAnnotation,
  type SentAnnotationSnapshot,
} from "./review-annotations-model";

export {
  annotationLineKey,
  countReviewedFiles,
  executeBatchAnnotationSend,
  formatDiffAnnotationsPrompt,
  isReviewFileViewed,
  pruneAnnotationsForExistingSessions,
  pruneSentAnnotations,
  resolveDiffShiftRangeTarget,
  resolveAnnotationRootIdentity,
  restoreSentAnnotations,
  reviewFileSignature,
  toggleReviewFileViewedMap,
  type BatchAnnotationSendResult,
  type DiffAnnotation,
  type SentAnnotationSnapshot,
} from "./review-annotations-model";

const REVIEWED_STORAGE_KEY = "mc.reviewedFiles";
const EMPTY_REVIEWED: Record<string, string> = {};

function readStoredReviewedFiles(): Record<string, Record<string, string>> {
  try {
    if (typeof sessionStorage === "undefined") return {};
    const parsed = JSON.parse(sessionStorage.getItem(REVIEWED_STORAGE_KEY) ?? "{}") as unknown;
    if (!parsed || typeof parsed !== "object") return {};
    const result: Record<string, Record<string, string>> = {};
    for (const [sessionId, rawMap] of Object.entries(parsed)) {
      if (!rawMap || typeof rawMap !== "object") continue;
      const clean = Object.fromEntries(
        Object.entries(rawMap).filter(
          (entry): entry is [string, string] => typeof entry[1] === "string" && entry[1].length > 0,
        ),
      );
      if (Object.keys(clean).length > 0) result[sessionId] = clean;
    }
    return result;
  } catch {
    return {};
  }
}

function writeStoredReviewedFiles(data: Record<string, Record<string, string>>): void {
  try {
    if (typeof sessionStorage === "undefined") return;
    sessionStorage.setItem(REVIEWED_STORAGE_KEY, JSON.stringify(data));
  } catch {
    // best-effort session persistence
  }
}

type ReviewAnnotationsState = {
  bySession: Record<string, DiffAnnotation[]>;
  sendingBySession: Record<string, boolean>;
  reviewedBySession: Record<string, Record<string, string>>;
  upsert: (
    input: Omit<DiffAnnotation, "id" | "createdAt"> & { id?: string; createdAt?: number },
  ) => void;
  remove: (sessionId: string, id: string) => void;
  pruneSent: (
    sessionId: string,
    sentBatch: readonly SentAnnotationSnapshot[],
  ) => void;
  restoreSent: (sessionId: string, sentBatch: readonly DiffAnnotation[]) => void;
  pruneSessions: (existingSessionIds: ReadonlySet<string>) => void;
  toggleFileReviewed: (sessionId: string, fileId: string, signature: string) => boolean;
  setSending: (sessionId: string, sending: boolean) => void;
  clear: (sessionId: string) => void;
};

const EMPTY: DiffAnnotation[] = [];

export const useReviewAnnotations = create<ReviewAnnotationsState>((set) => ({
  bySession: {},
  sendingBySession: {},
  reviewedBySession: readStoredReviewedFiles(),
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
      let reviewedChanged = false;
      const nextReviewed: Record<string, Record<string, string>> = {};
      for (const [id, map] of Object.entries(state.reviewedBySession)) {
        if (existingSessionIds.has(id)) {
          nextReviewed[id] = map;
        } else {
          reviewedChanged = true;
        }
      }
      if (reviewedChanged) writeStoredReviewedFiles(nextReviewed);
      if (pruned === state.bySession && !reviewedChanged) return state;
      return {
        ...(pruned === state.bySession ? {} : { bySession: pruned }),
        ...(reviewedChanged ? { reviewedBySession: nextReviewed } : {}),
      };
    }),
  toggleFileReviewed: (sessionId, fileId, signature) => {
    let outcome = false;
    set((state) => {
      const { next, viewed } = toggleReviewFileViewedMap(
        state.reviewedBySession[sessionId],
        fileId,
        signature,
      );
      outcome = viewed;
      let nextBySession: Record<string, Record<string, string>>;
      if (Object.keys(next).length === 0) {
        const { [sessionId]: _removed, ...rest } = state.reviewedBySession;
        nextBySession = rest;
      } else {
        nextBySession = { ...state.reviewedBySession, [sessionId]: next };
      }
      writeStoredReviewedFiles(nextBySession);
      return { reviewedBySession: nextBySession };
    });
    return outcome;
  },
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

export function useSessionReviewedFiles(
  sessionId?: string | null,
): Readonly<Record<string, string>> {
  return useReviewAnnotations((state) =>
    sessionId ? (state.reviewedBySession[sessionId] ?? EMPTY_REVIEWED) : EMPTY_REVIEWED,
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
