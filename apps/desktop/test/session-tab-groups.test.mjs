import assert from "node:assert/strict";
import test from "node:test";
import { groupProjectTabs, groupedEntryId, moveGroupedTab } from "../src/features/session-tabs/tab-groups.ts";
import { buildProjectFolderIndex } from "../src/features/project-sidebar/project-merge.ts";
import { normalizeProjectPath } from "../src/lib/sidebar-session-groups.ts";

test("groups share sidebar multi-folder identity and keep first appearance and tab order", () => {
  const folders = buildProjectFolderIndex([{ id: "one", name: "Project", roots: [
    { path: "/work/resources", kind: "resources" }, { path: "/work/code", kind: "workspace" },
  ] }], normalizeProjectPath, "Resources");
  const sessions = new Map([
    ["a", { id: "a", projectPath: "/work/code/" }],
    ["b", { id: "b", projectPath: "/other/code" }],
    ["c", { id: "c", projectPath: "/work/resources" }],
    ["d", { id: "d" }],
  ]);
  assert.deepEqual(groupProjectTabs(["a", "b", "c", "d", "loading"], sessions, folders, "Ungrouped"), [
    { kind: "project", id: "project:one", title: "Project", keys: ["a", "c"] },
    { kind: "project", id: "path:/other/code", title: "code", keys: ["b"] },
    { kind: "project", id: "ungrouped", title: "Ungrouped", keys: ["d", "loading"] },
  ]);
});

test("same-name local paths and remote hosts never merge by display name", () => {
  const rows = [
    { id: "a", projectPath: "/one/code" }, { id: "b", projectPath: "/two/code" },
    { id: "remote:a", remoteHostKey: "a", remoteProjectId: "p", remoteWorkspaceLabel: "code", projectPath: "/one/code" },
    { id: "remote:b", remoteHostKey: "b", remoteProjectId: "p", remoteWorkspaceLabel: "code" },
    { id: "remote:c", remoteHostKey: "a", remoteProjectId: "p", remoteWorkspaceLabel: "code" },
  ];
  const groups = groupProjectTabs(rows.map(s => s.id), new Map(rows.map(s => [s.id, s])), new Map(), "Ungrouped");
  assert.deepEqual(groups.map(g => g.keys), [["a"], ["b"], ["remote:a", "remote:c"], ["remote:b"]]);
  assert.deepEqual(groupProjectTabs([], new Map(), new Map(), "Ungrouped"), []);
});

test("reordering a project group moves all of its sessions together and keeps internal order", () => {
  const sessions = new Map([
    ["a1", { id: "a1", projectPath: "/alpha" }],
    ["a2", { id: "a2", projectPath: "/alpha" }],
    ["b1", { id: "b1", projectPath: "/beta" }],
    ["c1", { id: "c1", projectPath: "/gamma" }],
    ["c2", { id: "c2", projectPath: "/gamma" }],
  ]);
  const tabs = ["a1", "b1", "a2", "c1", "c2"];
  const entries = groupProjectTabs(tabs, sessions, new Map(), "Ungrouped");
  assert.deepEqual(entries.map(groupedEntryId), [
    "group:path:/alpha",
    "group:path:/beta",
    "group:path:/gamma",
  ]);
  // Interleaved group A moving after B coalesces A's tabs in order at B's trailing edge.
  assert.deepEqual(
    moveGroupedTab(tabs, entries, "group:path:/alpha", "group:path:/beta", true),
    ["b1", "a1", "a2", "c1", "c2"],
  );
  // Dragging A before its immediate right neighbour is a no-op visually and keeps tabs unchanged.
  assert.deepEqual(
    moveGroupedTab(tabs, entries, "group:path:/alpha", "group:path:/beta", false),
    tabs,
  );
  // Last group moves cleanly before the first group.
  assert.deepEqual(
    moveGroupedTab(tabs, entries, "group:path:/gamma", "group:path:/alpha", false),
    ["c1", "c2", "a1", "b1", "a2"],
  );
  // Moving the first group past the last appends all of its tabs at the end.
  assert.deepEqual(
    moveGroupedTab(tabs, entries, "group:path:/alpha", "group:path:/gamma", true),
    ["b1", "c1", "c2", "a1", "a2"],
  );
  assert.deepEqual(moveGroupedTab(tabs, entries, "missing", "group:path:/beta", true), tabs);
});
