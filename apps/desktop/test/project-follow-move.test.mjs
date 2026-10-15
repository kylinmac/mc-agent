import assert from "node:assert/strict";
import test from "node:test";
import { planResourceMove } from "../src/features/project-workbench/follow-move.ts";

const move = { from: "/docs/mc-agent/projects/Old", to: "/docs/mc-agent/projects/New" };

test("an active or open resource folder is reopened at its new path", () => {
  assert.deepEqual(
    planResourceMove({ workspacePath: "/docs/mc-agent/projects/Old/", openProjectPaths: [] }, move),
    { close: [], activate: move.to },
  );
  assert.deepEqual(
    planResourceMove(
      { workspacePath: "/code/web", openProjectPaths: ["/code/web", "/docs/mc-agent/projects/Old"] },
      move,
    ),
    { close: ["/docs/mc-agent/projects/Old"], activate: move.to },
  );
});

test("nothing changes when the old folder is neither active nor open", () => {
  assert.deepEqual(
    planResourceMove({ workspacePath: "/code/web", openProjectPaths: ["/code/web"] }, move),
    { close: [], activate: null },
  );
});
