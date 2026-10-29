import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createInstance } from "i18next";
import { I18nextProvider } from "react-i18next";
import { catalogs } from "@pi-desktop/i18n";
import { createServer } from "vite";
import { fileURLToPath } from "node:url";

test("subtask sidebars include their session's off-page Task without adopting search history", async () => {
  const vite = await createServer({
    root: fileURLToPath(new URL("..", import.meta.url)), configFile: false,
    server: { middlewareMode: true, hmr: false, ws: false },
    esbuild: { jsx: "automatic" }, appType: "custom", optimizeDeps: { noDiscovery: true, include: [] },
  });
  const previousStorage = globalThis.localStorage;
  globalThis.localStorage = { getItem: (key) => key === "mc.sessionInfoOpen" ? '{"local":true,"other":true}' : null };
  try {
    const { BackgroundPane } = await vite.ssrLoadModule("/src/features/work-tools/BackgroundPane.tsx");
    const { SessionInfo } = await vite.ssrLoadModule("/src/features/session-info/SessionInfo.tsx");
    const { useAppStore } = await vite.ssrLoadModule("/src/stores/app-store.ts");
    const i18n = createInstance();
    await i18n.init({ lng: "en", resources: { en: { translation: catalogs.en } } });
    const task = (id, agent) => ({
      id, role: "tool", content: "", createdAt: "2026-10-30T00:00:00Z", toolName: "Task", toolCallId: id,
      toolStatus: "success", toolArgs: { agent }, toolResult: { details: { delegationId: id, agent, status: "running" } },
    });
    const localTask = task("local-task", "local-fixer");
    const otherTask = task("other-task", "other-reviewer");
    const searchTask = task("search-task", "search-only-agent");
    useAppStore.setState({
      activeSessionId: "local", sessions: [{ id: "local" }, { id: "other" }], messages: [],
      retainedTranscripts: { other: [] }, isRunning: true, runningSessions: { local: true, other: true },
      sessionHistory: { local: { messageParents: [localTask] }, other: { messageParents: [otherTask] } },
      transcriptViews: { local: { messages: [searchTask], focus: { sessionId: "local", messageId: searchTask.id, requestId: 1 } } },
    });
    const render = (component, props) => {
      Object.assign(useAppStore.getInitialState(), useAppStore.getState());
      return renderToStaticMarkup(createElement(I18nextProvider, { i18n }, createElement(component, props)));
    };
    for (const component of [BackgroundPane, SessionInfo]) {
      const html = render(component);
      assert.match(html, /local-fixer/);
      assert.doesNotMatch(html, /other-reviewer|search-only-agent/);
    }
    const retained = render(SessionInfo, { sessionId: "other", scope: "column" });
    assert.match(retained, /other-reviewer/);
    assert.doesNotMatch(retained, /local-fixer|search-only-agent/);
    // A terminal canonical Task must outrank the older running context row.
    useAppStore.setState({ messages: [{ ...localTask, toolResult: { details: { ...localTask.toolResult.details, status: "completed" } } }] });
    assert.doesNotMatch(render(BackgroundPane), /local-fixer/);
    assert.equal((render(SessionInfo).match(/>local-fixer</g) ?? []).length, 1);
    assert.equal(useAppStore.getState().messages.length, 1, "projection must not append context to the canonical transcript");
  } finally {
    if (previousStorage === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = previousStorage;
    await vite.close();
  }
});
