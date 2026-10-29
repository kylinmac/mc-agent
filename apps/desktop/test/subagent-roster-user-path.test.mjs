import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { repositoryRoot, resolveElectronBinary } from "../../../scripts/e2e/boot.mjs";

const root = repositoryRoot();
const { build } = createRequire(join(root, "packages/agent-runtime/package.json"))("esbuild");
const fixture = String.raw`
import React from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import { catalogs, flattenCatalog } from "@pi-desktop/i18n";
import { useAppStore } from "../../apps/desktop/src/stores/app-store";
import { ToolRow } from "../../apps/desktop/src/features/chat/transcript/ToolRow";
import { SubagentTopology } from "../../apps/desktop/src/features/chat/transcript/SubagentDetail";
import { SubagentTranscriptTab } from "../../apps/desktop/src/components/workpanel/SubagentTranscriptTab";
import { SlotSessionProvider } from "../../apps/desktop/src/plugins/renderer-slots/use-slots";

await i18n.use(initReactI18next).init({ lng: "en", keySeparator: false,
  resources: { en: { translation: flattenCatalog(catalogs.en) } }, interpolation: { escapeValue: false } });
window.piDesktop = { platform: "darwin", on() { return () => {}; },
  invoke() { throw new Error("Unexpected IPC in subagent navigation fixture"); } };
const check = (value, message) => { if (!value) throw new Error(message); };
const frame = () => new Promise(requestAnimationFrame);
const message = (id, role, extra = {}) => ({ id, role, content: "", createdAt: "2026-10-30T00:00:00Z", ...extra });
const task = (id) => message("task-" + id, "tool", { toolName: "Task", toolCallId: "call-" + id, toolStatus: "success",
  toolArgs: { agent: "fixer", fork: true, task: "Repair " + id },
  toolResult: { details: { delegationId: id, agent: "fixer", status: "completed", modelId: "fixture-model", thinkingLevel: "medium" } } });
const tasks = [task("cdc"), task("doris")];
const roster = tasks.map((entry) => ({ ...entry.toolResult.details, startedAt: 1000, completedAt: 208000 }));
const lifecycle = (name) => message("query-" + name, "tool", { toolName: name, toolCallId: "query-" + name,
  toolStatus: "success", toolResult: { details: name === "TaskStop" ? { stopped: roster } : { delegations: roster } } });
const children = tasks.map((entry, index) => message("answer-" + index, "assistant", {
  content: index ? "Doris fixture report" : "CDC fixture report", parentToolCallId: entry.toolCallId, agentName: "fixer" }));
const reset = () => useAppStore.setState({ activeSessionId: "local", sessions: [{ id: "local" }],
  messages: [...tasks, ...children], sessionHistory: {}, transcriptViews: {},
  workPanelTabs: [], activeWorkPanelTabId: null, workPanelContexts: {}, workPanelOpen: false });
let rootNode;
function Surface({ row, sessionId = "local" }) {
  const tabId = useAppStore((state) => state.activeWorkPanelTabId);
  return <SlotSessionProvider sessionId={sessionId}><ToolRow message={row} />
    {tabId?.startsWith("subagent:") ? <SubagentTranscriptTab delegationId={tabId.slice(9)} /> : null}
  </SlotSessionProvider>;
}
async function mount(node) {
  if (rootNode) flushSync(() => rootNode.unmount());
  rootNode = createRoot(document.getElementById("root"));
  flushSync(() => rootNode.render(node)); await frame();
}
const links = () => [...document.querySelectorAll("button[data-delegation-id]")];
async function expand() { flushSync(() => document.querySelector(".tool-row-header").click()); await frame(); }
async function rosterProbe() {
  for (const name of ["TaskList", "TaskWait", "TaskStop"]) {
    reset(); await mount(<Surface row={lifecycle(name)} />); await expand();
    check(links().length === 2, name + " must expose both existing delegates");
    check(!document.querySelector(".subagent-topology"), name + " must not create duplicate Task cards");
    check(links()[0].textContent.includes("fixer 1") && links()[1].textContent.includes("fixer 2"), "same-name delegates need distinct labels");
    flushSync(() => links()[1].click()); await frame();
    check(useAppStore.getState().activeWorkPanelTabId === "subagent:doris", "wrong delegation opened");
    const panel = document.querySelector('[data-testid="subagent-transcript-tab"]');
    check(panel?.textContent.includes("Doris fixture report") && !panel.textContent.includes("CDC fixture report"), "wrong delegate conversation displayed");
  }
  const unknown = lifecycle("TaskList");
  unknown.toolResult.details.delegations = [{ delegationId: "cdc", agent: "fixer", status: "unexpected" }];
  reset(); await mount(<Surface row={unknown} />); await expand();
  check(links()[0]?.textContent.includes("Running"), "unknown roster status must not claim completion");
  const missing = lifecycle("TaskList");
  missing.toolResult.details.delegations = [{ delegationId: "missing", agent: "fixer", status: "completed" }];
  reset(); await mount(<Surface row={missing} />); await expand();
  flushSync(() => links()[0].click()); await frame();
  const unavailable = document.querySelector('[data-testid="subagent-transcript-tab"]');
  check(unavailable?.textContent.includes(i18n.t("panel.subagentEmpty")) && !unavailable.textContent.includes("fixture report"), "unknown id must not open another delegate's conversation");
  for (const [pane, sessions] of [["remote:fixture", [{ id: "local" }, { id: "remote:fixture", source: "remote" }]],
    ["local", [{ id: "local", capabilities: { canUseLocalTools: false } }]],
    ["other", [{ id: "local" }, { id: "other" }]]]) {
    reset(); useAppStore.setState({ sessions });
    await mount(<Surface row={lifecycle("TaskList")} sessionId={pane} />); await expand();
    check(links().length === 0, "inactive or restricted pane must not open the active session's panel");
    check(useAppStore.getState().activeWorkPanelTabId === null, "restricted pane changed work panel");
    await mount(<SlotSessionProvider sessionId={pane}><SubagentTopology items={[{ kind: "tool", message: tasks[0] }]} /></SlotSessionProvider>);
    check(document.querySelector(".subagent-topology-node-header")?.disabled, "inactive or restricted Task card must not target the active session");
  }
  // B-038 supplies out-of-window Task context without changing the physical page.
  reset(); useAppStore.setState({ messages: [lifecycle("TaskList")],
    sessionHistory: { local: { messageStart: 100, hasMoreBefore: true, messageParents: tasks } } });
  await mount(<Surface row={lifecycle("TaskList")} />); await expand();
  flushSync(() => links()[0].click()); await frame();
  check(document.querySelector('[data-testid="subagent-transcript-tab"]')?.textContent.includes("Repair cdc"), "out-of-window Task must open instead of unavailable");
}
async function coordinatorProbe() {
  reset();
  const items = tasks.map((message) => ({ kind: "tool", message }));
  const render = (statuses) => mount(<SlotSessionProvider sessionId="local"><SubagentTopology items={items} delegationStatuses={new Map(statuses)} /></SlotSessionProvider>);
  for (const statuses of [[['cdc', 'completed'], ['doris', 'completed']], [['cdc', 'failed'], ['doris', 'stopped']]]) {
    await render(statuses);
    const text = document.querySelector(".subagent-topology-root-copy").textContent;
    check(text.includes("Delegation ended") && !text.includes("Coordinating"), "settled topology still claims active coordination");
  }
  await render([['cdc', 'completed'], ['doris', 'running']]);
  check(document.querySelector(".subagent-topology-root-copy").textContent.includes("Coordinating 2"), "active coordination lost its running label");
  const creating = { ...tasks[0], toolResult: undefined, toolStatus: "running" };
  await mount(<SlotSessionProvider sessionId="local"><SubagentTopology items={[{ kind: "tool", message: creating }]} /></SlotSessionProvider>);
  check(document.querySelector(".subagent-topology-root-copy").textContent.includes("Coordinating 1"), "Task creation without a delegation id must stay active");
}
window.subagentRosterProbe = async () => {
  const failures = [];
  for (const probe of [rosterProbe, coordinatorProbe]) {
    try { await probe(); } catch (error) { failures.push(probe.name + ": " + error.message); }
  }
  if (rootNode) flushSync(() => rootNode.unmount());
  return { failures };
};
`;

