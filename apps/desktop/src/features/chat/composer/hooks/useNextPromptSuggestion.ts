import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../../../../lib/api";

/*
  mc-agent: the next-message suggestion shown as gray text in the empty
  composer. It is asked for once, when a reply in this session finishes, and
  only while the setting is on and the draft is empty. A new run, a session
  switch or any typing drops it; Tab accepts it into the draft.
*/

export type SuggestionWatch = { sessionId: string | null; running: boolean };

/** True when this change is a reply in the same session finishing. */
export function replyFinished(previous: SuggestionWatch, next: SuggestionWatch): boolean {
  return Boolean(
    next.sessionId &&
      previous.sessionId === next.sessionId &&
      previous.running &&
      !next.running,
  );
}

/** Remote and imported pi sessions have no local runtime to ask. */
export function suggestsFor(sessionId: string | null): boolean {
  return Boolean(sessionId && !sessionId.startsWith("remote:") && !sessionId.startsWith("native-pi:"));
}

export function useNextPromptSuggestion({
  sessionId,
  running,
  enabled,
  draftEmpty,
}: {
  sessionId: string | null;
  running: boolean;
  enabled: boolean;
  /** Read when the reply finishes: a draft already started gets no suggestion. */
  draftEmpty: () => boolean;
}): { text: string | null; dismiss: () => void } {
  const [suggestion, setSuggestion] = useState<{ sessionId: string; text: string } | null>(null);
  const previous = useRef<SuggestionWatch>({ sessionId, running });
  const request = useRef(0);
  const draftEmptyRef = useRef(draftEmpty);
  draftEmptyRef.current = draftEmpty;

  useEffect(() => {
    const next = { sessionId, running };
    const finished = replyFinished(previous.current, next);
    previous.current = next;
    // Anything but a finished reply invalidates what was shown or asked for.
    request.current += 1;
    setSuggestion(null);
    if (!finished || !enabled || !suggestsFor(sessionId) || !draftEmptyRef.current()) return;
    const ticket = request.current;
    const target = sessionId!;
    void api.sessionSuggestPrompt(target).then(
      ({ text }) => {
        if (ticket === request.current && text) setSuggestion({ sessionId: target, text });
      },
      () => undefined,
    );
  }, [sessionId, running, enabled]);

  const dismiss = useCallback(() => {
    request.current += 1;
    setSuggestion(null);
  }, []);

  return {
    text: suggestion && suggestion.sessionId === sessionId ? suggestion.text : null,
    dismiss,
  };
}
