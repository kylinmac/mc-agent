import { messageHasTranscriptContent } from "../../lib/chat-launch-error";
import { headAsk } from "../../lib/pending-asks";
import { headPermission } from "../../lib/pending-permissions";
import type { AppState } from "../../stores/app-state";
import { hasSessionConversationStarted } from "./session-info-model";

export function isStoreSessionConversationStarted(
  s: Pick<
    AppState,
    | "activeSessionId"
    | "isRunning"
    | "runningSessions"
    | "messages"
    | "retainedTranscripts"
    | "sessionHistory"
    | "retainedSessionIds"
    | "sessions"
    | "pendingPermissions"
    | "pendingAsks"
    | "sessionCompactions"
  >,
  targetSessionId?: string | null,
): boolean {
  if (!targetSessionId) return false;
  const running =
    s.activeSessionId === targetSessionId ? s.isRunning : Boolean(s.runningSessions?.[targetSessionId]);
  if (running) return true;
  const list =
    s.activeSessionId === targetSessionId ? s.messages : s.retainedTranscripts?.[targetSessionId];
  const hasTranscriptMessages = Boolean(
    list?.some((m) => messageHasTranscriptContent(m) || (m.attachments?.length ?? 0) > 0),
  );
  const transcriptLoaded =
    s.activeSessionId === targetSessionId
      ? Boolean(
          list &&
            (list.length > 0 ||
              s.sessionHistory?.[targetSessionId] !== undefined ||
              (s.retainedSessionIds ?? []).includes(targetSessionId)),
        )
      : list !== undefined || s.sessionHistory?.[targetSessionId] !== undefined;
  return hasSessionConversationStarted({
    sessionId: targetSessionId,
    isRunning: false,
    hasTranscriptMessages,
    transcriptLoaded,
    summaryMessageCount: s.sessions.find((candidate) => candidate.id === targetSessionId)?.messageCount,
    hasPendingInteraction: Boolean(
      headPermission(s.pendingPermissions ?? [], targetSessionId) ||
        headAsk(s.pendingAsks ?? [], targetSessionId),
    ),
    compactionCount: s.sessionCompactions?.[targetSessionId]?.length ?? 0,
    messageParentCount: s.sessionHistory?.[targetSessionId]?.messageParents?.length ?? 0,
  });
}
