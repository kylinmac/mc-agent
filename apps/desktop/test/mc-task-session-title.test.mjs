/** mc-agent (bugs.md B-011): a task's session is named after the task. */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const board = await readFile(new URL("../src/features/project-workbench/TaskBoard.tsx", import.meta.url), "utf8");

test("the session is renamed to the task title before the prompt goes out", () => {
  const rename = board.indexOf("renameSession(sessionId");
  const send = board.indexOf("sendPrompt(prompt");
  assert.ok(rename > 0 && send > rename, "rename first, so the first-message auto title never applies");
  assert.match(board, /runs > 1 \? t\("mcProject\.taskRunTitle", \{ title: task\.title, n: runs \}\) : task\.title/);
});
