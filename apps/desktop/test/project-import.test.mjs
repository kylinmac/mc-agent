import assert from "node:assert/strict";
import test from "node:test";
import {
  candidateKey,
  filterCandidates,
  groupByProject,
  importedSessionId,
  selectionState,
  selectionSummary,
  toggleItems,
} from "../src/features/project-import/import-model.ts";

// mc-agent: import projects and conversations from other agents (MC-ADR-0009).

const item = (source, id, projectPath, updatedAt, title = id) => ({
  source,
  externalId: id,
  title,
  projectPath,
  model: null,
  createdAt: updatedAt,
  updatedAt,
  messageCount: 3,
});

const candidates = [
  item("claude-code", "a", "/work/app", "2026-10-03T00:00:00Z", "Fix login"),
  item("codex", "b", "/work/app/", "2026-10-05T00:00:00Z"),
  item("pi-desktop", "c", "/work/site", "2026-10-04T00:00:00Z"),
  item("claude-code", "d", null, "2026-10-09T00:00:00Z"),
  item("opencode", "e", "/work/other", "2026-10-09T00:00:00Z"),
];

test("conversations group by project folder, newest project first, no project last", () => {
  const groups = groupByProject(candidates.slice(0, 4));
  assert.deepEqual(groups.map((group) => group.name), ["app", "site", ""]);
  assert.deepEqual(groups[0].items.map((entry) => entry.externalId), ["b", "a"]);
  assert.deepEqual(groups[0].sources, ["claude-code", "codex"]);
  assert.equal(groups[2].path, null);
});

test("only the offered sources are listed, filtered by source and text", () => {
  assert.deepEqual(filterCandidates(candidates, { source: "all", query: "" }).map((entry) => entry.externalId), ["a", "b", "c", "d"]);
  assert.deepEqual(filterCandidates(candidates, { source: "codex", query: "" }).map((entry) => entry.externalId), ["b"]);
  assert.deepEqual(filterCandidates(candidates, { source: "all", query: "LOGIN" }).map((entry) => entry.externalId), ["a"]);
  assert.deepEqual(filterCandidates(candidates, { source: "all", query: "site" }).map((entry) => entry.externalId), ["c"]);
});

test("select all picks every conversation not imported yet, and clears again", () => {
  const offered = candidates.slice(0, 4);
  const imported = new Set([importedSessionId(offered[2])]);
  assert.equal(importedSessionId(offered[2]), "import-pi-desktop-c");
  const all = toggleItems(offered, new Set(), imported);
  assert.equal(all.size, 3);
  assert.ok(!all.has(candidateKey(offered[2])));
  assert.equal(selectionState(offered, all, imported), "all");
  assert.equal(toggleItems(offered, all, imported).size, 0);
  const one = toggleItems([offered[0]], new Set(), imported);
  assert.equal(selectionState(offered, one, imported), "some");
  assert.deepEqual(selectionSummary(offered, all), { sessions: 3, projects: 1 });
});
