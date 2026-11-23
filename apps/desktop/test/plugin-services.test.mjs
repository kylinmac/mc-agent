import { readPluginsSourceSync, readMainSourceSync } from "./helpers/source-contracts.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { fork } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const desktopRoot = join(here, "..");
const repoRoot = join(desktopRoot, "../..");
const hostProcessEntry = join(desktopRoot, "electron/main/plugin-host-process.mjs");

register(pathToFileURL(join(here, "helpers/ts-import-hooks.mjs")));
const { PluginRuntime } = await import("../electron/main/plugin-runtime.ts");

const { PluginServiceRestarts } = await import("../electron/main/plugin-service-restarts.ts");
const { McpServerClient } = await import("../electron/main/plugin-mcp.ts");

const hostSrc = readFileSync(hostProcessEntry, "utf8");
const runtimeSrc = readFileSync(join(desktopRoot, "electron/main/plugin-runtime.ts"), "utf8");
const mainSrc = readMainSourceSync();
const apiSrc = readFileSync(join(desktopRoot, "src/lib/api.ts"), "utf8");
const pluginsPageSrc = readPluginsSourceSync();
const protocolSrc = readFileSync(join(repoRoot, "packages/shared/src/protocol.ts"), "utf8");
const enSrc = readFileSync(join(repoRoot, "packages/i18n/src/locales/en/index.ts"), "utf8");

/** Real host process, forked instead of Electron's utilityProcess. */
function forkPluginProcess({ entry }) {
  const child = fork(entry, [], { stdio: ["ignore", "pipe", "pipe", "ipc"] });
  return {
    postMessage: (message) => {
      if (child.connected) child.send(message);
    },
    onMessage: (handler) => child.on("message", handler),
    onExit: (handler) => child.on("exit", (code) => handler(code ?? 0)),
    kill: () => child.kill(),
  };
}

function fakePluginProcess() {
  let onMessage = () => {};
  let onExit = () => {};
  return {
    postMessage: (message) => {
      if (message.t === "init") {
        queueMicrotask(() => onMessage({ t: "res", id: message.id, ok: true, value: null }));
      }
    },
    onMessage: (handler) => { onMessage = handler; },
    onExit: (handler) => { onExit = handler; },
    onLog: () => {},
    kill: () => {},
    emitExit: (code) => onExit(code),
  };
}

function createRuntime(t, spawnProcess = forkPluginProcess) {
  const audits = [];
  const changes = [];
  const runtime = new PluginRuntime({
    hostEntry: hostProcessEntry,
    spawnProcess,
    audit: (entry) => audits.push(entry),
    onServiceChange: (status) => changes.push(status),
  });
  t.after(async () => {
    for (const loaded of runtime.listLoaded()) await runtime.unload(loaded.manifest.id);
  });
  return { runtime, audits, changes };
}

/** A plugin whose single service records every start in `starts`. */
function writeServicePlugin({ permissions = ["background.service"], services, main }) {
  const dir = mkdtempSync(join(tmpdir(), "pi-service-plugin-"));
  const manifest = {
    schemaVersion: 1,
    id: "com.example.service",
    name: "Service Plugin",
    version: "0.0.1",
    main: "main.js",
    permissions,
    contributes: { services: services ?? [{ id: "worker", label: "Worker" }] },
  };
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest), "utf8");
  writeFileSync(join(dir, "main.js"), main, "utf8");
  return { dir, manifest, startsFile: join(dir, "starts") };
}

/** Counts starts in the plugin directory so restarts survive a fresh process. */
const COUNTER_PRELUDE = `
  const { existsSync, readFileSync, writeFileSync } = require("node:fs");
  const { join } = require("node:path");
  const counter = join(__dirname, "starts");
  function countStart() {
    const n = existsSync(counter) ? Number(readFileSync(counter, "utf8")) : 0;
    writeFileSync(counter, String(n + 1), "utf8");
    return n + 1;
  }
`;

