/** mc-agent (MC-ADR-0010): the template picked for a new conversation reaches its launch. */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { createSessionLaunchRuntime } = await import("../electron/main/runtime/session-launch.ts");
const { registerMcPromptsIpc } = await import("../electron/main/ipc/mc-prompts-ipc.ts");
const { IPC } = await import("@pi-desktop/shared");

const workspace = mkdtempSync(join(tmpdir(), "pi-session-prompt-ws-"));
test.after(() => rmSync(workspace, { recursive: true, force: true }));

const shell = { id: "bash", label: "Bash", dialect: "posix", available: true, isDefault: true };
const provider = {
  id: "fixture-provider", vendorKey: "fixture", name: "Fixture", enabled: true,
  authKind: "none", baseUrl: "http://127.0.0.1:1/v1", apiStyle: "openai-chat",
  models: [{ id: "parent", thinkingLevels: ["off"] }],
};
const promptConfig = {
  templates: [
    { id: "chosen", name: "Chosen", persona: "CHOSEN-PERSONA", append: "" },
    { id: "project", name: "Project", persona: "PROJECT-PERSONA", append: "" },
  ],
  globalTemplateId: null,
  modelRules: [],
  projectRules: [{ path: workspace, templateId: "project" }],
};

function launchRuntime(sessionGet) {
  return createSessionLaunchRuntime({
    runtimeState: { host: {
      isAvailable: () => true,
      call: async (method, params) => {
        if (method === "commandShells.list") return { configuredId: "bash", effective: shell, fallback: false, choices: [shell] };
        if (method === "providers.list") return { providers: [provider] };
        if (method === "providers.getSecret") return {};
        if (method === "agents.active") return { subagents: [] };
        if (method === "skills.disabledBuiltins") return { disabled: [] };
        if (method === "skills.active") return { skills: [] };
        if (method === "mcp.active") return { servers: [] };
        if (method === "project.memory.get") return {};
        if (method === "mcPrompts.get") return { config: promptConfig };
        if (method === "mcPrompts.sessionGet") return sessionGet(params);
        throw new Error(`Unexpected host call ${method}`);
      },
    } },
    logger: { app() {} }, userMcp: { setRecords() {}, toolsForProject: async () => [] },
    plugins: { listLoaded: () => [], getSkills: () => [], getTools: () => [], getAgentExtensions: () => [] },
    sessionProjects: new Map(), dataDir: workspace, vendorOAuth: {},
    modelsDevCatalog: { configureAccount: () => {}, ensureLoaded: async () => {}, findModel: () => undefined },
    getWorkspacePath: () => workspace, pluginActiveInProject: () => true,
    bindingForModel: (row, id) => row.models.find((m) => m.id === id),
    effectiveSubagentModelConfig: () => ({}),
    normalizeThinkingLevel: () => "off",
  });
}

async function customPrompt(runtime, sessionId) {
  const launch = await runtime.resolveAgentRuntimeLaunch(sessionId, {
    providerId: provider.id, modelId: "parent", projectPath: workspace,
  }, {});
  return launch.sidecarParams.customSystemPrompt;
}

test("a conversation's chosen template replaces the project's for that conversation only", async () => {
  const asked = [];
  const runtime = launchRuntime(({ sessionId }) => {
    asked.push(sessionId);
    return { templateId: sessionId === "picked" ? "chosen" : null };
  });
  assert.equal((await customPrompt(runtime, "picked"))?.replace, "CHOSEN-PERSONA");
  assert.equal((await customPrompt(runtime, "plain"))?.replace, "PROJECT-PERSONA");
  assert.deepEqual(asked, ["picked", "plain"]);
});

test("a failing lookup of the choice never blocks a launch", async () => {
  const runtime = launchRuntime(() => {
    throw new Error("host busy");
  });
  assert.equal((await customPrompt(runtime, "any"))?.replace, "PROJECT-PERSONA");
});

test("the choice is read and written through validated IPC calls", async () => {
  const handlers = new Map();
  const calls = [];
  registerMcPromptsIpc({
    registrar: { handle: (channel, handler) => handlers.set(channel, handler) },
    getHost: () => ({ call: async (method, params) => (calls.push([method, params]), { templateId: params.templateId ?? null }) }),
  });
  const get = handlers.get(IPC.invoke.mcPromptsSessionGet);
  const set = handlers.get(IPC.invoke.mcPromptsSessionSet);
  assert.deepEqual(await get({ sessionId: "s1" }), { templateId: null });
  assert.deepEqual(await set({ sessionId: "s1", templateId: "chosen" }), { templateId: "chosen" });
  assert.deepEqual(await set({ sessionId: "s1", templateId: null }), { templateId: null });
  assert.deepEqual(calls, [
    ["mcPrompts.sessionGet", { sessionId: "s1" }],
    ["mcPrompts.sessionSet", { sessionId: "s1", templateId: "chosen" }],
    ["mcPrompts.sessionSet", { sessionId: "s1", templateId: null }],
  ]);
  await assert.rejects(() => get({}), /sessionId required/);
  await assert.rejects(() => set({ sessionId: "s1", templateId: 7 }), /templateId must be a string/);
  assert.equal(calls.length, 3, "invalid input never reaches host-core");
});
