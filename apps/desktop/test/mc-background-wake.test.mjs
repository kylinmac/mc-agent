import assert from "node:assert/strict";
import test from "node:test";
import { backgroundNotice, createBackgroundWake } from "../electron/main/mc-background-wake.ts";

function harness({ turns = new Map(), steerAccepts = true, promptBusy = false } = {}) {
  let tasks = [];
  const calls = [];
  const wake = createBackgroundWake({
    listTasks: async () => tasks,
    output: async (id) => ({ stdout: `out of ${id}\n`, stderr: "" }),
    activeTurn: (sessionId) => turns.get(sessionId),
    steer: async (sessionId, turnId, content) => {
      calls.push({ kind: "steer", sessionId, turnId, content });
      return { accepted: steerAccepts };
    },
    prompt: async (sessionId, content) => {
      calls.push({ kind: "prompt", sessionId, content });
      if (promptBusy) throw new Error("AGENT_BUSY");
    },
    queue: async (sessionId, content) => {
      calls.push({ kind: "queue", sessionId, content });
    },
    log: () => {},
    delayMs: 60_000,
  });
  return {
    calls,
    wake,
    set: async (next) => {
      tasks = next;
      await wake.changed();
    },
  };
}

const task = (id, state, fields = {}) => ({ id, sessionId: "s1", command: `cmd ${id}`, state, ...fields });

test("a command that ends on its own starts a turn in an idle session", async () => {
  const { calls, wake, set } = harness();
  await set([task("a", "running")]);
  await set([task("a", "exited", { exitCode: 1 })]);
  await wake.flush();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].kind, "prompt");
  assert.match(calls[0].content, /Automatic notice, not a message from the user/);
  assert.match(calls[0].content, /`cmd a` exited with code 1 \(backgroundId a\)/);
  assert.match(calls[0].content, /out of a/);
  wake.dispose();
});

test("a running turn gets the notice as steering; otherwise it waits in the queue", async () => {
  const turns = new Map([["s1", "t1"]]);
  const accepted = harness({ turns });
  await accepted.set([task("a", "running")]);
  await accepted.set([task("a", "failed")]);
  await accepted.wake.flush();
  assert.deepEqual(accepted.calls.map((call) => [call.kind, call.turnId]), [["steer", "t1"]]);

  const refused = harness({ turns, steerAccepts: false });
  await refused.set([task("a", "running")]);
  await refused.set([task("a", "exited", { exitCode: 0 })]);
  await refused.wake.flush();
  assert.deepEqual(refused.calls.map((call) => call.kind), ["steer", "queue"]);

  const busy = harness({ promptBusy: true });
  await busy.set([task("a", "running")]);
  await busy.set([task("a", "exited", { exitCode: 0 })]);
  await busy.wake.flush();
  assert.deepEqual(busy.calls.map((call) => call.kind), ["prompt", "queue"]);
});

test("stopped commands, ones over before startup and repeats are not reported", async () => {
  const { calls, wake, set } = harness();
  await set([task("old", "exited", { exitCode: 0 }), task("a", "running"), task("b", "running")]);
  await set([task("old", "exited", { exitCode: 0 }), task("a", "stopped"), task("b", "running")]);
  await set([task("old", "exited", { exitCode: 0 }), task("a", "stopped"), task("b", "running")]);
  await wake.flush();
  assert.equal(calls.length, 0);
});

test("ends close together go out as one notice per session; a fast failure still counts", async () => {
  const { calls, wake, set } = harness();
  await set([task("a", "running")]);
  await set([task("a", "exited", { exitCode: 0 }), task("quick", "failed", { exitCode: 127 })]);
  await wake.flush();
  assert.equal(calls.length, 1);
  assert.match(calls[0].content, /`cmd a`/);
  assert.match(calls[0].content, /`cmd quick` failed \(exit code 127\)/);
});

test("a session that keeps waking is held back", async () => {
  const { calls, wake, set } = harness();
  await set([]);
  for (let index = 0; index < 7; index += 1) {
    await set([task(`t${index}`, "exited", { exitCode: 1 })]);
    await wake.flush();
  }
  assert.equal(calls.length, 5);
});

test("the notice clips long commands and output from the right ends", () => {
  const text = backgroundNotice([{ task: task("x", "exited", { exitCode: 0, command: "y".repeat(500) }), tail: `${"z".repeat(5000)}END` }]);
  assert.match(text, /y{200}…/);
  assert.match(text, /…z+END/);
  assert.ok(text.length < 3_000);
});
