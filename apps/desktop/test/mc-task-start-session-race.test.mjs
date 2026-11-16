import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { createSessionSlice } = await import("../src/stores/slices/session-slice.ts");
const { createSessionCoordination } = await import("../src/stores/runtime/session-coordination.ts");
const { createSessionRuntime } = await import("../src/stores/runtime/session-runtime.ts");
const { api } = await import("../src/lib/api.ts");

function sessionSummary(id, projectPath = "/proj/a") {
  return {
    id,
    title: "New Task",
    mode: "agent",
    thinkingLevel: "off",
    projectPath,
    messageCount: 0,
    updatedAt: "2026-11-16T10:00:00Z",
    createdAt: "2026-11-16T10:00:00Z",
  };
}

function sliceHarness(t) {
  const emptyExisting = sessionSummary("existing-empty");
  let state = {
    activeSessionId: "existing-empty",
    activeProjectPath: "/proj/a",
    workspace: { path: "/proj/a", name: "a" },
    isRunning: false,
    runningSessions: {},
    messages: [],
    sessions: [emptyExisting],
    sessionHistory: {},
    sessionMeta: {},
    sessionCompactions: {},
    planningStates: {},
    retainedSessionIds: ["existing-empty"],
    retainedTranscripts: { "existing-empty": [] },
    workPanelContexts: {},
    workPanelTabs: [],
    workPanelOpen: false,
    navStack: [{ page: "chat", sessionId: "existing-empty" }],
    navIndex: 0,
    providers: [],
    providerModels: {},
    recentModels: [],
    settings: { defaultMode: "agent" },
    draftConfiguration: null,
    page: "workbench",
    restorePendingPlan: async () => {},
    restorePendingInteractive: async () => {},
    activateProject: async () => ({ path: "/proj/a", name: "a" }),
    clearProject: async () => {},
    selectSession: async (id) => {
      state = { ...state, activeSessionId: id };
    },
  };
  const access = {
    get: () => state,
    set: (update) => {
      state = { ...state, ...(typeof update === "function" ? update(state) : update) };
    },
    decorateSessions: (sessions) => sessions,
    withoutRecordKey: (record, key) =>
      Object.fromEntries(Object.entries(record).filter(([itemKey]) => itemKey !== key)),
    untitledTaskTitle: () => "New Task",
  };
  const runtime = createSessionRuntime(access);
  const coordination = createSessionCoordination({ ...access, runtime });
  const slice = createSessionSlice({ ...access, runtime, ...coordination });
  const pendingResolvers = [];
  t.mock.method(
    api,
    "createSession",
    () => new Promise((resolve) => { pendingResolvers.push(resolve); }),
  );
  return {
    slice,
    runtime,
    get: access.get,
    set: access.set,
    resolveNextCreate: (id) => {
      const resolve = pendingResolvers.shift();
      if (!resolve) throw new Error("No pending createSession call");
      resolve({ session: sessionSummary(id) });
    },
  };
}

test("newSession({ fresh: true }) ignores reusable empty sessions and returns null if superseded", async (t) => {
  const h = sliceHarness(t);
  const superseded = h.slice.newSession({ projectPath: "/proj/a", fresh: true });
  await new Promise((resolve) => setImmediate(resolve));
  h.runtime.beginNavigationIntent();
  h.set({ activeSessionId: "existing-b" });
  h.resolveNextCreate("created-but-superseded");
  assert.equal(await superseded, null);
  assert.equal(h.get().activeSessionId, "existing-b");

  const active = h.slice.newSession({ projectPath: "/proj/a", fresh: true });
  await new Promise((resolve) => setImmediate(resolve));
  h.resolveNextCreate("created-fresh-2");
  assert.equal(await active, "created-fresh-2");
  assert.equal(h.get().activeSessionId, "created-fresh-2");
});

