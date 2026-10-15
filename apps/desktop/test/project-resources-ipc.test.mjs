import assert from "node:assert/strict";
import test from "node:test";
import { IPC } from "@pi-desktop/shared";
import { registerProjectResourcesIpc } from "../electron/main/ipc/project-resources-ipc.ts";

function setup(responses = {}, { picked = null } = {}) {
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
    openExternal: async (url) => {
      opened.push(url);
    },
    pickFile: async () => picked,
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

test("template edits are shape-checked and templates are revealed by listed name only", async () => {
  const listing = { home: "/h", templates: [{ name: "software", path: "/h/templates/software" }] };
  const { invoke, calls, opened } = setup({
    "project.resources.templates": listing,
    "project.resources.templates.save": listing,
    "project.resources.templates.delete": listing,
  });
  await invoke(IPC.invoke.projectResourcesTemplateSave, {
    template: {
      name: " notes ",
      categories: [{ name: "a", description: "x" }, { name: "b" }],
      create: true,
      copyFrom: "software",
      extra: "dropped",
    },
  });
  assert.deepEqual(calls.at(-1), {
    method: "project.resources.templates.save",
    params: {
      template: {
        name: "notes",
        description: "",
        categories: [
          { name: "a", description: "x" },
          { name: "b", description: "" },
        ],
        create: true,
        copyFrom: "software",
      },
    },
  });
  for (const template of [
    undefined,
    { name: "x" },
    { name: "", categories: [] },
    { name: "x", categories: [{ name: 3 }] },
    { name: "x", categories: [], create: "yes" },
    { name: "x", categories: Array.from({ length: 65 }, (_, i) => ({ name: `c${i}` })) },
  ]) {
    await assert.rejects(invoke(IPC.invoke.projectResourcesTemplateSave, { template }));
  }
  await invoke(IPC.invoke.projectResourcesTemplateDelete, { name: " notes " });
  assert.deepEqual(calls.at(-1), { method: "project.resources.templates.delete", params: { name: "notes" } });

  await invoke(IPC.invoke.projectResourcesTemplateReveal, { name: "software" });
  assert.deepEqual(opened, ["/h/templates/software"]);
  await assert.rejects(invoke(IPC.invoke.projectResourcesTemplateReveal, { name: "../etc" }), /not found/);
  assert.equal(opened.length, 1);
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

test("catalog status changes accept only settable statuses", async () => {
  const { invoke, calls } = setup();
  await invoke(IPC.invoke.projectResourcesSetStatus, { groupId: "g1", key: "folder:a.md", status: "confirmed" });
  for (const status of ["changed", "missing", "", 3]) {
    await assert.rejects(
      invoke(IPC.invoke.projectResourcesSetStatus, { groupId: "g1", key: "folder:a.md", status }),
      /status must be/,
    );
  }
  assert.deepEqual(calls, [
    {
      method: "project.resources.catalog.setStatus",
      params: { groupId: "g1", key: "folder:a.md", status: "confirmed" },
    },
  ]);
});

test("registering a file uses the native picker's path, never one from the renderer", async () => {
  const picked = setup({}, { picked: "/code/web/README.md" });
  await picked.invoke(IPC.invoke.projectResourcesRegisterFile, {
    groupId: "g1",
    category: "reference",
    path: "/etc/passwd",
  });
  assert.deepEqual(picked.calls, [
    {
      method: "project.resources.catalog.registerFile",
      params: { groupId: "g1", path: "/code/web/README.md", category: "reference" },
    },
  ]);
  const canceled = setup({}, { picked: null });
  assert.deepEqual(await canceled.invoke(IPC.invoke.projectResourcesRegisterFile, { groupId: "g1" }), {
    canceled: true,
  });
  assert.equal(canceled.calls.length, 0);
});

test("links must be http(s) to be registered or opened", async () => {
  const { invoke, calls } = setup();
  for (const url of ["file:///etc/passwd", "javascript:alert(1)", ""]) {
    await assert.rejects(
      invoke(IPC.invoke.projectResourcesRegisterUrl, { groupId: "g1", url }),
      /http\(s\) link/,
    );
  }
  assert.equal(calls.length, 0);

  const bad = setup({ "project.resources.catalog.locate": { url: "file:///etc/passwd" } });
  await assert.rejects(bad.invoke(IPC.invoke.projectResourcesOpen, { groupId: "g1", key: "entry:1" }), /http\(s\)/);
  assert.deepEqual(bad.opened, []);

  const good = setup({ "project.resources.catalog.locate": { url: "https://example.com" } });
  await good.invoke(IPC.invoke.projectResourcesOpen, { groupId: "g1", key: "entry:1" });
  const file = setup({ "project.resources.catalog.locate": { path: "/docs/App/requirements/a.md" } });
  await file.invoke(IPC.invoke.projectResourcesOpen, { groupId: "g1", key: "folder:requirements/a.md" });
  assert.deepEqual([...good.opened, ...file.opened], ["https://example.com", "/docs/App/requirements/a.md"]);
});

test("task calls pass only allowlisted operations and known fields", async () => {
  const { invoke, calls } = setup({ "project.tasks.startRun": { task: { id: "t1" } } });
  await invoke(IPC.invoke.projectTasksCall, {
    groupId: "g1",
    operation: "startRun",
    params: { taskId: "t1", revision: 2, sessionId: "s1", startFolder: "/code/web", extra: "dropped" },
  });
  assert.deepEqual(calls, [
    {
      method: "project.tasks.startRun",
      params: { groupId: "g1", taskId: "t1", revision: 2, sessionId: "s1", startFolder: "/code/web" },
    },
  ]);
  for (const operation of ["delete", "__proto__", "", 1]) {
    await assert.rejects(invoke(IPC.invoke.projectTasksCall, { groupId: "g1", operation }), /unknown task operation/);
  }
  await assert.rejects(invoke(IPC.invoke.projectTasksCall, { operation: "list" }), /project group id/);
  assert.equal(calls.length, 1);
});
