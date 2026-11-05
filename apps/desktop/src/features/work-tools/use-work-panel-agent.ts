import { useEffect } from "react";
import { IPC, type AgentPanelRequest, type AgentPanelSnapshot } from "@pi-desktop/shared";
import { useAppStore } from "../../stores/app-store";
import { currentWorkPanelContext } from "../../stores/slices/work-panel-slice";
import { isRemoteSession } from "../../lib/remote-session-safety";
import { buildSubagentTranscript } from "../../lib/subagent-transcript";
import { transcriptViewMessages } from "../../lib/transcript-reading";
import { readTerminalScreen, restartExitedTerminal } from "./TerminalTab";

export function useWorkPanelAgent() {
  useEffect(() => {
    const desktop = window.piDesktop;
    if (!desktop) return;
    return desktop.on(IPC.event.workPanelAgentRequest, (raw) => {
    void (async () => {
    const request = raw as AgentPanelRequest;
    let result: unknown;
    let error: string | undefined;
    try {
      const state = useAppStore.getState();
      const session = state.sessions.find(item => item.id === request.sessionId);
      if (!session || isRemoteSession(session)) throw new Error("Local session unavailable");
      const context = state.activeSessionId === request.sessionId
        ? currentWorkPanelContext(state) : state.workPanelContexts[request.sessionId];
      const snapshot: AgentPanelSnapshot = {
        sessionId: request.sessionId, activeTabId: context?.activeTabId ?? null,
        visible: state.activeSessionId === request.sessionId && !!context?.open,
        tabs: context?.tabs ?? [],
      };
      if (request.action === "list") result = snapshot;
      else {
        const tab = snapshot.tabs.find(item => item.id === request.tabId);
        if (!tab) throw new Error("Panel closed or not owned by this session");
        if (request.action === "screen" && tab.kind === "terminal") result = readTerminalScreen(tab.id);
        else if (request.action === "restart" && tab.kind === "terminal") result = await restartExitedTerminal(tab.id, request.termId ?? "");
        else if (request.action === "transcript" && tab.kind === "subagent") {
          const messages = transcriptViewMessages(state.activeSessionId === request.sessionId ? state.messages : [], state.transcriptViews[request.sessionId], state.sessionHistory[request.sessionId]?.messageParents);
          const transcript = buildSubagentTranscript(messages, tab.resource ?? "");
          if (!transcript) throw new Error("Subagent transcript unavailable in the loaded reading range; use TaskList/TaskWait");
          result = { delegationId: tab.resource, agentName: transcript.agentName, partial: true,
            turns: transcript.turns.slice(-5).map(turn => ({ task: turn.task.slice(0, 2000), rows: turn.rows.filter(row => row.kind !== "thinking").slice(-5).map(row => ({ kind: row.kind, tool: row.message.toolName, content: row.message.content?.slice(-1000) })) })) };
        }
        else {
          if (state.activeSessionId !== request.sessionId) throw new Error("Panel is not in the visible session; use content tools without changing focus");
          if (request.action === "focus") state.activateWorkPanelTab(tab.id);
          else if (request.action === "close") state.closeWorkPanelTab(tab.id);
          else throw new Error("Unsupported panel action");
          result = { ok: true };
        }
      }
    } catch (cause) { error = cause instanceof Error ? cause.message : String(cause); }
    void desktop.invoke(IPC.invoke.workPanelAgentReply, { requestId: request.requestId, result, error })
      .catch(cause => useAppStore.getState().showToast(String(cause), { variant: "error" }));
    })();
  });
  }, []);
}
