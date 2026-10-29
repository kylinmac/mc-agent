import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { createSessionSlice } = await import("../src/stores/slices/session-slice.ts");
const { createSessionCoordination } = await import("../src/stores/runtime/session-coordination.ts");
const { createSessionRuntime } = await import("../src/stores/runtime/session-runtime.ts");
const { api } = await import("../src/lib/api.ts");

function fixture(t) {
  const original = { id: "one", mode: "agent", modelId: "model", providerId: "provider", thinkingLevel: "max" };
  let state = {
    sessions: [original, { ...original, id: "two" }], activeSessionId: "one",
    runningSessions: { one: true }, sessionMeta: {}, planningStates: {}, pendingPlans: {},
    sessionConfigurationStatus: {}, showToast: () => {},
  };
  const access = {
    get: () => state,
    set: (update) => { state = { ...state, ...(typeof update === "function" ? update(state) : update) }; },
    withoutRecordKey: (record, key) => Object.fromEntries(Object.entries(record).filter(([id]) => id !== key)),
    decorateSessions: (sessions) => sessions,
  };
  const runtime = createSessionRuntime(access);
  const coordination = createSessionCoordination({ ...access, runtime });
  const slice = createSessionSlice({ ...access, runtime, ...coordination });
  state.refreshSessions = slice.refreshSessions;
  const calls = [];
  t.mock.method(api, "configureSession", (id, config) => new Promise((resolve, reject) => {
    calls.push({ id, config, resolve: () => resolve({ session: { ...original, id, ...config } }), reject });
  }));
  t.mock.method(api, "listSessions", async () => ({ sessions: [original, { ...original, id: "two" }] }));
  return { ...access, runtime, coordination, slice, calls };
}

const config = (thinkingLevel) => ({ mode: "agent", modelId: "model", providerId: "provider", thinkingLevel });

test("running reasoning changes stay visibly pending across refresh/navigation and clear only on acknowledgement", async (t) => {
  const f = fixture(t);
  await f.slice.configureActiveSession(config("medium"));
  assert.equal(f.get().sessionConfigurationStatus.one, "pending");
  assert.equal(f.calls.length, 0);
  await f.slice.refreshSessions();
  assert.equal(f.get().sessions[0].thinkingLevel, "medium");
  f.set({ activeSessionId: "two" });
  assert.equal(f.get().sessionConfigurationStatus.two, undefined);
  f.set({ runningSessions: { one: false } });
  const apply = f.coordination.flushPendingSessionConfiguration("one");
  assert.equal(f.get().sessionConfigurationStatus.one, "applying");
  f.calls[0].resolve();
  await apply;
  assert.equal(f.get().sessionConfigurationStatus.one, undefined);
  assert.equal(f.get().sessions[0].thinkingLevel, "medium");
  assert.equal(f.get().activeSessionId, "two");
});

test("an older acknowledgement cannot hide or overwrite a newer staged choice", async (t) => {
  const f = fixture(t);
  await f.slice.configureActiveSession(config("medium"));
  f.set({ runningSessions: { one: false } });
  const apply = f.coordination.flushPendingSessionConfiguration("one");
  const change = f.slice.configureActiveSession(config("low"));
  f.calls[0].resolve();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.get().sessions[0].thinkingLevel, "low");
  assert.equal(f.get().sessionConfigurationStatus.one, "applying");
  assert.equal(f.calls[1].config.thinkingLevel, "low");
  f.calls[1].resolve();
  await Promise.all([apply, change]);
  assert.equal(f.get().sessionConfigurationStatus.one, undefined);
});

test("idle edits serialize and failed replacements retain their retry payload", async (t) => {
  const f = fixture(t);
  f.set({ runningSessions: {} });
  const first = f.slice.configureActiveSession(config("medium"));
  assert.equal(f.get().sessionConfigurationStatus.one, "applying");
  const second = f.slice.configureActiveSession(config("low"));
  assert.equal(f.calls.length, 1);
  f.calls[0].resolve();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.get().sessions[0].thinkingLevel, "low");
  assert.equal(f.calls[1].config.thinkingLevel, "low");
  f.calls[1].reject(new Error("offline"));
  await Promise.all([
    assert.rejects(first, /offline/),
    assert.rejects(second, /offline/),
  ]);
  assert.equal(f.get().sessionConfigurationStatus.one, "failed");
  const retry = f.slice.configureActiveSession(config("off"));
  assert.equal(f.calls[2].config.thinkingLevel, "off");
  f.calls[2].reject(new Error("still offline"));
  await assert.rejects(retry, /still offline/);
  assert.equal(f.get().sessionConfigurationStatus.one, "failed");
  assert.equal(f.runtime.pendingSessionConfigurations.get("one").thinkingLevel, "off");
});

test("a deleted session cannot regain its pending notice when an in-flight apply settles", async (t) => {
  const f = fixture(t);
  f.set({ runningSessions: {} });
  const apply = f.slice.configureActiveSession(config("medium"));
  f.set({ sessions: f.get().sessions.filter(session => session.id !== "one"), sessionConfigurationStatus: {} });
  f.calls[0].resolve();
  await assert.rejects(apply);
  assert.equal(f.get().sessionConfigurationStatus.one, undefined);
  assert.equal(f.get().sessions.some(session => session.id === "one"), false);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.runtime.pendingSessionConfigurations.has("one"), false);
  assert.equal(f.calls.length, 1);
});

test("a failed apply keeps the chosen value and an honest failed notice for a later retry", async (t) => {
  const f = fixture(t);
  await f.slice.configureActiveSession(config("medium"));
  f.set({ runningSessions: { one: false } });
  const apply = f.coordination.flushPendingSessionConfiguration("one");
  f.calls[0].reject(new Error("host unavailable"));
  await apply;
  await f.slice.refreshSessions();
  assert.equal(f.get().sessionConfigurationStatus.one, "failed");
  assert.equal(f.get().sessions[0].thinkingLevel, "medium");
  assert.equal(f.runtime.pendingSessionConfigurations.get("one").thinkingLevel, "medium");
  const retry = f.coordination.flushPendingSessionConfiguration("one");
  assert.equal(f.get().sessionConfigurationStatus.one, "applying");
  f.calls[1].resolve();
  await retry;
  assert.equal(f.get().sessionConfigurationStatus.one, undefined);
});
