import { stripVTControlCharacters } from "node:util";
import { collectWorkspaceDiff } from "@pi-desktop/host-runtime";
import type { AgentPanelSnapshot } from "@pi-desktop/shared";
import type { LocalToolHandler } from "../agent-sidecar";
import type { BrowserHost } from "../browser-host";
import { createCanvasTools } from "../canvas/canvas-tools";
import { panelBridge } from "./bridge";
import { pluginPanelOperation } from "./plugin-surface";
import { panelTerminals } from "./terminals";

type Host = { call<T>(method: string, params?: unknown): Promise<T> };
function text(value: unknown, label: string, max = 256, allowEmpty = false): string {
  if (typeof value !== "string" || (!value && !allowEmpty) || value.length > max) throw new Error(`Invalid ${label}`);
  return value;
}
const guides: Record<string, string> = {
  terminal: "WorkPanelRead output/screen; WorkPanelAction input/interrupt/close. This is the user's interactive shell, not BashOutput.",
  background: "BashOutput reads a task by id; KillBash stops it. IDs belong to this session.",
  canvas: "CanvasRead, CanvasWrite and CanvasComment use canvas IDs and baseVersion, preserving comment permissions.",
  review: "Read the diff here; use the existing approved Bash/Edit tools for Git and file changes.",
  file: "Read/Edit/Write use the path; do not overwrite an unsaved editor buffer.",
  subagent: "Use TaskList/TaskWait/TaskStop with this delegation ID; Task resume sends a follow-up. This is not a session ID.",
};

