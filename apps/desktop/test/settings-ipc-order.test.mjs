import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { setImmediate } from "node:timers/promises";
import test from "node:test";
import ts from "typescript";
import { IPC } from "@pi-desktop/shared";
import { binding, dependencies, loadModules, owner, requestId } from "./helpers/live-voice-service-fixture.mjs";

const { outputText } = ts.transpileModule(readFileSync(new URL("../electron/main/ipc/settings-ipc.ts", import.meta.url), "utf8"), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
});
const module = { exports: {} };
new Function("require", "exports", "module", outputText)((id) => {
  if (id === "@pi-desktop/shared") return { IPC };
  if (id === "../network-proxy") return { currentSystemProxyRelayUrl: () => undefined };
  throw new Error(`unexpected settings IPC dependency: ${id}`);
}, module.exports, module);

function register({ hostCall, liveCallService, applyApplicationMenuSettings = () => {} }) {
  const handlers = new Map();
  module.exports.registerSettingsIpc({
    registrar: { handle: (channel, handler) => handlers.set(channel, handler) },
    getHost: () => ({ call: hostCall }),
    getSidecar: () => null,
    dataDir: "/unused",
    normalizeSettings: (value) => value,
    validateSettingsWrite: (value) => value,
    testNetworkProxy: async () => {},
    applyNetworkProxyFromAppSettings: async () => {},
    currentNetworkProxy: () => undefined,
    applyApplicationMenuSettings,
    applyDeveloperMode: () => {},
    applyPreventScreenSleep: () => {},
    applyKeepAwakeWhileRunning: () => {},
    applyUpdatePreference: () => {},
    resolveEffectiveCommandShell: async () => {},
    liveCallService,
  });
  return handlers.get(IPC.invoke.settingsSet);
}

test("saving an unrelated preference keeps the active voice call and microphone reservation", async (t) => {
  const { LiveCallService } = await loadModules(t);
  let service;
  const { deps, state } = dependencies({
    sendControl: (_owner, control) => {
      if (control.kind === "release-media") queueMicrotask(() => service.reportMedia(owner, { callId: control.callId, kind: "released" }));
    },
  });
  service = new LiveCallService(deps);
  t.after(() => service.endForLifecycle("app-quit", owner, true));
  const status = await service.status();
  await service.prepare(owner, { requestId, bindingId: binding.id, expectedSettingsRevision: status.settingsRevision, initialMuted: true });
  assert.equal(service.hasMicrophoneReservation(owner), true);
  const save = register({
    liveCallService: service,
    hostCall: async (method, patch) => {
      if (method === "settings.get") return structuredClone(state.settings);
      assert.equal(method, "settings.set");
      state.settings = { ...state.settings, ...patch };
      return { ok: true };
    },
  });
  await save({ theme: "dark" });
  assert.equal(state.settings.theme, "dark");
  assert.equal(service.hasMicrophoneReservation(owner), true);
});

test("concurrent IPC saves serialize persistence, live settings snapshots and side effects", async () => {
  let settings = { theme: "light" };
  let pending = false;
  let releaseFirst;
  const gate = new Promise((resolve) => { releaseFirst = resolve; });
  const snapshots = [];
  const applied = [];
  const save = register({
    hostCall: async (method, patch) => {
      if (method === "settings.get") return structuredClone(settings);
      if (patch.theme === "dark") await gate;
      settings = { ...settings, ...patch };
      return { ok: true };
    },
    liveCallService: {
      beginSettingsWrite: () => {
        assert.equal(pending, false, "only one settings write may own the voice guard");
        pending = true;
        return () => { pending = false; };
      },
      settingsWritten: async (value) => snapshots.push(value),
    },
    applyApplicationMenuSettings: (value) => applied.push(value),
  });
  const first = save({ theme: "dark" });
  const second = save({ language: "zh-CN" });
  const outcomes = Promise.allSettled([first, second]);
  await setImmediate();
  releaseFirst();
  assert.deepEqual((await outcomes).map((result) => result.status), ["fulfilled", "fulfilled"]);
  assert.deepEqual(snapshots, [{ theme: "dark" }, { theme: "dark", language: "zh-CN" }]);
  assert.deepEqual(applied, [{ theme: "dark" }, { language: "zh-CN" }]);
});

test("a failed IPC save releases its voice guard and lets the next patch persist", async () => {
  let settings = { theme: "light" };
  let pending = false;
  const save = register({
    hostCall: async (method, patch) => {
      if (method === "settings.get") return structuredClone(settings);
      if (patch.theme === "dark") throw new Error("write failed");
      settings = { ...settings, ...patch };
      return { ok: true };
    },
    liveCallService: {
      beginSettingsWrite: () => {
        assert.equal(pending, false);
        pending = true;
        return () => { pending = false; };
      },
      settingsWritten: async () => {},
    },
  });
  const failed = assert.rejects(save({ theme: "dark" }), /write failed/);
  const saved = save({ language: "zh-CN" });
  await Promise.all([failed, saved]);
  assert.deepEqual(settings, { theme: "light", language: "zh-CN" });
  assert.equal(pending, false);
});
