import { useEffect, useMemo, useState } from "react";
import type { SessionContextBreakdown } from "@pi-desktop/shared";
import { api } from "../../../lib/api";
import { useAppStore } from "../../../stores/app-store";
import { createContextSnapshotCache } from "./context-snapshot";

const readSnapshot = createContextSnapshotCache();

export function useSessionContextBreakdown(sessionId?: string | null) {
  const messageCount = useAppStore((s) => s.activeSessionId === sessionId
    ? s.messages.length : (sessionId ? s.retainedTranscripts[sessionId]?.length ?? 0 : 0));
  const running = useAppStore((s) => s.activeSessionId === sessionId
    ? s.isRunning : Boolean(sessionId && s.runningSessions[sessionId]));
  const compactions = useAppStore((s) => sessionId ? s.sessionCompactions[sessionId] : undefined);
  const providers = useAppStore((s) => s.providers);
  const models = useAppStore((s) => s.providerModels);
  const session = useAppStore((s) => s.sessions.find((candidate) => candidate.id === sessionId));
  const request = useMemo(() => ({ sessionId, keys: [messageCount, running, compactions, providers, models, session?.providerId, session?.modelId] }),
    [sessionId, messageCount, running, compactions, providers, models, session?.providerId, session?.modelId]);
  const [reply, setReply] = useState<{ request: typeof request; breakdown: SessionContextBreakdown | null } | null>(null);
  useEffect(() => {
    if (!request.sessionId) return;
    let canceled = false;
    void readSnapshot(request.sessionId, request.keys, async () => {
      const { breakdown } = await api.sessionContextBreakdown(request.sessionId!);
      return breakdown ?? null;
    }).then((breakdown) => {
      if (!canceled) setReply({ request, breakdown });
    }, () => {
      // Unknown capacity stays unavailable; never fabricate a full or empty window.
      if (!canceled) setReply({ request, breakdown: null });
    });
    return () => { canceled = true; };
  }, [request]);
  return reply?.request === request ? reply.breakdown : null;
}