test("startProjectTaskRun never binds or sends to another session when creation is superseded or fails", async () => {
  const server = await createServer({
    root: fileURLToPath(new URL("..", import.meta.url)),
    configFile: false,
    server: { middlewareMode: true, hmr: false, ws: false },
    esbuild: { jsx: "automatic" },
    appType: "custom",
    optimizeDeps: { noDiscovery: true, include: [] },
  });
  try {
    const { startProjectTaskRun } = await server.ssrLoadModule(
      "/src/features/project-workbench/TaskBoard.tsx",
    );
    const baseTask = {
      id: "task-1",
      revision: 1,
      title: "Fix race",
      goal: "Isolate session creation",
      acceptance: "Never bind session B",
      resources: [],
      status: "todo",
      runs: [],
      reviews: [],
    };
    const tFn = (key, opts) => (opts?.n ? `${key}:${opts.n}` : key);

    for (const scenario of ["same-folder-switch", "other-project-switch"]) {
      const calls = [];
      let storeState = {
        activeSessionId: "existing-b",
        runningSessions: {},
        messages: [],
        retainedTranscripts: { "existing-b": [{ id: "m1" }] },
        newSession: async () => {
          storeState = {
            ...storeState,
            activeSessionId: scenario === "same-folder-switch" ? "existing-b" : "other-proj",
          };
          return null;
        },
        deleteSession: async (id) => calls.push(["delete", id]),
        renameSession: async (id, title) => calls.push(["rename", id, title]),
        setPage: (page) => calls.push(["setPage", page]),
        sendPrompt: async (prompt, _d, id) => {
          calls.push(["sendPrompt", id, prompt]);
          return true;
        },
      };
      await startProjectTaskRun({
        groupId: "g1",
        task: baseTask,
        listing: null,
        startFolder: "/proj/a",
        projectTasksApi: {
          preflight: async () => ({ blocking: [], drafts: [], resources: [] }),
          startRun: async (_g, _id, _rev, sessionId) => {
            calls.push(["startRun", sessionId]);
            return { task: { ...baseTask, runs: [{ id: "r1", sessionId }] } };
          },
          abandonRun: async (_g, _id, runId) => calls.push(["abandonRun", runId]),
        },
        getStore: () => storeState,
        t: tFn,
      });
      assert.deepEqual(calls, [], `${scenario}: superseded creation must produce zero side effects`);
    }

    {
      const calls = [];
      let storeState = {
        activeSessionId: "existing-b",
        runningSessions: {},
        messages: [],
        retainedTranscripts: {},
        newSession: async () => {
          storeState = { ...storeState, activeSessionId: "new-sess-1" };
          return "new-sess-1";
        },
        deleteSession: async (id) => calls.push(["delete", id]),
        renameSession: async (id, title) => calls.push(["rename", id, title]),
        setPage: (page) => calls.push(["setPage", page]),
        sendPrompt: async (_prompt, _d, id) => {
          calls.push(["sendPrompt", id]);
          return true;
        },
      };
      await startProjectTaskRun({
        groupId: "g1",
        task: baseTask,
        listing: null,
        startFolder: "/proj/a",
        projectTasksApi: {
          preflight: async () => ({ blocking: [], drafts: [], resources: [] }),
          startRun: async (_g, _id, _rev, sessionId) => {
            calls.push(["startRun", sessionId]);
            storeState = { ...storeState, activeSessionId: "existing-b" };
            return { task: { ...baseTask, runs: [{ id: "r1", sessionId }] } };
          },
          abandonRun: async (_g, _id, runId) => calls.push(["abandonRun", runId]),
        },
        getStore: () => storeState,
        t: tFn,
      });
      assert.deepEqual(calls, [
        ["startRun", "new-sess-1"],
        ["rename", "new-sess-1", "Fix race"],
        ["sendPrompt", "new-sess-1"],
      ]);
    }

    {
      const calls = [];
      const storeState = {
        activeSessionId: "new-sess-2",
        runningSessions: {},
        messages: [],
        retainedTranscripts: {},
        newSession: async () => "new-sess-2",
        deleteSession: async (id) => calls.push(["delete", id]),
        renameSession: async () => {},
        setPage: () => {},
        sendPrompt: async () => true,
      };
      await assert.rejects(
        startProjectTaskRun({
          groupId: "g1",
          task: baseTask,
          listing: null,
          startFolder: "/proj/a",
          projectTasksApi: {
            preflight: async () => ({ blocking: [], drafts: [], resources: [] }),
            startRun: async () => {
              throw new Error("CONFLICT");
            },
            abandonRun: async () => {},
          },
          getStore: () => storeState,
          t: tFn,
        }),
        /CONFLICT/,
      );
      assert.deepEqual(calls, [["delete", "new-sess-2"]]);
    }
  } finally {
    await server.close();
  }
});
