import assert from "node:assert/strict";
import test from "node:test";
import { register } from "node:module";
register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { continuedAskFromMessage } = await import("../src/lib/ask-tool-history.ts");

const request = {
  requestId: "question-1", toolCallId: "tool-1", sessionId: "untrusted-target",
  autoContinued: true,
  questions: [{ question: "Choose layout", options: ["Compact", { label: "Wide" }], recommendedOption: "Compact" }],
};
const message = { toolName: "asktool", toolResult: { details: { request } } };

test("persisted timeout options survive reload and use the containing transcript's session", () => {
  const rebuilt = continuedAskFromMessage(JSON.parse(JSON.stringify(message)), "original-session");
  assert.equal(rebuilt.sessionId, "original-session");
  assert.equal(rebuilt.autoContinued, true);
  assert.deepEqual(rebuilt.questions[0].options, request.questions[0].options);
  assert.equal(rebuilt.questions[0].recommendedOption, "Compact");
});

test("normal, unrelated and malformed tool results do not expose a late reply card", () => {
  assert.equal(continuedAskFromMessage(message, undefined), undefined);
  assert.equal(continuedAskFromMessage({ ...message, toolName: "Bash" }, "s"), undefined);
  for (const invalid of [{ ...request, autoContinued: false }, { ...request, questions: [] }, { ...request, questions: [{ question: "q", options: [null] }] }]) {
    assert.equal(continuedAskFromMessage({ toolName: "asktool", toolResult: { details: { request: invalid } } }, "s"), undefined);
  }
});
