import assert from "node:assert/strict";
import test from "node:test";
import { applyRemember, createRememberTool } from "../electron/main/mc-agent-memory.ts";

const user = { id: "u1", title: "Style", content: "Tabs" };
let counter = 0;
const newId = () => `agent-${++counter}`;

test("a note is added beside the user's entries with an agent id", () => {
  const { entries, outcome } = applyRemember([user], { title: "Releases", content: "Merge only when told." }, newId);
  assert.deepEqual(entries.map((entry) => entry.id), ["u1", "agent-1"]);
  assert.deepEqual(outcome, { action: "saved", title: "Releases", agentNotes: 1 });
});

test("the same title replaces the agent's note, and empty content removes it", () => {
  const start = [user, { id: "agent-x", title: "Releases", content: "old" }];
  const replaced = applyRemember(start, { title: " releases ", content: "new" }, newId);
  assert.equal(replaced.outcome.action, "replaced");
  assert.deepEqual(replaced.entries[1], { id: "agent-x", title: "releases", content: "new" });
  const removed = applyRemember(replaced.entries, { title: "Releases", content: "" }, newId);
  assert.equal(removed.outcome.action, "removed");
  assert.deepEqual(removed.entries, [user]);
});

test("the user's entries are never replaced or removed", () => {
  const replaced = applyRemember([user], { title: "Style", content: "Spaces" }, newId);
  assert.equal(replaced.outcome.action, "saved");
  assert.equal(replaced.entries[0].content, "Tabs");
  const removed = applyRemember([user], { title: "Style", content: "" }, newId);
  assert.equal(removed.outcome.error, "NOT_FOUND");
  assert.deepEqual(removed.entries, [user]);
});

test("bad input and a full memory are refused without changes", () => {
  assert.equal(applyRemember([], { title: "", content: "x" }, newId).outcome.error, "INVALID_ARGUMENT");
  assert.equal(applyRemember([], { title: "t", content: "x".repeat(2001) }, newId).outcome.error, "INVALID_ARGUMENT");
  const full = Array.from({ length: 40 }, (_, index) => ({ id: `agent-${index}`, title: `n${index}`, content: "x" }));
  const refused = applyRemember(full, { title: "one more", content: "x" }, newId);
  assert.equal(refused.outcome.error, "LIMIT_REACHED");
  assert.equal(refused.entries.length, 40);
});

for (const grouped of [false, true]) {
  test(`concurrent Remember calls retain both notes and user memory (${grouped ? "group" : "folder"})`, async () => {
    let memory = { content: "User legacy note", updatedAt: 1 };
    let conflicts = 0;
    const host = {
      async call(method, params) {
        if (method === "session.get") return { session: { projectPath: grouped ? "/alias/project" : "/project" } };
        if (method === "project.group.context") return { context: grouped ? { groupId: "g" } : null };
        const prefix = grouped ? "project.group.memory" : "project.memory";
        if (method === `${prefix}.get`) return { memory: structuredClone(memory) };
        assert.equal(method, `${prefix}.set`);
        if (params.expectedMemory && JSON.stringify(params.expectedMemory) !== JSON.stringify(memory)) {
          conflicts++;
          throw Object.assign(new Error("Memory changed"), { errorCode: "MEMORY_CONFLICT" });
        }
        memory = { content: "", entries: params.entries, updatedAt: memory.updatedAt + 1 };
        return { memory };
      },
    };
    const remember = createRememberTool(() => host);
    const results = await Promise.all(["One", "Two"].map((title) => remember({
      sessionId: title, toolCallId: title, signal: new AbortController().signal, args: { title, content: `Note ${title}` },
    })));
    assert.ok(results.every((result) => result.ok));
    assert.deepEqual(memory.entries.map((entry) => entry.content).sort(), ["Note One", "Note Two", "User legacy note"]);
    assert.equal(conflicts, 1);
  });
}

test("memory retries are bounded and storage errors are not retried", async () => {
  for (const errorCode of ["MEMORY_CONFLICT", "DISK_FULL"]) {
    let writes = 0;
    const remember = createRememberTool(() => ({
      async call(method) {
        if (method === "session.get") return { session: { projectPath: "/project" } };
        if (method === "project.group.context") return { context: null };
        if (method === "project.memory.get") return { memory: { content: "", updatedAt: 1 } };
        assert.equal(method, "project.memory.set");
        writes++;
        throw Object.assign(new Error("Save failed"), { errorCode });
      },
    }));
    const result = await remember({ sessionId: "s", toolCallId: "t", signal: new AbortController().signal, args: { title: "Note", content: "Keep this" } });
    assert.equal(result.ok, false);
    assert.equal(result.errorCode, errorCode === "MEMORY_CONFLICT" ? errorCode : "SAVE_FAILED");
    assert.equal(writes, errorCode === "MEMORY_CONFLICT" ? 3 : 1);
  }
});
