import assert from "node:assert/strict";
import test from "node:test";
import { IPC } from "@pi-desktop/shared";
import { registerProjectResourcesIpc } from "../electron/main/ipc/project-resources-ipc.ts";

function setup(responses = {}) {
  const handlers = new Map();
  const calls = [];
  const refreshes = [];
  const opened = [];
  const host = {
    async call(method, params) {
      calls.push({ method, params });
      const response = responses[method];
      if (response instanceof Error) throw response;
      return response ?? {};
    },
  };
  registerProjectResourcesIpc({
    registrar: { handle: (channel, handler) => handlers.set(channel, handler) },
    getHost: () => host,
    refreshProjectGroups: async (target) => refreshes.push(target),
    openPath: async (path) => {
      opened.push(path);
      return "";
    },
  });
  const invoke = (channel, input) => handlers.get(channel)(input);
  return { invoke, calls, refreshes, host, opened };
}

test("ensure forwards a trimmed group id and template, then refreshes the group snapshot", async () => {
  const group = { id: "g1", roots: [{ path: "/docs/App", kind: "resources" }] };
  const { invoke, calls, refreshes, host } = setup({
    "project.resources.ensure": { group },
  });
  const result = await invoke(IPC.invoke.projectResourcesEnsure, {
    groupId: " g1 ",
    template: " software ",
  });
  assert.deepEqual(result, { group });
  assert.deepEqual(calls, [
    { method: "project.resources.ensure", params: { groupId: "g1", template: "software" } },
  ]);
  assert.deepEqual(refreshes, [host]);
});

test("ensure omits the template so host-core applies its default", async () => {
  const { invoke, calls } = setup();
  await invoke(IPC.invoke.projectResourcesEnsure, { groupId: "g1" });
  assert.deepEqual(calls[0], { method: "project.resources.ensure", params: { groupId: "g1" } });
});

test("ensure rejects malformed requests before reaching host-core", async () => {
  const { invoke, calls, refreshes } = setup();
  for (const input of [
    {},
    { groupId: "  " },
    { groupId: 7 },
    { groupId: "x".repeat(257) },
    { groupId: "g1", template: 3 },
    { groupId: "g1", template: "   " },
  ]) {
    await assert.rejects(invoke(IPC.invoke.projectResourcesEnsure, input), /required|template/);
  }
  assert.equal(calls.length, 0);
  assert.equal(refreshes.length, 0);
});

test("templates are listed by host-core", async () => {
  const listing = { home: "/docs/mc-agent", templates: [{ name: "blank" }] };
  const { invoke } = setup({ "project.resources.templates": listing });
  assert.deepEqual(await invoke(IPC.invoke.projectResourcesTemplates), listing);
});

test("host errors reach the caller unchanged", async () => {
  const { invoke } = setup({ "project.resources.ensure": new Error("template not found: x") });
  await assert.rejects(
    invoke(IPC.invoke.projectResourcesEnsure, { groupId: "g1", template: "x" }),
    /template not found/,
  );
});

test("workspace notes are read and written through host-core", async () => {
  const note = { path: "/code/web", heading: "web", description: "前端" };
  const { invoke, calls } = setup({
    "project.workspaces.notes": { notes: [note] },
    "project.workspaces.setNote": { note },
  });
  assert.deepEqual(await invoke(IPC.invoke.projectWorkspaceNotes, { groupId: " g1 " }), {
    notes: [note],
  });
  await invoke(IPC.invoke.projectWorkspaceNoteSet, {
    groupId: "g1",
    path: " /code/web ",
    description: " 前端 ",
  });
  assert.deepEqual(calls, [
    { method: "project.workspaces.notes", params: { groupId: "g1" } },
    {
      method: "project.workspaces.setNote",
      params: { groupId: "g1", path: "/code/web", description: " 前端 " },
    },
  ]);
});

test("workspace note writes reject malformed requests before reaching host-core", async () => {
  const { invoke, calls } = setup();
  for (const input of [
    { path: "/code/web", description: "x" },
    { groupId: "g1", description: "x" },
    { groupId: "g1", path: "/code/web" },
    { groupId: "g1", path: "/code/web", description: 1 },
    { groupId: "g1", path: "/code/web", description: "x".repeat(8193) },
  ]) {
    await assert.rejects(invoke(IPC.invoke.projectWorkspaceNoteSet, input), /required/);
  }
  assert.equal(calls.length, 0);
});

test("reveal opens only the resource folder host-core has for the project", async () => {
  const groups = [
    { id: "g1", roots: [{ path: "/docs/App", kind: "resources" }, { path: "/code/web" }] },
    { id: "g2", roots: [{ path: "/code/other" }] },
  ];
  const { invoke, opened } = setup({ "project.groups.list": { groups } });
  assert.deepEqual(await invoke(IPC.invoke.projectResourcesReveal, { groupId: "g1" }), { ok: true });
  assert.deepEqual(opened, ["/docs/App"]);
  await assert.rejects(invoke(IPC.invoke.projectResourcesReveal, { groupId: "g2" }), /no resource folder/);
  await assert.rejects(invoke(IPC.invoke.projectResourcesReveal, { groupId: "missing" }), /no resource folder/);
  assert.deepEqual(opened, ["/docs/App"]);
});