test("lifecycle rows open existing delegates safely and coordinator wording follows outcomes", {
  skip: process.platform === "linux" && !process.env.DISPLAY ? "Electron requires a display" : false,
}, async () => {
  const temp = await mkdtemp(join(root, "apps/desktop/.subagent-roster-ui-"));
  try {
    await build({ stdin: { contents: fixture, resolveDir: join(root, "scripts/e2e"), loader: "tsx" },
      outfile: join(temp, "renderer.js"), bundle: true, platform: "browser", format: "esm", jsx: "automatic",
      loader: { ".css": "empty" },
      define: { "process.env.NODE_ENV": '"production"' },
      alias: Object.fromEntries([...["i18n", "shared"].map((name) => ["@pi-desktop/" + name, join(root, "packages", name, "src")]),
        ...["react", "react-dom", "i18next", "react-i18next"].map((name) => [name, join(root, "apps/desktop/node_modules", name)])]),
      nodePaths: [join(root, "apps/desktop/node_modules")],
    });
    await writeFile(join(temp, "index.html"), '<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src \'self\'; style-src \'self\' \'unsafe-inline\'"><div id="root"></div><script type="module" src="renderer.js"></script>');
    await writeFile(join(temp, "main.cjs"), `
const { app, BrowserWindow } = require("electron");
const path = require("node:path");
app.setPath("userData", path.join(__dirname, "profile"));
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  try {
    await win.loadFile(path.join(__dirname, "index.html"));
    console.log("SUBAGENT_ROSTER_PROBE " + JSON.stringify(await win.webContents.executeJavaScript("window.subagentRosterProbe()")));
    app.exit(0);
  } catch (error) { console.error(error?.stack ?? error); app.exit(1); }
});`);
    const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(resolveElectronBinary(root).electronBinary, [join(temp, "main.cjs")], { env, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    for (const stream of [child.stdout, child.stderr]) { stream.setEncoding("utf8"); stream.on("data", (chunk) => { output += chunk; }); }
    const timer = setTimeout(() => child.kill("SIGKILL"), 45_000);
    let code;
    try { code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("close", resolve); }); }
    finally { clearTimeout(timer); }
    assert.equal(code, 0, output.slice(-6000));
    const line = output.split(/\r?\n/).find((item) => item.startsWith("SUBAGENT_ROSTER_PROBE "));
    assert.ok(line, output.slice(-6000));
    assert.deepEqual(JSON.parse(line.slice("SUBAGENT_ROSTER_PROBE ".length)), { failures: [] });
  } finally { await rm(temp, { recursive: true, force: true }); }
});