async function waitFor(predicate, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = predicate();
    if (value) return value;
    if (Date.now() > deadline) throw new Error("timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

test("a declared service starts in the plugin process and reports running", async (t) => {
  const { dir, startsFile } = writeServicePlugin({
    main: `${COUNTER_PRELUDE}
      module.exports = {
        async onLoad() {
          pi.services.register({
            id: "worker",
            start: async () => { await pi.ui.showToast("started " + countStart()); },
            stop: async () => { await pi.ui.showToast("stopped"); },
          });
        },
      };
    `,
  });
  const { runtime, audits, changes } = createRuntime(t);

  await runtime.loadFromPath(dir);

  assert.deepEqual(runtime.getServiceStates().map((s) => ({ ...s, updatedAt: 0 })), [
    {
      pluginId: "com.example.service",
      serviceId: "worker",
      label: "Worker",
      state: "running",
      restarts: 0,
      updatedAt: 0,
    },
  ]);
  // The worker ran inside the plugin process, not in the broker.
  assert.deepEqual(runtime.drainToasts(), ["started 1"]);
  assert.equal(readFileSync(startsFile, "utf8"), "1");
  assert.deepEqual(
    changes.map((c) => c.state),
    ["starting", "running"],
  );
  const started = audits.find((a) => a.api === "plugin.service.start");
  assert.deepEqual(
    { ok: started.ok, serviceId: started.serviceId },
    { ok: true, serviceId: "worker" },
  );
});

test("a service without background.service never starts", async (t) => {
  const { dir, startsFile } = writeServicePlugin({
    permissions: [],
    main: `${COUNTER_PRELUDE}
      module.exports = {
        async onLoad() {
          pi.services.register({ id: "worker", start: async () => { countStart(); } });
        },
      };
    `,
  });
  const { runtime, audits } = createRuntime(t);

  await runtime.loadFromPath(dir, []);

  assert.deepEqual(runtime.getServiceStates(), []);
  assert.equal(existsSync(startsFile), false);
  const skipped = audits.find((a) => a.api === "plugin.services.skipped");
  assert.equal(skipped.errorCode, "PERMISSION_DENIED");
});

test("registering a service needs an id and a start function", async (t) => {
  const { dir } = writeServicePlugin({
    main: `
      module.exports = {
        async onLoad() {
          for (const bad of [{}, { id: "worker" }, { start: async () => {} }]) {
            try {
              pi.services.register(bad);
              await pi.ui.showToast("accepted");
            } catch (error) {
              await pi.ui.showToast("rejected:" + error.message);
            }
          }
          pi.services.register({ id: "worker", start: async () => {} });
        },
      };
    `,
  });
  const { runtime } = createRuntime(t);

  await runtime.loadFromPath(dir);

  assert.deepEqual(runtime.drainToasts(), [
    "rejected:service.id is required",
    "rejected:service.start must be a function",
    "rejected:service.id is required",
  ]);
  assert.equal(runtime.getServiceStates()[0].state, "running");
});

test("a service that never registered is marked failed, and the plugin stays loaded", async (t) => {
  const { dir } = writeServicePlugin({
    main: `module.exports = { async onLoad() { await pi.ui.showToast("loaded"); } };`,
  });
  const { runtime, audits } = createRuntime(t);

  await runtime.loadFromPath(dir);

  const [status] = runtime.getServiceStates();
  assert.equal(status.state, "failed");
  assert.match(status.message, /worker/);
  assert.ok(runtime.getLoaded("com.example.service"), "plugin must survive a bad service");
  const failed = audits.find((a) => a.api === "plugin.service.start" && a.ok === false);
  assert.equal(failed.errorCode, "NOT_FOUND");
});

test("unloading a plugin stops its service and drops the status row", async (t) => {
  const { dir } = writeServicePlugin({
    main: `${COUNTER_PRELUDE}
      module.exports = {
        async onLoad() {
          pi.services.register({
            id: "worker",
            start: async () => { await pi.ui.showToast("started " + countStart()); },
            stop: async () => { await pi.ui.showToast("stopped"); },
          });
        },
      };
    `,
  });
  const { runtime, audits, changes } = createRuntime(t);

  await runtime.loadFromPath(dir);
  await runtime.unload("com.example.service");

  assert.deepEqual(runtime.drainToasts(), ["started 1", "stopped"]);
  assert.deepEqual(runtime.getServiceStates(), []);
  assert.equal(changes.at(-1).state, "stopped");
  assert.ok(audits.some((a) => a.api === "plugin.service.stop" && a.ok));
});

test("quitting stops plugin hosts as a shutdown, not as a crash", async () => {
  const { dir } = writeServicePlugin({
    main: `${COUNTER_PRELUDE}
      module.exports = {
        async onLoad() {
          pi.services.register({
            id: "worker",
            start: async () => { await pi.ui.showToast("started " + countStart()); },
            stop: async () => { await pi.ui.showToast("stopped"); },
          });
        },
        async onUnload() { await pi.ui.showToast("unloaded"); },
      };
    `,
  });
  const crashes = [];
  const runtime = new PluginRuntime({
    hostEntry: hostProcessEntry,
    spawnProcess: forkPluginProcess,
    onPluginCrash: (info) => crashes.push(info),
  });

  await runtime.loadFromPath(dir);
  await runtime.disposeAll();

  // The exits disposeAll causes must not surface as crashes: that is what used
  // to put an error log and an "unexpectedly stopped" toast on every quit.
  assert.deepEqual(crashes, []);
  assert.deepEqual(runtime.drainToasts(), ["started 1", "stopped", "unloaded"]);
  assert.deepEqual(runtime.getServiceStates(), []);
  assert.deepEqual(runtime.listLoaded(), []);
});

test("quitting is not held open by a plugin that will not unload", async () => {
  const { dir } = writeServicePlugin({
    main: `${COUNTER_PRELUDE}
      module.exports = {
        async onLoad() {
          pi.services.register({ id: "worker", start: async () => { countStart(); } });
        },
        // Never settles: the budget, not the plugin, has to end the wait.
        onUnload() { return new Promise(() => {}); },
      };
    `,
  });
  const crashes = [];
  const runtime = new PluginRuntime({
    hostEntry: hostProcessEntry,
    spawnProcess: forkPluginProcess,
    onPluginCrash: (info) => crashes.push(info),
  });

  await runtime.loadFromPath(dir);
  const startedAt = Date.now();
  await runtime.disposeAll();

  assert.ok(
    Date.now() - startedAt < 6000,
    `disposeAll waited ${Date.now() - startedAt}ms on a wedged onUnload`,
  );
  assert.deepEqual(crashes, []);
  assert.deepEqual(runtime.listLoaded(), []);
});

test("app shutdown tears plugin hosts down", () => {
  const shutdown = mainSrc.slice(
    mainSrc.indexOf('logger.app("lifecycle", "info", "app shutdown")'),
    mainSrc.indexOf("const releaseQuit"),
  );
  // Watchers alone left the child processes to be killed by the quit itself,
  // which the runtime then read as a crash.
  assert.match(shutdown, /plugins\.disposeAll\(\)/);
  assert.doesNotMatch(shutdown, /plugins\.disposeWatchers\(\)/);
  // Awaited, or the app can exit before the hosts have stopped.
  assert.match(shutdown, /allSettled\(\[[^\]]*pluginShutdown/s);
});

test("a crash raises one toast, not one per reporting path", () => {
  const handler = mainSrc.slice(
    mainSrc.indexOf("onPluginCrash: ("),
    mainSrc.indexOf("onServiceChange: ("),
  );
  // The runtime already toasts on this path; a second send duplicated it.
  assert.doesNotMatch(handler, /IPC\.event\.toast/);
  assert.match(runtimeSrc, /showToast\(`Plugin stopped unexpectedly/);
});

for (const stop of ["unload", "disposeAll"]) {
  test(stop + " cancels a restart after the crashed plugin left the loaded registry", async (t) => {
    const { dir, manifest, startsFile } = writeServicePlugin({
      main: COUNTER_PRELUDE + `
        module.exports.onLoad = () => pi.services.register({
          id: "worker",
          start: () => { if (countStart() === 1) setTimeout(() => process.exit(7), 30); },
        });
      `,
    });
    const { runtime, audits } = createRuntime(t);
    await runtime.loadFromPath(dir);
    const scheduled = await waitFor(() => audits.find((entry) => entry.api === "plugin.service.restart.scheduled"));
    assert.deepEqual(runtime.listLoaded(), []);
    if (stop === "unload") await runtime.unload(manifest.id);
    else await runtime.disposeAll();
    await new Promise((resolve) => setTimeout(resolve, scheduled.delayMs + 200));
    assert.equal(readFileSync(startsFile, "utf8"), "1");
    assert.deepEqual(runtime.getServiceStates(), []);
  });
}

test("unloading while a restarted child is spawning stops that child before it registers", async (t) => {
  const { dir, manifest } = writeServicePlugin({
    main: `module.exports.onLoad = () => pi.services.register({
      id: "worker", start: () => { setTimeout(() => process.exit(7), 30); }
    });`,
  });
  const spawning = Promise.withResolvers();
  const release = Promise.withResolvers();
  const exited = Promise.withResolvers();
  let spawns = 0;
  const { runtime } = createRuntime(t, async (options) => {
    if (++spawns === 1) return forkPluginProcess(options);
    spawning.resolve();
    await release.promise;
    const child = forkPluginProcess(options);
    child.onExit(exited.resolve);
    return child;
  });
  await runtime.loadFromPath(dir);
  await spawning.promise;
  try {
    await runtime.unload(manifest.id);
  } finally {
    release.resolve();
  }
  await exited.promise;
  assert.deepEqual(runtime.listLoaded(), []);
  assert.deepEqual(runtime.getServiceStates(), []);
});

test("unload closes pending MCP discovery and ignores a late tool catalog", async (t) => {
  const { dir, manifest } = writeServicePlugin({ permissions: ["mcp.server.local"], services: [], main: "" });
  manifest.contributes.mcpServers = [{ id: "books", transport: "stdio", command: "node", args: ["./server.js"] }];
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest));
  const discovering = Promise.withResolvers();
  const reply = Promise.withResolvers();
  t.mock.method(McpServerClient.prototype, "connect", () => {
    discovering.resolve();
    return reply.promise;
  });
  const close = t.mock.method(McpServerClient.prototype, "close");
  const { runtime } = createRuntime(t);
  const stopped = assert.rejects(runtime.loadFromPath(dir), /plugin stopped/);
  await discovering.promise;
  try {
    await runtime.unload(manifest.id);
    assert.equal(close.mock.callCount(), 1);
  } finally {
    reply.resolve([{ name: "ListBooks", inputSchema: { type: "object" } }]);
  }
  await stopped;
  assert.deepEqual(runtime.getTools(), []);
  assert.deepEqual(runtime.listLoaded(), []);
});

test("a crash during the restarted service's start preserves the next retry", async (t) => {
  const { dir, startsFile } = writeServicePlugin({
    main: COUNTER_PRELUDE + `
      module.exports.onLoad = () => pi.services.register({
        id: "worker", start: () => {
          const n = countStart();
          if (n === 1) setTimeout(() => process.exit(7), 30);
          if (n === 2) process.exit(7);
        }
      });
    `,
  });
  const { runtime, audits } = createRuntime(t);
  await runtime.loadFromPath(dir);
  await waitFor(() => runtime.getServiceStates().some((service) => service.state === "running" && service.restarts === 2));
  assert.equal(readFileSync(startsFile, "utf8"), "3");
  assert.deepEqual(audits.filter((entry) => entry.api === "plugin.service.restart.scheduled").map((entry) => entry.attempt), [1, 2]);
});

test("a crashed host process is restarted with backoff and the restart is counted", async (t) => {
  const { dir, startsFile } = writeServicePlugin({
    main: `${COUNTER_PRELUDE}
      module.exports = {
        async onLoad() {
          pi.services.register({
            id: "worker",
            start: async () => {
              // Die once, right after the broker was told the service is up.
              if (countStart() === 1) {
                setTimeout(() => {
                  process.stderr.write("fixture older line\\nfixture service worker died");
                  process.exit(7);
                }, 30);
              }
            },
          });
        },
      };
    `,
  });
  const { runtime, audits } = createRuntime(t);

  await runtime.loadFromPath(dir);
  const failed = await waitFor(() =>
    runtime.getServiceStates().find((s) => s.state === "failed"),
  );
  // The exit code is the safe diagnosis: plugin output is not copied into
  // user-visible errors or crash audit records.
  assert.equal(failed.message, "plugin host process exited (exit code 7)");

  const crash = await waitFor(() =>
    audits.find((a) => a.api === "plugin.crash"),
  );
  assert.equal(crash.exitCode, 7);
  assert.equal("message" in crash, false);

  const scheduled = await waitFor(() =>
    audits.find((a) => a.api === "plugin.service.restart.scheduled"),
  );
  // First backoff step is the base delay; attempts grow it from there.
  assert.deepEqual({ attempt: scheduled.attempt, delayMs: scheduled.delayMs }, {
    attempt: 1,
    delayMs: 1000,
  });

  const running = await waitFor(() =>
    runtime.getServiceStates().find((s) => s.state === "running"),
  );
  assert.equal(running.restarts, 1);
  assert.equal(readFileSync(startsFile, "utf8"), "2");
  assert.ok(audits.some((a) => a.api === "plugin.service.restart" && a.ok));
});

test("Windows hard-fault exit codes stay unsigned across crash surfaces", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "pi-crash-format-plugin-"));
  writeFileSync(
    join(dir, "manifest.json"),
    JSON.stringify({
      schemaVersion: 1,
      id: "com.example.crash-format",
      name: "Crash Format Plugin",
      version: "0.0.1",
      main: "main.js",
      permissions: [],
      contributes: {},
    }),
    "utf8",
  );
  writeFileSync(join(dir, "main.js"), "module.exports = {};", "utf8");
  let child;
  const audits = [];
  const crashes = [];
  const runtime = new PluginRuntime({
    hostEntry: hostProcessEntry,
    spawnProcess: () => {
      child = fakePluginProcess();
      return child;
    },
    audit: (entry) => audits.push(entry),
    onPluginCrash: (info) => crashes.push(info),
  });
  t.after(() => runtime.disposeAll());

  await runtime.loadFromPath(dir);
  child.emitExit(-1073741819);

  const crash = audits.find((entry) => entry.api === "plugin.crash");
  assert.equal(crash.exitCode, 3221225477);
  assert.equal(crash.exitCodeHex, "0xC0000005");
  assert.equal(crashes[0].exitCode, 3221225477);
  assert.equal(crashes[0].exitCodeHex, "0xC0000005");
});

test("autoRestart:false leaves a crashed service down", async (t) => {
  const { dir, startsFile } = writeServicePlugin({
    services: [{ id: "worker", label: "Worker", autoRestart: false }],
    main: `${COUNTER_PRELUDE}
      module.exports = {
        async onLoad() {
          pi.services.register({
            id: "worker",
            start: async () => { countStart(); setTimeout(() => process.exit(7), 30); },
          });
        },
      };
    `,
  });
  const { runtime, audits } = createRuntime(t);

  await runtime.loadFromPath(dir);
  await waitFor(() => runtime.getServiceStates().find((s) => s.state === "failed"));
  await new Promise((resolve) => setTimeout(resolve, 1500));

  assert.equal(readFileSync(startsFile, "utf8"), "1");
  assert.equal(
    audits.some((a) => a.api?.startsWith("plugin.service.restart")),
    false,
  );
  assert.equal(runtime.getServiceStates()[0].state, "failed");
});

test("supervision bounds retries and a healthy process starts a fresh retry budget", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const restarts = new PluginServiceRestarts();
  const resumed = [];
  for (const delay of [1000, 2000, 4000, 8000, 16000]) {
    const expectedAttempt = resumed.length + 1;
    const scheduled = restarts.schedule("a", (attempt) => resumed.push(attempt));
    assert.deepEqual(scheduled, { attempt: expectedAttempt, delayMs: delay });
    t.mock.timers.tick(delay);
    assert.equal(resumed.at(-1), expectedAttempt);
  }
  assert.equal(restarts.schedule("a", () => assert.fail("over limit")), undefined);
  restarts.healthy("a");
  t.mock.timers.tick(60_000);
  assert.equal(restarts.attempts("a"), 0);
  assert.equal(restarts.schedule("a", () => assert.fail("cancelled"))?.attempt, 1);
  restarts.cancelAll();
  t.mock.timers.tick(60_000);
});

test("the plugin process owns service callables and forgets them on unload", () => {
  const startCase = hostSrc.slice(hostSrc.indexOf('case "service.start"'));
  // Starting an already-running service must be a no-op, not a second worker.
  assert.match(startCase, /alreadyRunning/);
  const unloadCase = hostSrc.slice(hostSrc.indexOf('case "lifecycle.unload"'));
  assert.match(unloadCase, /services\.clear\(\)/);
  // Registration is local bookkeeping: the broker decides when a service runs.
  assert.doesNotMatch(hostSrc, /"services\.register"/);
});

test("service status reaches the renderer over its own channel", () => {
  assert.match(protocolSrc, /pluginServices: "pi-desktop\/plugin\/services"/);
  assert.match(mainSrc, /IPC\.invoke\.pluginServices/);
  assert.match(mainSrc, /plugins\.getServiceStates\(\)/);
  assert.match(mainSrc, /reason: "service"/);
  assert.match(apiSrc, /listPluginServices/);
});

test("the plugins page keeps capability and service chips in row details", () => {
  assert.match(pluginsPageSrc, /<CapabilityChips capabilities=\{plugin\.capabilities\} \/>/);
  assert.match(pluginsPageSrc, /<ServiceChips statuses=\{services\} \/>/);
  assert.match(pluginsPageSrc, /<details className="plugins-row-details">/);
  assert.match(
    pluginsPageSrc,
    /<PluginRowDetails[\s\S]*?services=\{servicesByPlugin\.get\(plugin\.id\)\}/,
  );
  assert.match(pluginsPageSrc, /\.listPluginServices\(\)/);
  assert.match(pluginsPageSrc, /api\.onPluginChanged\(refresh\)/);
  for (const key of ["serviceState", "serviceRestarts", "capabilities"]) {
    assert.match(pluginsPageSrc, new RegExp(`plugins\\.${key}`));
    assert.match(enSrc, new RegExp(`${key}:`));
  }
});

test("capability badges include every declared plugin capability", () => {
  const block = pluginsPageSrc.match(
    /const CAPABILITY_ORDER: PluginCapability\[\] = \[([\s\S]*?)\];/,
  )?.[1];
  assert.ok(block, "capability badge order is missing");
  const order = [...block.matchAll(/"([^"]+)"/g)].map((match) => match[1]);
  assert.deepEqual(order, [
    "panel",
    "views",
    "rendererUi",
    "composerTransform",
    "commands",
    "tools",
    "agentExtension",
    "skills",
    "themes",
    "mcp",
    "services",
    "bus",
  ]);
});

test("the session:activated scope filter derives from the announced session's project", async (t) => {
  const { sessionEventScopeFilter, SESSION_SCOPED_EVENTS } = await import(
    "../electron/main/plugin-session-scope.ts"
  );
  const sessionProjects = new Map([["s-a", "/work/a"]]);
  const activeInProject = (pluginId, projectPath) =>
    projectPath === "/work/a" && pluginId === "demo.in-scope";

  // A selection event produces a filter that keys on the announced session's
  // project: the in-scope plugin passes, another project's plugin does not.
  const filter = sessionEventScopeFilter(
    "session:activated",
    "s-a",
    sessionProjects,
    activeInProject,
  );
  assert.equal(typeof filter, "function");
  assert.equal(filter("demo.in-scope"), true);
  assert.equal(filter("demo.out-of-scope"), false);

  // A session without a project checks against null, not against whatever
  // the map happens to hold for another session.
  const noProject = sessionEventScopeFilter(
    "session:activated",
    "s-global",
    sessionProjects,
    activeInProject,
  );
  assert.equal(noProject("demo.in-scope"), false, "null project is passed through, not the map's value");

  // Other session events fan out unconditionally.
  assert.equal(
    sessionEventScopeFilter("session:turnEnded", "s-a", sessionProjects, activeInProject),
    undefined,
  );
  assert.ok(SESSION_SCOPED_EVENTS.has("session:activated"));
});
