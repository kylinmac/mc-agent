import { useEffect } from "react";
import { api } from "./api";
import { holdSession } from "./session-holds";
import { useAppStore } from "../stores/app-store";

/**
 * A held session that is not active reads its retained pane. Paths that leave
 * a project drop every retained pane (upstream), so a held session from
 * another project can lose its transcript; this loads it back.
 */
export function useHeldTranscript(id: string, focused: boolean): void {
  const missing = useAppStore((state) => Boolean(id) && !focused && !state.retainedTranscripts[id]);
  useEffect(() => {
    if (!missing) return;
    let canceled = false;
    void api.getSession(id, { messageLimit: 100, contentLimit: 64 * 1024 }).then(
      (detail) => {
        if (canceled || !detail.session) return;
        const messages = detail.session.messages ?? [];
        useAppStore.setState((state) =>
          state.activeSessionId === id || state.retainedTranscripts[id]
            ? {}
            : {
                retainedSessionIds: state.retainedSessionIds.includes(id)
                  ? state.retainedSessionIds
                  : [...state.retainedSessionIds, id],
                retainedTranscripts: { ...state.retainedTranscripts, [id]: messages },
                sessionHistory: state.sessionHistory[id]
                  ? state.sessionHistory
                  : {
                      ...state.sessionHistory,
                      [id]: {
                        messageStart: detail.session?.messageStart ?? 0,
                        hasMoreBefore: detail.session?.hasMoreBefore === true,
                      },
                    },
              },
        );
      },
      () => undefined,
    );
    return () => {
      canceled = true;
    };
  }, [id, missing]);
}

/** Hold `sessionId` while mounted and keep its transcript loaded. */
export function useHeldSession(sessionId: string | null | undefined): void {
  useEffect(() => (sessionId ? holdSession(sessionId) : undefined), [sessionId]);
  useHeldTranscript(sessionId ?? "", false);
}
