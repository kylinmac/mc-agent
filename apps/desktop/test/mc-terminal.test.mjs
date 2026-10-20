import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { IPC } from "@pi-desktop/shared";
import { TerminalManager, resolveShell } from "../electron/main/mc-terminal.ts";
import { registerMcTerminalIpc } from "../electron/main/ipc/mc-terminal-ipc.ts";

function fakePty() {
  const spawned = [];
  const spawn = (shell, args, options) => {
    const listeners = { data: [], exit: [] };
    const pty = {
      shell, args, options, written: [], killed: false, size: [options.cols, options.rows],
      write: (data) => pty.written.push(data),
      resize: (cols, rows) => { pty.size = [cols, rows]; },
      kill: () => { pty.killed = true; },
      onData: (listener) => listeners.data.push(listener),
      onExit: (listener) => listeners.exit.push(listener),
      emit: (data) => listeners.data.forEach((listener) => listener(data)),
      exit: (exitCode) => listeners.exit.forEach((listener) => listener({ exitCode })),
    };
    spawned.push(pty);
    return pty;
  };
  return { spawned, load: async () => spawn };
}

test("each tab owns one shell, reattaches with its replay, and is killed on close", async () => {
  const { spawned, load } = fakePty();
  const events = [];
  const manager = new TerminalManager(
    { onData: (termId, data) => events.push(["data", termId, data]), onExit: (termId) => events.push(["exit", termId]) },
    load,
  );
  const first = await manager.create({ tabId: "t1", cwd: "/w", cols: 1000, rows: 1 });
  assert.equal(spawned[0].options.cwd, "/w");
  assert.deepEqual(spawned[0].size, [500, 2]);
  spawned[0].emit("hello");
  const again = await manager.create({ tabId: "t1", cwd: "/w" });
  assert.equal(again.termId, first.termId);
  assert.equal(again.replay, "hello");
  await manager.create({ tabId: "t2", cwd: "/w" });
  assert.equal(spawned.length, 2);

  manager.write(first.termId, "ls\r");
  assert.deepEqual(spawned[0].written, ["ls\r"]);
  manager.disposeTab("t1");
  assert.equal(spawned[0].killed, true);
  assert.equal(manager.size, 1);

  spawned[1].exit(0);
  assert.equal(manager.size, 0);
  assert.deepEqual(events.at(-1)[0], "exit");
});

test("a tab closed while its shell is starting never gets one", async () => {
  const { spawned, load } = fakePty();
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  const manager = new TerminalManager(
    { onData: () => undefined, onExit: () => undefined },
    async () => {
      await gate;
      return load();
    },
  );
  const creating = manager.create({ tabId: "t1", cwd: "/w" });
  manager.disposeTab("t1");
  release();
  await assert.rejects(creating, /terminal closed/);
  assert.equal(spawned.length, 0);
  assert.equal(manager.size, 0);
});

test("concurrent starts for one tab share a shell, and quitting kills every shell", async () => {
  const { spawned, load } = fakePty();
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  const manager = new TerminalManager(
    { onData: () => undefined, onExit: () => undefined },
    async () => {
      await gate;
      return load();
    },
  );
  const first = manager.create({ tabId: "t1", cwd: "/w" });
  const second = manager.create({ tabId: "t1", cwd: "/w" });
  const other = manager.create({ tabId: "t2", cwd: "/w" });
  release();
  const [a, b] = await Promise.all([first, second, other]);
  assert.equal(a.termId, b.termId);
  assert.equal(spawned.length, 2);

  const pendingQuit = manager.create({ tabId: "t3", cwd: "/w" });
  manager.disposeAll();
  await assert.rejects(pendingQuit, /terminal closed/);
  assert.ok(spawned.every((pty) => pty.killed));
  assert.equal(spawned.length, 2);
  assert.equal(manager.size, 0);
});

test("the login shell comes from $SHELL", () => {
  assert.deepEqual(resolveShell({ SHELL: "/bin/zsh" }), { shell: "/bin/zsh", args: ["-l"] });
});

test("the IPC only opens shells in folders host-core has on record", async () => {
  const folder = mkdtempSync(join(tmpdir(), "mc-term-"));
  const handlers = new Map();
  const { spawned, load } = fakePty();
  const quits = [];
  registerMcTerminalIpc({
    registrar: { handle: (channel, handler) => handlers.set(channel, handler) },
    getHost: () => ({
      call: async (method) =>
        method === "projects.list"
          ? { projects: [] }
          : { groups: [{ roots: [{ path: folder }] }, { remote: {}, roots: [{ path: "/remote" }] }] },
    }),
    onQuit: (dispose) => quits.push(dispose),
    manager: new TerminalManager({ onData: () => undefined, onExit: () => undefined }, load),
  });
  const create = handlers.get(IPC.invoke.terminalCreate);
  await create({ tabId: "t1", cwd: folder });
  assert.equal(spawned.length, 1);
  await assert.rejects(create({ tabId: "t2", cwd: "/etc" }), /not a project folder/);
  await assert.rejects(create({ tabId: "t3", cwd: "/remote" }), /not a project folder/);
  await assert.rejects(create({ tabId: "", cwd: folder }), /tab id required/);
  assert.equal(spawned.length, 1);
  quits[0]();
  assert.equal(spawned[0].killed, true);
});

test("a tab closed while its folder is being checked never gets a shell", async () => {
  const folder = mkdtempSync(join(tmpdir(), "mc-term-"));
  const handlers = new Map();
  const { spawned, load } = fakePty();
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  registerMcTerminalIpc({
    registrar: { handle: (channel, handler) => handlers.set(channel, handler) },
    getHost: () => ({
      call: async (method) => {
        await gate;
        return method === "projects.list" ? { projects: [{ path: folder }] } : { groups: [] };
      },
    }),
    onQuit: () => undefined,
    manager: new TerminalManager({ onData: () => undefined, onExit: () => undefined }, load),
  });
  const creating = handlers.get(IPC.invoke.terminalCreate)({ tabId: "t1", cwd: folder });
  await handlers.get(IPC.invoke.terminalDispose)({ tabId: "t1" });
  release();
  await assert.rejects(creating, /terminal closed/);
  assert.equal(spawned.length, 0);
});
