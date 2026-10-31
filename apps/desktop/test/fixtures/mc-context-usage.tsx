import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { useSessionContextBreakdown } from "../../src/features/chat/context-usage/useSessionContextBreakdown";
import { contextUsageFromBreakdown } from "../../src/lib/context-usage";
import { ContextUsageInspector } from "../../src/components/ContextUsageInspector";
import { useAppStore } from "../../src/stores/app-store";
import { api } from "../../src/lib/api";

const settle = () => new Promise((resolve) => setTimeout(resolve, 40));
function check(ok, message) { if (!ok) throw new Error(message); }
function Indicator({ panel = false }) {
  const id = useAppStore((s) => s.activeSessionId);
  const snapshot = useSessionContextBreakdown(id);
  const compacted = useAppStore((s) => Boolean(id && s.sessionCompactions[id]?.length));
  if (!snapshot) return <span data-pending />;
  if (panel) return <span data-context-panel>{contextUsageFromBreakdown(snapshot).remainingPercent}%</span>;
  const usage = { inputTokens: 272900, outputTokens: 0, totalTokens: 272900 };
  return <ContextUsageInspector contextSnapshot={snapshot} contextWindow={snapshot.contextWindow} usage={compacted ? undefined : usage} turnUsage={compacted ? undefined : usage} />;
}
export async function checkCurrentContext() {
  const node = document.createElement("div"); document.body.append(node);
  const root = createRoot(node);
  const original = api.sessionContextBreakdown;
  const requests = [];
  api.sessionContextBreakdown = (id) => new Promise((resolve, reject) => requests.push({ id, resolve, reject }));
  const resolve = (index, usedTokens = 14100, contextWindow = 256000) => requests[index].resolve({ breakdown: { usedTokens, contextWindow } });
  const checkPercent = (percent) => {
    check(node.querySelector("[data-context-panel]")?.textContent === percent + "%", "panel current capacity");
    check(node.querySelector("button")?.textContent.includes(percent + "%"), "composer must match panel despite old 272.9k request");
  };
  try {
    flushSync(() => root.render(<><Indicator panel /><Indicator /></>));
    await settle(); check(requests.length === 1, "both indicators share one request");
    resolve(0); await settle(); checkPercent(94);
    useAppStore.setState({ providerModels: {} }); await settle();
    check(node.querySelectorAll("[data-pending]").length === 2, "configuration change hides old snapshot");
    resolve(1, 14100, 128000); await settle(); checkPercent(89);
    const id = useAppStore.getState().activeSessionId;
    useAppStore.setState({ sessionCompactions: { [id]: [{ id: "compacted" }] } }); await settle();
    resolve(2, 4000, 128000); await settle(); checkPercent(97);
    useAppStore.setState({ providerModels: { changed: [] } }); await settle();
    useAppStore.setState({ activeSessionId: "context-other" }); await settle();
    resolve(4, 12800, 128000); await settle(); checkPercent(90);
    resolve(3, 127999, 128000); await settle(); checkPercent(90);
    useAppStore.setState({ providerModels: {} }); await settle();
    requests[5].reject(new Error("fixture unavailable")); await settle();
    check(!node.querySelector("button"), "failed snapshot must not fabricate zero percent");
  } finally { root.unmount(); node.remove(); api.sessionContextBreakdown = original; }
}
