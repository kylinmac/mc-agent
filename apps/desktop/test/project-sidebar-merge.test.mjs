import assert from "node:assert/strict";
import test from "node:test";
import {
  buildProjectFolderIndex,
  mergeProjectEntries,
  sessionFolderLabel,
} from "../src/features/project-sidebar/project-merge.ts";

const normalize = (path) => (path ? path.replace(/\/+$/, "") : null);
const groups = [
  {
    id: "g1",
    name: "purge-analyze",
    primaryPath: "/docs/projects/purge-analyze",
    roots: [
      { path: "/docs/projects/purge-analyze", name: "purge-analyze", kind: "resources" },
      { path: "/code/purge-analyze", name: "purge-analyze" },
      { path: "/code/server", name: "server" },
    ],
  },
  { id: "legacy:/code/solo", name: "solo", primaryPath: "/code/solo", roots: [{ path: "/code/solo", name: "solo" }] },
  { id: "r", name: "remote", primaryPath: "/srv", roots: [{ path: "/srv", name: "srv" }], remote: { hostKey: "h" } },
];
const index = buildProjectFolderIndex(groups, normalize, "资料");
const entry = (path, sessions, extra = {}) => ({
  path,
  key: normalize(path),
  name: path.split("/").at(-1),
  sessions,
  open: false,
  active: false,
  branch: "main",
  ...extra,
});
const byTime = (a, b) => b.updatedAt - a.updatedAt;

test("folders of one project fold into one entry named after the project", () => {
  const sessions = [
    { id: "a", projectPath: "/docs/projects/purge-analyze", updatedAt: 1 },
    { id: "b", projectPath: "/code/purge-analyze", updatedAt: 3 },
    { id: "c", projectPath: "/code/server/", updatedAt: 2 },
    { id: "d", projectPath: "/code/solo", updatedAt: 4 },
    { id: "e", projectPath: "/elsewhere", updatedAt: 5 },
  ];
  const entries = [
    entry("/code/purge-analyze", [sessions[1]], { active: true }),
    entry("/code/solo", [sessions[3]]),
    entry("/docs/projects/purge-analyze", [sessions[0]], { open: true }),
    entry("/elsewhere", [sessions[4]]),
  ];
  const merged = mergeProjectEntries(entries, sessions, index, normalize, byTime);
  assert.deepEqual(merged.map((item) => item.key), ["/docs/projects/purge-analyze", "/code/solo", "/elsewhere"]);
  const project = merged[0];
  assert.equal(project.name, "purge-analyze");
  assert.equal(project.open && project.active, true);
  assert.equal(project.branch, undefined);
  // The server session shows up although its folder has no sidebar entry.
  assert.deepEqual(project.sessions.map((session) => session.id), ["b", "c", "a"]);
  assert.deepEqual(project.memberKeys, ["/docs/projects/purge-analyze", "/code/purge-analyze", "/code/server"]);
  assert.equal(merged[1].branch, "main");
  assert.deepEqual(merged[2].memberKeys, ["/elsewhere"]);
});

test("a workspace-only entry keeps its path but takes the project's sessions", () => {
  const sessions = [{ id: "a", projectPath: "/docs/projects/purge-analyze", updatedAt: 1 }];
  const [merged] = mergeProjectEntries([entry("/code/server", [])], sessions, index, normalize, byTime);
  assert.equal(merged.path, "/code/server");
  assert.equal(merged.name, "purge-analyze");
  assert.deepEqual(merged.sessions.map((session) => session.id), ["a"]);
});

test("sessions are labeled by start folder only in multi-folder local projects", () => {
  assert.equal(sessionFolderLabel("/docs/projects/purge-analyze", index, normalize).label, "资料");
  assert.equal(sessionFolderLabel("/code/server", index, normalize).label, "server");
  assert.equal(sessionFolderLabel("/code/solo", index, normalize), null);
  assert.equal(sessionFolderLabel("/srv", index, normalize), null);
  assert.equal(sessionFolderLabel(null, index, normalize), null);
});
