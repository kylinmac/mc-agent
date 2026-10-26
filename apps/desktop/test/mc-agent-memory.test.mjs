import assert from "node:assert/strict";
import test from "node:test";
import { applyRemember } from "../electron/main/mc-agent-memory.ts";

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
