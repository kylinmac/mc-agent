import assert from "node:assert/strict";
import { register } from "node:module";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
register(pathToFileURL(join(here, "helpers/ts-import-hooks.mjs")));
const { formatElapsed, sessionSubagents } = await import(
  "../src/features/session-info/session-subagents.ts"
);

// mc-agent session info "Subtasks": the conversation's `Task` subagents.

function row(id, fields) {
  return { id, role: "tool", content: "", createdAt: "2026-10-19T00:00:00.000Z", toolCallId: id, ...fields };
}

function task(id, agent, toolStatus, details) {
  return row(id, {
    toolName: "Task",
    toolStatus,
    toolArgs: { agent, description: `do ${id}` },
    ...(details ? { toolResult: { details: { delegationId: `d-${id}`, ...details } } } : {}),
  });
}

test("lists each delegation once with its agent, status and timing", () => {
  const messages = [
    task("a", "success", "success", { status: "completed", startedAt: 1000, completedAt: 6000 }),
    task("b", "fixer", "success", { status: "running", startedAt: 2000 }),
    task("c", "explorer", "running"),
    row("read", { toolName: "Read", toolStatus: "success" }),
    // A delegate's own rows belong to it, not to the parent's list.
    task("nested", "explorer", "success", { status: "completed" }),
  ];
  messages[4].parentToolCallId = "a";
  const list = sessionSubagents(messages, { turnLive: true });
  assert.deepEqual(
    list.map((item) => [item.delegationId, item.agentName, item.status]),
    [["d-a", "success", "completed"], ["d-b", "fixer", "running"], ["c", "explorer", "creating"]],
  );
  assert.equal(list[0].startedAt, 1000);
  assert.equal(list[0].completedAt, 6000);
});

test("lifecycle results settle a delegation, and an ended turn aborts leftovers", () => {
  const messages = [
    task("b", "fixer", "success", { status: "running", startedAt: 2000 }),
    row("stop", {
      toolName: "TaskStop",
      toolStatus: "success",
      toolResult: { details: { stopped: [{ delegationId: "d-b", agent: "fixer", status: "running" }] } },
    }),
  ];
  assert.equal(sessionSubagents(messages, { turnLive: true })[0].status, "stopped");
  assert.equal(sessionSubagents([messages[0]], { turnLive: false })[0].status, "aborted");
});

test("elapsed time reads short", () => {
  assert.equal(formatElapsed(42_000), "42s");
  assert.equal(formatElapsed(185_000), "3m 05s");
  assert.equal(formatElapsed(3_720_000), "1h 02m");
  assert.equal(formatElapsed(-5), "0s");
});
