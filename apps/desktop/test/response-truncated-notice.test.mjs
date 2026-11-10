import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");

test("a reply cut by the output limit says so and offers Continue", async () => {
  // Before this a length stop was saved as a finished reply with no trace;
  // the turn's last message carries the stop reason and the turn shows it.
  const turn = await read("../src/features/chat/transcript/AssistantTurn.tsx");
  assert.match(turn, /!isActive && summary\.messages\.at\(-1\)\?\.stopReason\?\.reason === "length"/);
  assert.match(turn, /t\("chat\.responseTruncated"\)/);
  assert.match(turn, /sendPrompt\(t\("chat\.continueTruncatedPrompt"\)\)/);
});

test("the response end is logged, and a length stop as a warning", async () => {
  const sidecar = await read("../electron/main/runtime/sidecar.ts");
  assert.match(sidecar, /response_end: \{ level: "info", message: "model response ended", event: "session\.response\.end" \}/);
  assert.match(sidecar, /diagnostic\.kind === "response_end" && Reflect\.get\(diagnostic\.data, "reason"\) === "length"/);
});
