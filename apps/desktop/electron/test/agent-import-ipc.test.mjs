import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { register } from "node:module";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
register(pathToFileURL(join(here, "..", "..", "test", "helpers", "ts-import-hooks.mjs")));
const { registerAgentImportIpc } = await import(
  "../main/ipc/agent-import-ipc.ts"
);
const { registerMcpIpc } = await import("../main/ipc/mcp-ipc.ts");
const { IPC } = await import("@pi-desktop/shared");

test("external scans keep execution inputs in Main and bind selections to the displayed scan and project", async () => {
  const handlers = new Map();
  const hostCalls = [];
  const first = Promise.withResolvers();
  const privateServer = {
    source: "cursor-project", sourcePath: "/a/.cursor/mcp.json",
    id: "docs", rawKey: "docs", label: "Docs", transport: "http", disabled: true,
    url: "https://user:private-fixture@example.test/private-fixture?q=private-fixture",
    headers: { Authorization: "private-fixture" }, warnings: [],
  };
  const result = { candidates: [privateServer], sources: [] };
  let calls = 0;
  registerAgentImportIpc({
    registrar: { handle: (channel, fn) => handlers.set(channel, fn) },
    getHost: () => ({ call: async (method, params) => {
      hostCalls.push({ method, params });
      return { server: { ...params.server, headers: { Authorization: "private-fixture" } } };
    } }),
    scanMcp: async () => ++calls === 1 ? first.promise : result,
    scanSkills: async () => ({ candidates: [{
      source: "claude-project", sourcePath: "/a/skills/docs/SKILL.md", rootDir: "/a/skills/docs",
      shape: "dir", id: "docs", name: "Docs", description: "", bytes: 4, warnings: [],
    }], sources: [] }),
    sendToRenderer() {},
  });
  const scan = (projectPath) => handlers.get(IPC.invoke.mcpImportScan)({ projectPath });
  const run = (items, projectPath) => handlers.get(IPC.invoke.mcpImportRun)({ items, projectPath, level: "project" });
  const old = scan("/a");
  const preview = await scan("/a");
  first.resolve(result);
  await old;
  const item = preview.candidates[0];
  assert.ok(item?.selectionId);
  assert.doesNotMatch(JSON.stringify(preview), /private-fixture|Authorization/);
  assert.equal((await run([item], "/b")).failed.length, 1);
  await scan("/b");
  const imported = await run([{ selectionId: item.selectionId, url: "https://elsewhere.test/" }], "/a");
  assert.equal(imported.imported.length, 1);
  assert.doesNotMatch(JSON.stringify(imported), /private-fixture|Authorization/);
  assert.equal(hostCalls[0].params.server.url, privateServer.url);
  assert.deepEqual(hostCalls[0].params.server.headers, privateServer.headers);
  assert.equal(hostCalls[0].params.createOnly, true);
  await scan("/a");
  assert.equal((await run([item], "/a")).failed.length, 1);
  const { candidates } = await handlers.get(IPC.invoke.skillImportScan)({ projectPath: "/a" });
  await handlers.get(IPC.invoke.skillImportRun)({
    level: "project", projectPath: "/a", items: [{ selectionId: candidates[0].selectionId, rootDir: "/b" }],
  });
  assert.equal(hostCalls.length, 2);
  assert.equal(hostCalls[1].params.path, "/a/skills/docs");
});

test("a pasted batch keeps its host when a second IPC arrives after restart", async () => {
  const handlers = new Map();
  const calls = [];
  const queued = Promise.withResolvers();
  const resume = Promise.withResolvers();
  let host = { call: async (_method, { server }) => {
    calls.push(server.id);
    queued.resolve();
    await resume.promise;
    return { server };
  } };
  registerMcpIpc({
    registrar: { handle: (channel, fn) => handlers.set(channel, fn) },
    getHost: () => host, refreshUserMcp: async () => [], currentWorkspacePath: () => null,
    sendToRenderer() {}, describeError: String,
  });
  const paste = handlers.get(IPC.invoke.mcpImport)({
    text: JSON.stringify({ servers: { first: { command: "one" }, second: { command: "two" } } }),
  });
  await queued.promise;
  host = null;
  await assert.rejects(handlers.get(IPC.invoke.mcpList)(), /host unavailable/);
  resume.resolve();
  assert.deepEqual((await paste).failed, []);
  assert.deepEqual(calls, ["first", "second"]);
});

