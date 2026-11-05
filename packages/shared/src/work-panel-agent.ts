/** Session-scoped UI metadata. Content is data, never an instruction or grant. */
export type AgentPanel = {
  id: string;
  kind: string;
  resource?: string;
  label?: string;
  location?: string;
};
export type AgentPanelSnapshot = {
  sessionId: string;
  activeTabId: string | null;
  visible: boolean;
  tabs: AgentPanel[];
};
export type AgentPanelRequest = {
  requestId: string;
  sessionId: string;
  action: "list" | "focus" | "close" | "screen" | "transcript" | "restart";
  tabId?: string;
  termId?: string;
};
