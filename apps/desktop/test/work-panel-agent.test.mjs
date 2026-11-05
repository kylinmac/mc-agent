import assert from "node:assert/strict";
import test, { after } from "node:test";
import { build } from "esbuild";
import { mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
const dir = await mkdtemp(resolve("node_modules/.mc-panel-test-"));
after(async () => { if (!dir.startsWith(resolve("node_modules/.mc-panel-test-"))) throw new Error("Invalid test path"); await rm(dir, { recursive: true, force: true }); });
await build({ stdin: { contents: `
export { createPanelTools } from './work-panel-agent/tools';
export { panelBridge, PanelBridge } from './work-panel-agent/bridge';
export { setPanelTerminalManager } from './work-panel-agent/terminals';
export { TerminalManager } from './mc-terminal';`, resolveDir: resolve(import.meta.dirname, "../electron/main"), loader: "ts" },
  outfile: join(dir, "bundle.mjs"), bundle: true, platform: "node", format: "esm", packages: "external" });
const { createPanelTools, panelBridge, PanelBridge, setPanelTerminalManager, TerminalManager } = await import(pathToFileURL(join(dir, "bundle.mjs")));

test("panel bridge correlates requests, propagates errors and cancels pending reads", async () => {
  const bridge = new PanelBridge();
  let request;
  bridge.connect((_channel, value) => { request = value; });
  const controller = new AbortController();
  const read = bridge.request({ sessionId: "s1", action: "list" }, controller.signal);
  bridge.reply("wrong nonce", { result: "wrong" });
  bridge.reply(request.requestId, { result: { tabs: [] } });
  assert.deepEqual(await read, { tabs: [] });
  const cancelled = bridge.request({ sessionId: "s1", action: "list" }, controller.signal);
  controller.abort(); await assert.rejects(cancelled, /cancelled/);
});

test("user error -> discover/read -> input -> result; reject stale, cross-session and closed targets", async () => {
  let output;
  const written = [];
  const manager = new TerminalManager({ onData() {}, onExit() {} }, async () => (_shell, _args, _options) => ({
    onData(fn) { output = fn; }, onExit() {}, write(value) { written.push(value); output("RESULT fixture"); }, resize() {}, kill() {},
  }));
  setPanelTerminalManager(manager);
  await manager.create({ tabId: "terminal:t", sessionId: "s1", cwd: process.cwd() });
  output("\u001b[31mERROR fixture\u001b[0m");
  let owner = "s1";
  let tabs = [{ id: "terminal:t", kind: "terminal" }, { id: "browser:b", kind: "plugin", resource: "pi.browser/browser" }];
  panelBridge.connect((_channel, request) => {
    assert.equal(request.sessionId, owner);
    panelBridge.reply(request.requestId, { result: { sessionId: owner, tabs, visible: true, activeTabId: tabs[0]?.id ?? null } });
  });
  const browserCalls = [];
  const tools = createPanelTools(() => ({ call: async () => ({ session: { projectPath: process.cwd() } }) }), {
    snapshot: async (...args) => { browserCalls.push(args); return { tree: "page" }; }, console: () => ({ messages: [] }),
  });
  const call = (name, args = {}) => tools[name]({ sessionId: owner, toolCallId: "t", args, signal: new AbortController().signal });
  assert.equal((await call("WorkPanelList")).content.tabs.length, 2);
  const error = await call("WorkPanelRead", { tabId: "terminal:t" });
  assert.equal(error.content.output, "ERROR fixture");
  assert.equal((await call("WorkPanelAction", { tabId: "terminal:t", action: "input", text: "echo fixed", enter: true, termId: error.content.termId })).ok, true);
  assert.deepEqual(written, ["echo fixed\r"]);
  assert.equal((await call("WorkPanelRead", { tabId: "terminal:t", cursor: error.content.cursor })).content.output, "RESULT fixture");
  assert.equal((await call("WorkPanelAction", { tabId: "terminal:t", action: "input", text: "bad", termId: "old" })).ok, false);
  await call("WorkPanelRead", { tabId: "browser:b" });
  assert.deepEqual(browserCalls, [["s1", "browser:b"]]);
  owner = "s2";
  assert.equal((await call("WorkPanelRead", { tabId: "terminal:t" })).ok, false);
  owner = "s1"; tabs = [];
  assert.equal((await call("WorkPanelRead", { tabId: "terminal:t" })).ok, false);
  manager.disposeAll();
});

test("background reads and stop never use another conversation's task", async () => {
  panelBridge.connect((_channel, request) => panelBridge.reply(request.requestId, { result: {
    sessionId: "s1", tabs: [{ id: "background", kind: "background" }], visible: true,
  } }));
  const mutations = [];
  const tools = createPanelTools(() => ({ async call(method, params) {
    if (method === "session.get") return { session: { projectPath: process.cwd() } };
    if (method === "backgroundTasks.list") return { tasks: [{ id: "own", sessionId: "s1" }, { id: "other", sessionId: "s2" }] };
    if (method === "backgroundTasks.output") return { stdout: "fixture" };
    mutations.push(params.id); return { ok: true };
  } }), {});
  const call = (name, backgroundId) => tools[name]({ sessionId: "s1", toolCallId: "bg", args: { tabId: "background", action: "stop", backgroundId }, signal: new AbortController().signal });
  assert.equal((await call("WorkPanelRead", "own")).content.output.stdout, "fixture");
  assert.equal((await call("WorkPanelRead", "other")).ok, false);
  assert.equal((await call("WorkPanelAction", "other")).ok, false);
  assert.equal((await call("WorkPanelAction", "own")).ok, true);
  assert.deepEqual(mutations, ["own"]);
  const remote = await tools.WorkPanelList({ sessionId: "remote:test", toolCallId: "r", args: {}, signal: new AbortController().signal });
  assert.equal(remote.ok, false);
});
