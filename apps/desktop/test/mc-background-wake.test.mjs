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

test("prompt failure falling back to queue delivers once without retrying", async () => {
  let tasks = [];
  const calls = [];
  const wake = createBackgroundWake({
    listTasks: async () => tasks,
    output: async () => ({ stdout: "ok", stderr: "" }),
    activeTurn: () => undefined,
    steer: async () => ({ accepted: false }),
    prompt: async () => {
      calls.push("prompt");
      throw new Error("host busy");
    },
    queue: async () => {
      calls.push("queue");
    },
    log: () => {},
    delayMs: 60_000,
    retryDelayMs: 10,
  });
  tasks = [task("a", "running")];
  await wake.changed();
  tasks = [task("a", "exited", { exitCode: 0 })];
  await wake.changed();
  await wake.flush();
  assert.deepEqual(calls, ["prompt", "queue"]);
  await wake.changed();
  await wake.flush();
  assert.deepEqual(calls, ["prompt", "queue"]);
  wake.dispose();
});

test("both prompt and queue failing schedules bounded retry and preserves rate-limit budget", async () => {
  let tasks = [];
  let failDeliveries = true;
  const delivered = [];
  const wake = createBackgroundWake({
    listTasks: async () => tasks,
    output: async () => ({ stdout: "ok", stderr: "" }),
    activeTurn: () => undefined,
    steer: async () => ({ accepted: false }),
    prompt: async (_sessionId, content) => {
      if (failDeliveries) throw new Error("host down");
      delivered.push(content);
    },
    queue: async () => {
      if (failDeliveries) throw new Error("queue down");
    },
    log: () => {},
    delayMs: 60_000,
    retryDelayMs: 15,
  });
  tasks = [task("a", "running")];
  await wake.changed();
  tasks = [task("a", "exited", { exitCode: 0 })];
  await wake.changed();
  await wake.flush();
  assert.equal(delivered.length, 0);

  failDeliveries = false;
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(delivered.length, 1, "retry timer delivers after transient double failure");
  await wake.changed();
  await wake.flush();
  assert.equal(delivered.length, 1, "already delivered task does not duplicate");

  // Failed delivery must not have consumed any of the 5-wake rate-limit quota.
  for (let i = 0; i < 4; i += 1) {
    tasks = [...tasks, task(`extra-${i}`, "exited", { exitCode: 0 })];
    await wake.changed();
    await wake.flush();
  }
  assert.equal(delivered.length, 5);
  wake.dispose();
});

test("persistent delivery failure stops at maxAttempts and dispose cancels pending retry timer", async () => {
  let tasks = [];
  let attempts = 0;
  const logs = [];
  const wake = createBackgroundWake({
    listTasks: async () => tasks,
    output: async () => ({ stdout: "", stderr: "" }),
    activeTurn: () => undefined,
    steer: async () => ({ accepted: false }),
    prompt: async () => {
      attempts += 1;
      throw new Error("offline");
    },
    queue: async () => {
      throw new Error("offline");
    },
    log: (msg) => logs.push(msg),
    delayMs: 60_000,
    retryDelayMs: 10,
    maxAttempts: 3,
  });
  tasks = [task("a", "running")];
  await wake.changed();
  tasks = [task("a", "exited", { exitCode: 1 })];
  await wake.changed();
  await wake.flush();
  await new Promise((resolve) => setTimeout(resolve, 120));
  assert.equal(attempts, 3);
  assert.ok(logs.some((msg) => msg.includes("reached max retries (3)")));
  wake.dispose();

  // Verify dispose() cancels an active retry timer before it fires.
  let disposedAttempts = 0;
  const wake2 = createBackgroundWake({
    listTasks: async () => tasks,
    output: async () => ({ stdout: "", stderr: "" }),
    activeTurn: () => undefined,
    steer: async () => ({ accepted: false }),
    prompt: async () => {
      disposedAttempts += 1;
      throw new Error("offline");
    },
    queue: async () => {
      throw new Error("offline");
    },
    log: () => {},
    delayMs: 60_000,
    retryDelayMs: 30,
  });
  tasks = [task("b", "running")];
  await wake2.changed();
  tasks = [task("b", "failed")];
  await wake2.changed();
  await wake2.flush();
  assert.equal(disposedAttempts, 1);
  wake2.dispose();
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(disposedAttempts, 1);
});

test("overlapping batch timer during slow delivery serializes flush instead of running concurrently (#152)", async () => {
  let tasks = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const delivered = [];
  let releaseFirst;
  let markFirstStarted;
  const firstStarted = new Promise((resolve) => {
    markFirstStarted = resolve;
  });
  const firstGate = new Promise((resolve) => {
    releaseFirst = resolve;
  });

  const wake = createBackgroundWake({
    listTasks: async () => tasks,
    output: async () => ({ stdout: "", stderr: "" }),
    activeTurn: () => undefined,
    steer: async () => ({ accepted: false }),
    prompt: async (_sessionId, content) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      try {
        if (delivered.length === 0) {
          delivered.push("first:" + content);
          markFirstStarted();
          await firstGate;
        } else {
          delivered.push("next:" + content);
        }
      } finally {
        inFlight -= 1;
      }
    },
    queue: async () => {},
    log: () => {},
    delayMs: 10,
  });

  tasks = [task("t1", "running"), task("t2", "running")];
  await wake.changed();
  tasks = [task("t1", "exited", { exitCode: 0 }), task("t2", "running")];
  await wake.changed();

  const firstFlush = wake.flush();
  await firstStarted;

  tasks = [task("t1", "exited", { exitCode: 0 }), task("t2", "exited", { exitCode: 0 })];
  await wake.changed();
  await new Promise((resolve) => setTimeout(resolve, 35));
  assert.equal(delivered.length, 1, "second flush must wait until in-flight delivery finishes");

  releaseFirst();
  await firstFlush;
  assert.equal(maxInFlight, 1);
  assert.equal(delivered.length, 2);
  assert.ok(delivered[0].includes("backgroundId t1"));
  assert.ok(delivered[1].includes("backgroundId t2"));
  wake.dispose();
});