test("an in-flight batch keeps its scan and host; failures return public reason codes", async () => {
  const handlers = new Map();
  const entered = Promise.withResolvers();
  const resume = Promise.withResolvers();
  const calls = [];
  const servers = ["first", "exists", "bad", "after"].map((id) => ({
    source: "codex", sourcePath: "/config", id, rawKey: id, transport: "stdio",
    command: "fixture", args: ["private-fixture"], env: { DOCS_KEY: "private-fixture" },
    disabled: true, warnings: [],
  }));
  const host = { call: async (_method, { server, createOnly }) => {
    calls.push(server);
    assert.equal(createOnly, true);
    if (server.id === "first") { entered.resolve(); await resume.promise; }
    if (server.id === "exists") throw new Error("already exists");
    if (server.id === "bad") throw new Error("private-fixture");
    return { server };
  } };
  let active = host;
  registerAgentImportIpc({
    registrar: { handle: (channel, fn) => handlers.set(channel, fn) },
    getHost: () => active, sendToRenderer() {},
    scanMcp: async () => ({ candidates: servers, sources: [
      { kind: "codex", path: "/config", exists: true, count: 4, error: "private-fixture" },
    ] }),
  });
  const scan = handlers.get(IPC.invoke.mcpImportScan);
  const preview = await scan();
  assert.doesNotMatch(JSON.stringify(preview), /private-fixture/);
  const batch = handlers.get(IPC.invoke.mcpImportRun)({ items: preview.candidates });
  await entered.promise;
  await scan();
  active = null;
  resume.resolve();
  const result = await batch;
  assert.deepEqual(calls.map(({ id }) => id), ["first", "exists", "bad", "after"]);
  assert.ok(calls.every((item) => item.enabled === false && item.level === "global"));
  assert.equal(result.imported.length, 2);
  assert.equal(result.skipped[0].reason, "exists");
  assert.equal(result.failed[0].error, "import-failed");
  assert.doesNotMatch(JSON.stringify(result), /private-fixture/);
});

test("MCP settings list and mutation replies expose edit metadata without saved values", async () => {
  const handlers = new Map();
  const server = {
    id: "docs", label: "Docs", enabled: false, transport: "http",
    url: "https://example.test/private-fixture?token=private-fixture",
    headers: { Authorization: "private-fixture", Extra: "private-fixture" },
  };
  registerMcpIpc({
    registrar: { handle: (channel, fn) => handlers.set(channel, fn) },
    getHost: () => ({ call: async (method) => method === "mcp.list" ? { servers: [server] } : { server } }),
    currentWorkspacePath: () => null, refreshUserMcp: async () => [], sendToRenderer() {},
    userMcp: { refreshStatuses: () => [{ serverId: "docs", state: "failed", message: "private-fixture" }] },
  });
  const listed = await handlers.get(IPC.invoke.mcpList)();
  assert.doesNotMatch(JSON.stringify(listed), /private-fixture/);
  assert.deepEqual(listed.servers[0].headerKeys, ["Authorization", "Extra"]);
  assert.equal(listed.servers[0].urlOrigin, "https://example.test");
  for (const [channel, payload] of [
    [IPC.invoke.mcpUpsert, { id: "docs", transport: "http" }],
    [IPC.invoke.mcpTransfer, { id: "docs" }],
    [IPC.invoke.mcpSetEnabled, { id: "docs", enabled: false }],
    [IPC.invoke.mcpSetScope, { id: "docs", scope: { mode: "global" } }],
  ]) {
    const reply = await handlers.get(channel)(payload);
    assert.deepEqual(reply.server, listed.servers[0]);
  }
});

test("import feedback distinguishes source and host failures and correlates stale rows by position", async () => {
  const handlers = new Map();
  const invoke = (channel, payload) => handlers.get(channel)(payload);
  const servers = ["denied", "invalid", "ok"].map((id) => ({
    source: "codex", sourcePath: "/config", id, rawKey: id, transport: "stdio", command: "fixture", warnings: [],
  }));
  let host = { call: async (_method, { server }) => {
    if (server.id === "denied") throw Object.assign(new Error("private-fixture"), { code: "EACCES" });
    if (server.id === "invalid") throw Object.assign(new Error('MCP_INVALID: header key "already exists private-fixture" is not allowed'), { errorCode: "MCP_INVALID" });
  } };
  registerAgentImportIpc({
    registrar: { handle: (channel, fn) => handlers.set(channel, fn) },
    getHost: () => host, sendToRenderer() {},
    scanMcp: async () => ({ candidates: servers, sources: [
      { kind: "cursor-global", path: "/config", exists: true, count: 0, error: "invalid-json" },
      { kind: "claude-code", path: "/config2", exists: false, count: 0, error: "permission-denied" },
      { kind: "opencode", path: "/config3", exists: true, count: 0, error: "private-fixture" },
    ] }),
    scanSkills: async () => { throw new Error("private-fixture"); },
  });
  const preview = await invoke(IPC.invoke.mcpImportScan);
  assert.deepEqual(preview.sources.map(({ error }) => error), ["invalid-json", "permission-denied", "source-unreadable"]);
  const failedScan = await invoke(IPC.invoke.skillImportScan);
  assert.equal(failedScan.sources[0].error, "scan-failed");
  const [denied, invalid, ok] = preview.candidates;
  const outcome = await invoke(IPC.invoke.mcpImportRun, { items: [ok, denied, { selectionId: "private-fixture" }, invalid] });
  assert.deepEqual(outcome.failed.map(({ requestIndex, error }) => [requestIndex, error]),
    [[1, "permission-denied"], [2, "stale-selection"], [3, "invalid-mcp"]]);
  assert.equal(outcome.skipped.length, 0);
  assert.doesNotMatch(JSON.stringify([failedScan, preview, outcome]), /private-fixture/);
  host = null;
  const offline = await invoke(IPC.invoke.mcpImportRun, { items: [ok] });
  assert.equal(offline.failed[0].error, "host-unavailable");
});
