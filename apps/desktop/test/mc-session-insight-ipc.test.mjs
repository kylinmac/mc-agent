import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
import { IPC } from "@pi-desktop/shared";

register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { registerSessionInsightIpc } = await import("../electron/main/ipc/mc-session-insight-ipc.ts");

test("context breakdown refreshes idle runtime configuration before returning existing statistics", async () => {
  const handlers = new Map();
  const calls = [];
  const fresh = { breakdown: { contextWindow: 128_000, usedTokens: 14_100 } };
  registerSessionInsightIpc({
    registrar: { handle: (name, handler) => handlers.set(name, handler) },
    getSidecar: () => ({ call: async () => {
      calls.push("old-runtime");
      return { breakdown: { contextWindow: 256_000, usedTokens: 272_900 } };
    } }),
    prepareRuntime: async (id) => { assert.equal(id, "session"); calls.push("prepare"); return fresh; },
  });
  assert.deepEqual(await handlers.get(IPC.invoke.sessionContextBreakdown)({ sessionId: "session" }), fresh);
  assert.deepEqual(calls, ["prepare"]);
});

test("running or external sessions use the existing runtime when preparation is skipped", async () => {
  const handlers = new Map();
  const live = { breakdown: { contextWindow: 256_000, usedTokens: 20_000 } };
  registerSessionInsightIpc({
    registrar: { handle: (name, handler) => handlers.set(name, handler) },
    getSidecar: () => ({ call: async () => live }),
    prepareRuntime: async () => null,
  });
  assert.deepEqual(await handlers.get(IPC.invoke.sessionContextBreakdown)({ sessionId: "session" }), live);
});