export function createPanelTools(getHost: () => Host | null, browser: BrowserHost) {
  const make = (name: string): LocalToolHandler => async input => {
    try {
      const host = getHost();
      if (!host || input.sessionId.startsWith("remote:")) throw new Error("Local host required");
      const { session } = await host.call<{ session?: { projectPath?: string; source?: string } }>("session.get", { id: input.sessionId });
      if (!session || session.source === "remote") throw new Error("Local session unavailable");
      const snapshot = await panelBridge.request({ sessionId: input.sessionId, action: "list" }, input.signal) as AgentPanelSnapshot;
      input.signal.throwIfAborted();
      const done = (content: unknown) => ({ ok: true, isError: false, content });
      if (name === "WorkPanelList") return done({ ...snapshot, tabs: snapshot.tabs.map(tab => ({ ...tab,
        guide: guides[tab.kind] ?? (tab.resource === "pi.browser/browser" ? "Read snapshot/console; navigate/click/fill by exact tabId." : "Read the visible plugin UI, then click/type/key using its snapshot. Specialized plugin tools remain available via ToolSearch."),
      })) });
      const args = (input.args ?? {}) as Record<string, unknown>;
      const tabId = text(args.tabId, "tabId");
      const tab = snapshot.tabs.find(item => item.id === tabId);
      if (!tab) throw new Error("Panel closed or not owned by this session");
      const isBrowser = tab.kind === "plugin" && tab.resource === "pi.browser/browser";
      if (name === "WorkPanelRead") {
        if (tab.kind === "terminal") {
          const terminal = panelTerminals().agentSession(input.sessionId, tabId);
          if (args.mode === "screen") return done(await panelBridge.request({ sessionId: input.sessionId, action: "screen", tabId }, input.signal));
          const cursor = typeof args.cursor === "number" ? args.cursor : terminal.cursor - 32768;
          if (!Number.isSafeInteger(cursor) || cursor > terminal.cursor) throw new Error("Invalid output cursor");
          const start = Math.max(terminal.start, terminal.cursor - 32768, cursor);
          return done({ ...terminal, output: stripVTControlCharacters(terminal.output.slice(start - terminal.start)), start, truncated: start > cursor, boundedTail: true });
        }
        if (isBrowser) {
          if (args.mode === "screenshot") return done({ text: "Browser panel", images: [await browser.screenshot({}, input.sessionId, tabId)] });
          return done({ ...await browser.snapshot(input.sessionId, tabId), console: browser.console(100, input.sessionId, tabId) });
        }
        if (tab.kind === "plugin" && tab.resource) return done(await pluginPanelOperation(tab.resource, input.sessionId, { action: args.mode === "screenshot" ? "screenshot" : "read" }, input.signal));
        if (tab.kind === "review") {
          if (!session.projectPath) throw new Error("Project folder unavailable");
          return done(await collectWorkspaceDiff(session.projectPath));
        }
        if (tab.kind === "subagent") return done({ transcript: await panelBridge.request({ sessionId: input.sessionId, action: "transcript", tabId }, input.signal), guide: guides.subagent });
        if (tab.kind === "background") {
          const { tasks } = await host.call<{ tasks: Array<{ id: string; sessionId: string }> }>("backgroundTasks.list", {});
          const own = tasks.filter(task => task.sessionId === input.sessionId);
          if (args.backgroundId !== undefined) {
            const id = text(args.backgroundId, "backgroundId");
            if (!own.some(task => task.id === id)) throw new Error("Background task is not owned by this session");
            return done({ task: own.find(task => task.id === id), output: await host.call("backgroundTasks.output", { id }), guide: guides.background });
          }
          return done({ tasks: own, guide: guides.background });
        }
        if (tab.kind === "canvas") return createCanvasTools(getHost).read({ ...input, args: { canvasId: tab.resource } });
        if (tab.kind === "file" && tab.resource) return host.call("tools.execute", { sessionId: input.sessionId, toolCallId: `${input.toolCallId}:read`, toolName: "Read", args: { path: tab.resource }, mode: "agent" });
        return done({ ...tab, guide: guides[tab.kind] ?? "Use ToolSearch to discover this plugin's tools. UI state adapter unavailable." });
      }
      const action = text(args.action, "action");
      if (action === "focus") return done(await panelBridge.request({ sessionId: input.sessionId, action, tabId }, input.signal));
      if (tab.kind === "background" && action === "stop") {
        const id = text(args.backgroundId, "backgroundId");
        const { tasks } = await host.call<{ tasks: Array<{ id: string; sessionId: string }> }>("backgroundTasks.list", {});
        if (!tasks.some(task => task.id === id && task.sessionId === input.sessionId)) throw new Error("Background task is not owned by this session");
        input.signal.throwIfAborted();
        return done(await host.call("backgroundTasks.stop", { id }));
      }
      if (tab.kind === "terminal") {
        const manager = panelTerminals();
        const terminal = manager.agentSession(input.sessionId, tabId);
        input.signal.throwIfAborted();
        if (args.termId !== terminal.termId) throw new Error("Terminal instance changed; read it again and pass termId");
        if (action === "close") {
          // Closing the UI owns disposal, so it cannot restart an invisible shell.
          return done(await panelBridge.request({ sessionId: input.sessionId, action: "close", tabId }, input.signal));
        }
        if (action === "restart") {
          if (terminal.running) throw new Error("Terminal is still running; exit it before restarting");
          return done(await panelBridge.request({ sessionId: input.sessionId, action: "restart", tabId, termId: terminal.termId }, input.signal));
        }
        if (!terminal.running) throw new Error("Terminal exited; no input was sent");
        if (action === "interrupt") manager.write(terminal.termId, "\u0003");
        else if (action === "key") {
          const keys: Record<string, string> = { Enter: "\r", Tab: "\t", Escape: "\u001b", Backspace: "\u007f", ArrowUp: "\u001b[A", ArrowDown: "\u001b[B", ArrowRight: "\u001b[C", ArrowLeft: "\u001b[D", CtrlC: "\u0003", CtrlD: "\u0004", CtrlL: "\u000c" };
          const key = keys[String(args.key)];
          if (!key) throw new Error("Unsupported terminal key");
          manager.write(terminal.termId, key);
        }
        else if (action === "input") manager.write(terminal.termId, text(args.text, "text", 65536) + (args.enter === true ? "\r" : ""));
        else throw new Error("Unsupported terminal action");
        return done({ sent: true, termId: terminal.termId, note: "Read output to verify the result; input delivery is not command success." });
      }
      if (isBrowser) {
        if (action === "navigate") return done(await browser.navigate({ url: text(args.url, "url", 4096) }, input.sessionId, tabId));
        if (action === "click") await browser.click(text(args.uid, "uid"), input.sessionId, tabId);
        else if (action === "fill") await browser.fill(text(args.uid, "uid"), text(args.text, "text", 65536, true), input.sessionId, tabId);
        else throw new Error("Unsupported browser action");
        return done({ ok: true });
      }
      if (tab.kind === "plugin" && tab.resource) return done(await pluginPanelOperation(tab.resource, input.sessionId, args, input.signal));
      throw new Error(`Unsupported action. ${guides[tab.kind] ?? "Use the plugin's registered tools."}`);
    } catch (error) {
      return { ok: false, isError: true, content: error instanceof Error ? error.message : String(error) };
    }
  };
  return { WorkPanelList: make("WorkPanelList"), WorkPanelRead: make("WorkPanelRead"), WorkPanelAction: make("WorkPanelAction") };
}
