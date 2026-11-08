import assert from "node:assert/strict";
import test from "node:test";
import { holdAgentOpen, withAgentInput } from "../electron/main/work-panel-agent/agent-input-gate.ts";

test("links opened by agent input are held back and reported; user clicks open", async () => {
  const contents = {};
  assert.equal(holdAgentOpen(contents, "https://user.example.test"), false);
  const { result, blocked } = await withAgentInput(contents, async () => {
    assert.equal(holdAgentOpen(contents, "https://agent.example.test"), true);
    return "done";
  });
  assert.equal(result, "done");
  // An open request arriving just after the input still counts as the agent's.
  assert.equal(holdAgentOpen(contents, "mailto:late@example.test"), true);
  assert.deepEqual(blocked, ["https://agent.example.test", "mailto:late@example.test"]);
  assert.equal(holdAgentOpen({}, "https://other-panel.example.test"), false);
});

test("a failed agent input still closes the gate", async () => {
  const contents = {};
  await assert.rejects(withAgentInput(contents, async () => { throw new Error("boom"); }), /boom/);
  const realNow = Date.now;
  Date.now = () => realNow() + 2000;
  try {
    assert.equal(holdAgentOpen(contents, "https://user.example.test"), false);
  } finally {
    Date.now = realNow;
  }
});
