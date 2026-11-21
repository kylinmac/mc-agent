import assert from "node:assert/strict";
import test from "node:test";
import * as shared from "@pi-desktop/shared";
import { loadTsModule } from "./helpers/load-ts-module.mjs";

const { IPC } = shared;
function harness(scanners) {
  const { registerSessionImportIpc } = loadTsModule(new URL("../electron/main/ipc/session-import-ipc.ts", import.meta.url), {
    "@pi-desktop/shared": shared, "../importers": scanners,
  });
  return (getHost) => {
    const handlers = new Map();
    registerSessionImportIpc({
      registrar: { handle: (channel, handler) => handlers.set(channel, handler) },
      getHost, logger: { app() {} },
    });
    return (channel, input) => handlers.get(channel)(input);
  };
}

test("session import keeps the selected scan and host throughout a batch", async () => {
  const candidate = {
    source: "codex", title: "Session", projectPath: null, model: null,
    createdAt: "2026-01-01", updatedAt: "2026-01-01", messageCount: null,
  };
  let ids = ["one", "two"];
  const started = Promise.withResolvers();
  const resume = Promise.withResolvers();
  const register = harness({
    scanAllSources: async () => ({
      sessions: ids.map((externalId) => ({
        ...candidate, externalId, filePath: "/" + externalId, filePaths: ["/part"],
        historyDb: "/history", internalScanHint: "private",
      })), truncated: {},
    }),
    scanPiDesktop: async () => [],
    convertSession: async (item) => {
      started.resolve();
      await resume.promise;
      return { session: { id: item.externalId, title: item.filePath }, messages: [] };
    },
  });
  const imported = [];
  let host = { call: async (_method, { session }) => { imported.push(session.title); return { imported: true }; } };
  const invoke = register(() => host);
  const selection = (await invoke(IPC.invoke.sessionImportScan)).sessions;
  const batch = invoke(IPC.invoke.sessionImportRun, selection);
  await started.promise;
  ids = ["three"];
  host = { call: async () => { throw new Error("wrong host"); } };
  await invoke(IPC.invoke.sessionImportScan);
  resume.resolve();
  assert.deepEqual(await batch, { imported: 2, skipped: 0, failed: 0 });
  assert.deepEqual(imported, ["/one", "/two"]);
  assert.deepEqual(selection, ["one", "two"].map((externalId) => ({ ...candidate, externalId })));
  assert.deepEqual(await invoke(IPC.invoke.sessionImportRun, selection), { imported: 0, skipped: 0, failed: 2 });
});

test("a new IPC registration requires its own provider scan", async () => {
  const draft = {
    source: "codex", externalId: "test", name: "Example", apiStyle: "openai-responses",
    modelIds: [], models: [], hasSecret: true, secretValue: "fixture-only",
  };
  const register = harness({ scanModelConfigs: async () => [draft] });
  const calls = [];
  const getHost = () => ({ call: async (method) => {
    calls.push(method);
    if (method === "providers.list") return { providers: [] };
    if (method === "providers.create") return { provider: { id: "new" } };
    return { defaultProviderId: "existing" };
  } });
  const first = register(getHost);
  const { providers } = await first(IPC.invoke.modelConfigImportScan);
  assert.equal(Object.hasOwn(providers[0], "secretValue"), false);
  const second = register(getHost);
  assert.deepEqual(await second(IPC.invoke.modelConfigImportRun, providers), { imported: 0, skipped: 0, failed: 1 });
  assert.ok(!calls.includes("providers.create"));
  assert.deepEqual(await first(IPC.invoke.modelConfigImportRun, providers), { imported: 1, skipped: 0, failed: 0 });
});
