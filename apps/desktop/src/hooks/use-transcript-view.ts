import { useMemo } from "react";
import { EMPTY_TRANSCRIPT, transcriptViewMessages } from "../lib/transcript-reading";
import { useAppStore } from "../stores/app-store";

/** Main transcript and subagent details consume the same renderer reading range. */
export function useTranscriptView(sessionId: string) {
  const live = useAppStore((state) =>
    state.activeSessionId === sessionId
      ? state.messages
      : (state.retainedTranscripts[sessionId] ?? EMPTY_TRANSCRIPT),
  );
  const history = useAppStore((state) => state.sessionHistory[sessionId]);
  const view = useAppStore((state) => state.transcriptViews[sessionId]);
  const parents = history?.messageParents;
  const messages = useMemo(() => transcriptViewMessages(live, view, parents), [live, view, parents]);
  return {
    messages,
    hasMoreBefore: view?.hasMoreBefore ?? history?.hasMoreBefore ?? false,
    hasMoreAfter: view?.hasMoreAfter ?? false,
    focus: view?.focus ?? null,
    parentMessage: view?.parentMessage,
    historical: Boolean(view?.focus || view?.restored),
    // A restored range keeps reading ownership after joining live output.
    // Only the canonical tail can carry this session's running presentation.
    liveTail: !view?.focus && !view?.hasMoreAfter && messages.at(-1) === live.at(-1),
    loading: Boolean(view?.loading),
  };
}
