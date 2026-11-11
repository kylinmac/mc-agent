import assert from "node:assert/strict";
import test from "node:test";
import { groupProjectTabs } from "../src/features/session-tabs/tab-groups.ts";
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
  assert.deepEqual(groupProjectTabs(["a", "page:creative", "b", "c", "d", "loading"], sessions, folders, "Ungrouped"), [
    { kind: "project", id: "project:one", title: "Project", keys: ["a", "c"] },
    { kind: "tab", key: "page:creative" },
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
