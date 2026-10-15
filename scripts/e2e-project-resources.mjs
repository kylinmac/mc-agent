#!/usr/bin/env node
/**
 * mc-agent resource directories through the real host-core binary
 * workspace descriptions, the resource catalog and project tasks
 * (MC-ADR-0003, validation V12–V20 / V22 / V27 / V29). No model and no Electron: the RPC
 * surface Main calls is driven directly, with an isolated data directory and
 * an isolated mc-agent home (`MC_AGENT_HOME`).
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PROTOCOL_VERSION } from "../packages/shared/dist/protocol.js";
import { Host, resolveHostBinary } from "./e2e/host.mjs";

const temp = realpathSync(mkdtempSync(join(tmpdir(), "mc-project-resources-")));
const home = join(temp, "mc-agent");
const web = join(temp, "web");
const server = join(temp, "server");
const legacy = join(temp, "legacy");
for (const dir of [web, server, legacy]) mkdirSync(dir, { recursive: true });

const results = [];
const record = (id, pass, detail = "") => {
  results.push({ id, pass });
  console.log(`${pass ? "PASS" : "FAIL"} ${id}${detail ? ` — ${detail}` : ""}`);
};

const host = new Host(resolveHostBinary(), join(temp, "data"), { env: { MC_AGENT_HOME: home } });
try {
  await host.start(PROTOCOL_VERSION);

  // V22: a new split project gets a resource directory copied from `software`.
  const { group } = await host.call("project.group.create", { name: "登录项目", folders: [web, server] });
  writeFileSync(join(web, "keep.txt"), "untouched");
  const templates = await host.call("project.resources.templates", {});
  const software = templates.templates.find((template) => template.name === "software");
  const ensured = await host.call("project.resources.ensure", { groupId: group.id, template: "software" });
  const roots = ensured.group.roots;
  const resources = roots[0];
  record(
    "E2E-PROJECT-resources-created-from-template-first",
    resources.kind === "resources" &&
      ensured.group.primaryPath === resources.path &&
      resources.path === join(home, "projects", "登录项目") &&
      software?.categories.join(",") === "architecture,prototype,reference,requirements" &&
      readdirSync(resources.path).filter((name) => !name.startsWith(".")).sort().join(",") ===
        "AGENTS.md,architecture,prototype,reference,requirements,workspaces.md" &&
      roots.slice(1).map((root) => root.path).join(",") === [web, server].join(",") &&
      roots.slice(1).every((root) => root.kind === undefined),
    resources.path,
  );

  // Idempotent: a second ensure keeps the same directory and creates no other.
  const again = await host.call("project.resources.ensure", { groupId: group.id, template: "blank" });
  record(
    "E2E-PROJECT-resources-ensure-is-idempotent",
    again.group.roots[0].path === resources.path && readdirSync(join(home, "projects")).length === 1,
  );

  // The resource root survives a restart and still owns its path.
  await host.restart(PROTOCOL_VERSION);
  const listed = (await host.call("project.groups.list", {})).groups.find((item) => item.id === group.id);
  const context = await host.call("project.group.context", { path: resources.path });
  record(
    "E2E-PROJECT-resources-persist-and-resolve-their-project",
    listed?.roots[0].kind === "resources" && context.context?.groupId === group.id,
  );

  // V29: workspace descriptions live in <resource dir>/workspaces.md.
  const notesFile = join(resources.path, "workspaces.md");
  await host.call("project.workspaces.setNote", { groupId: group.id, path: web, description: "前端，React" });
  await host.call("project.workspaces.setNote", { groupId: group.id, path: server, description: "后端 API" });
  writeFileSync(notesFile, readFileSync(notesFile, "utf8").replace("后端 API", "后端 Rust API") + "\n## 备注\n手写内容\n");
  await host.call("project.workspaces.setNote", { groupId: group.id, path: web, description: "前端，React + Vite" });
  const notes = (await host.call("project.workspaces.notes", { groupId: group.id })).notes;
  const notesText = readFileSync(notesFile, "utf8");
  const launchContext = (await host.call("project.group.context", { path: server })).context;
  const refusedOutside = await host
    .call("project.workspaces.setNote", { groupId: group.id, path: resources.path, description: "x" })
    .then(() => false, () => true);
  record(
    "E2E-PROJECT-workspace-notes-round-trip-and-keep-user-text",
    notes.map((note) => `${note.heading}=${note.description}`).join("|") ===
      "web=前端，React + Vite|server=后端 Rust API" &&
      notesText.includes("## 备注\n手写内容") &&
      launchContext?.notes?.find((note) => note.path === server)?.description === "后端 Rust API" &&
      refusedOutside,
  );

  // R1.3: renaming the project moves its resource folder and every host path.
  const renamed = await host.call("project.group.rename", { groupId: group.id, name: "改名后" });
  const movedTo = join(home, "projects", "改名后");
  const afterRename = (await host.call("project.groups.list", {})).groups.find((item) => item.id === group.id);
  const movedContext = await host.call("project.group.context", { path: movedTo });
  record(
    "E2E-PROJECT-resources-follow-project-rename",
    renamed.resourcesMoved?.from === resources.path &&
      renamed.resourcesMoved?.to === movedTo &&
      !existsSync(resources.path) &&
      readFileSync(join(movedTo, "workspaces.md"), "utf8").includes("后端 Rust API") &&
      afterRename?.primaryPath === movedTo &&
      afterRename?.roots[0].kind === "resources" &&
      movedContext.context?.groupId === group.id,
  );
  resources.path = movedTo;

  // Folder types: a reference folder keeps its label and its description in
  // the launch context, and can be switched back.
  await host.call("project.resources.home.setRootKind", { groupId: group.id, path: server, kind: "reference" });
  const asReference = (await host.call("project.groups.list", {})).groups.find((item) => item.id === group.id);
  const refusedResourcesKind = await host
    .call("project.resources.home.setRootKind", { groupId: group.id, path: asReference.roots[0].path, kind: "reference" })
    .then(() => false, () => true);
  await host.call("project.resources.home.setRootKind", { groupId: group.id, path: server, kind: "workspace" });
  const asWorkspace = (await host.call("project.groups.list", {})).groups.find((item) => item.id === group.id);
  record(
    "E2E-PROJECT-folder-kinds-label-reference-folders",
    asReference.roots.find((root) => root.path === server)?.kind === "reference" &&
      refusedResourcesKind &&
      asWorkspace.roots.find((root) => root.path === server)?.kind === undefined,
  );

  // Editing workspaces cannot drop or demote the resource directory.
  const refusedDrop = await host
    .call("project.group.update", { groupId: group.id, name: "登录项目", folders: [web, server] })
    .then(() => false, () => true);
  const refusedDemote = await host
    .call("project.group.update", {
      groupId: group.id, name: "登录项目", folders: [resources.path, web, server], primary: web,
    })
    .then(() => false, () => true);
  record("E2E-PROJECT-resources-root-cannot-be-dropped-or-demoted", refusedDrop && refusedDemote);

  // V12/V13: the catalog lists the folder, confirms a version and flags edits.
  writeFileSync(join(resources.path, "requirements", "login.md"), "v1");
  const catalog = (method, params = {}) =>
    host.call(`project.resources.catalog.${method}`, { groupId: group.id, ...params });
  const listed1 = await catalog("list");
  await catalog("setStatus", { key: "folder:requirements/login.md", status: "confirmed" });
  const confirmed = (await catalog("list")).items.find((item) => item.key === "folder:requirements/login.md");
  writeFileSync(join(resources.path, "requirements", "login.md"), "v2");
  const listed2 = await catalog("list");
  const link = await catalog("registerUrl", { url: "https://example.com/spec", category: "reference" });
  const file = await catalog("registerFile", { path: join(web, "keep.txt"), category: "reference" });
  const refusedOutsideFile = await catalog("registerFile", { path: join(temp, "data", "pi.sqlite") }).then(
    () => false,
    () => true,
  );
  const refusedTraversal = await catalog("locate", { key: "folder:../../data/pi.sqlite" }).then(
    () => false,
    () => true,
  );
  await catalog("unregister", { key: file.key });
  const listed3 = await catalog("list");
  record(
    "E2E-PROJECT-resource-catalog-confirms-and-flags-changes",
    listed1.items.some((item) => item.key === "folder:requirements/login.md" && item.status === "draft") &&
      listed1.items.every((item) => !["workspaces.md", "AGENTS.md"].includes(item.title)) &&
      confirmed?.status === "confirmed" &&
      listed2.items.find((item) => item.key === "folder:requirements/login.md")?.status === "changed" &&
      listed2.summary.changed === 1 &&
      listed3.items.some((item) => item.key === link.key && item.source === "url") &&
      listed3.items.every((item) => item.key !== file.key) &&
      file.key.startsWith("index:reference/") &&
      !existsSync(join(resources.path, "reference", "keep.txt")) &&
      readFileSync(join(resources.path, "reference", "INDEX.md"), "utf8").includes("https://example.com/spec") &&
      existsSync(join(web, "keep.txt")) &&
      refusedOutsideFile &&
      refusedTraversal,
  );

  // V14–V20: a task run only reaches review; a stopped run blocks the task.
  const tasks = (method, params = {}) =>
    host.call(`project.tasks.${method}`, { groupId: group.id, ...params });
  await catalog("setStatus", { key: "folder:requirements/login.md", status: "confirmed" });
  const { task } = await tasks("create", {
    task: { title: "登录接口", goal: "", acceptance: "测试通过", resources: ["folder:requirements/login.md"] },
  });
  const runSession = async () => {
    const created = await host.call("session.create", { title: "task", mode: "agent", projectPath: server });
    const sessionId = created.session.id;
    const { turnId } = await host.call("session.beginTurn", { sessionId });
    return { sessionId, turnId };
  };
  const first = await runSession();
  const started = (await tasks("startRun", { taskId: task.id, revision: task.revision, sessionId: first.sessionId, startFolder: server })).task;
  const duplicate = await tasks("startRun", {
    taskId: task.id, revision: started.revision, sessionId: first.sessionId, startFolder: server,
  }).then(() => false, () => true);
  const stillRunning = (await tasks("list")).tasks[0].status;
  await host.call("session.endTurn", { turnId: first.turnId, status: "completed" });
  const awaiting = (await tasks("list")).tasks[0];
  const rejected = (await tasks("review", {
    taskId: task.id, revision: awaiting.revision, verdict: "rejected", note: "缺少错误处理",
  })).task;
  const second = await runSession();
  const restarted = (await tasks("startRun", {
    taskId: task.id, revision: rejected.revision, sessionId: second.sessionId, startFolder: server,
  })).task;
  await host.call("session.endTurn", { turnId: second.turnId, status: "aborted" });
  const blocked = (await tasks("list")).tasks[0];
  record(
    "E2E-PROJECT-task-runs-reach-review-and-stops-block",
    started.status === "inProgress" &&
      duplicate &&
      stillRunning === "inProgress" &&
      awaiting.status === "awaitingReview" &&
      rejected.status === "todo" &&
      restarted.runs.length === 2 &&
      blocked.status === "blocked" &&
      blocked.runs[1].outcome === "stopped" &&
      blocked.reviews[0].note === "缺少错误处理",
  );

  // V27: an existing legacy single-folder project is backfilled with `blank`.
  await host.call("projects.create", { path: legacy });
  const legacyGroup = (await host.call("project.groups.list", {})).groups.find(
    (item) => item.primaryPath === legacy,
  );
  const backfilled = await host.call("project.resources.ensure", { groupId: legacyGroup.id });
  record(
    "E2E-PROJECT-resources-backfill-legacy-project-with-blank",
    legacyGroup.legacy === true &&
      backfilled.group.legacy === false &&
      backfilled.group.roots[0].kind === "resources" &&
      readdirSync(backfilled.group.roots[0].path).filter((name) => !name.startsWith(".")).length === 0 &&
      existsSync(join(backfilled.group.roots[0].path, ".mc-agent", "project.json")) &&
      backfilled.group.roots[1].path === legacy,
  );

  // Bad input creates nothing.
  const before = readdirSync(join(home, "projects")).length;
  const { group: other } = await host.call("project.group.create", { name: "Other", folders: [join(temp, "data")] });
  const refusedTemplate = await host
    .call("project.resources.ensure", { groupId: other.id, template: "../escape" })
    .then(() => false, () => true);
  record(
    "E2E-PROJECT-resources-invalid-template-creates-nothing",
    refusedTemplate && readdirSync(join(home, "projects")).length === before,
  );

  record(
    "E2E-PROJECT-resources-workspaces-untouched",
    existsSync(join(web, "keep.txt")) && readdirSync(web).join(",") === "keep.txt",
  );
} catch (error) {
  record("E2E-PROJECT-resources-run", false, error instanceof Error ? error.message : String(error));
} finally {
  await host.stop().catch(() => {});
  rmSync(temp, { recursive: true, force: true });
}

const failed = results.filter((result) => !result.pass).length;
console.log(`\nSummary: ${results.length - failed} / ${results.length} passed`);
process.exit(failed === 0 ? 0 : 1);
