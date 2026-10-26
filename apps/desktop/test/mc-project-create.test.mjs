import assert from "node:assert/strict";
import { mkdtemp, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  checkProjectLocation,
  createCreateProjectTool,
  createProjectProposalBroker,
  createProjectTemplatesTool,
  loadProjectLocations,
  saveProjectLocations,
  makeProjectFolder,
  removeCreatedProjectFolder,
  suggestedParents,
} from "../electron/main/mc-project-create.ts";
import { projectProposalDecisionOf } from "../electron/main/mc-project-create.ts";

function fakeHost({ templates = ["software", "blank"], prompts = [] } = {}) {
  return {
    call: async (method) => {
      if (method === "project.resources.templates") {
        return { templates: templates.map((name) => ({ name, target: "resources" })) };
      }
      if (method === "mcPrompts.get") return { config: { templates: prompts } };
      if (method === "project.groups.list") return { groups: [] };
      throw new Error(`unexpected ${method}`);
    },
  };
}

const args = { name: "Ledger", parent: "/tmp", folder: "ledger", templates: ["software"] };

test("CreateProject waits for the user's answer and returns it", async () => {
  const broker = createProjectProposalBroker();
  const seen = [];
  broker.subscribe((proposals) => seen.push(proposals.length));
  const tool = createCreateProjectTool(() => fakeHost(), broker);
  const running = tool({ sessionId: "s1", toolCallId: "t1", args, signal: new AbortController().signal });
  await new Promise((resolve) => setImmediate(resolve));
  const [proposal] = broker.list();
  assert.equal(proposal.sessionId, "s1");
  assert.equal(proposal.parent, "/tmp");
  assert.deepEqual(proposal.templates, ["software"]);
  const decision = { outcome: "created", name: "Ledger", path: "/tmp/ledger", primaryPath: "/tmp/ledger", folderCreated: true };
  assert.equal(broker.resolve(proposal.requestId, decision), true);
  const result = await running;
  assert.equal(result.ok, true);
  assert.equal(result.content.outcome, "created");
  assert.deepEqual(seen, [1, 0]);
  assert.equal(broker.resolve(proposal.requestId, decision), false, "answered once");
});

test("a stopped turn withdraws the card", async () => {
  const broker = createProjectProposalBroker();
  const controller = new AbortController();
  const running = createCreateProjectTool(() => fakeHost(), broker)({
    sessionId: "s1",
    toolCallId: "t1",
    args,
    signal: controller.signal,
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(broker.list().length, 1);
  controller.abort();
  const result = await running;
  assert.equal(result.errorCode, "CANCELLED");
  assert.equal(broker.list().length, 0);
});

test("unknown templates and prompt templates go back to the model", async () => {
  const broker = createProjectProposalBroker();
  const tool = createCreateProjectTool(() => fakeHost(), broker);
  const signal = new AbortController().signal;
  const unknown = await tool({ sessionId: "s", toolCallId: "t", args: { ...args, templates: ["nope"] }, signal });
  assert.equal(unknown.errorCode, "UNKNOWN_TEMPLATE");
  const prompt = await tool({ sessionId: "s", toolCallId: "t", args: { ...args, promptTemplateId: "x" }, signal });
  assert.equal(prompt.errorCode, "UNKNOWN_PROMPT_TEMPLATE");
  const invalid = await tool({ sessionId: "s", toolCallId: "t", args: { ...args, folder: "a/b" }, signal });
  assert.equal(invalid.errorCode, "INVALID_ARGUMENT");
  assert.equal(broker.list().length, 0);
});

test("suggested parents are where local projects live, then home", () => {
  const groups = [
    { roots: [{ path: "/Users/me/code/a" }, { path: "/Users/me/Documents/mc-agent/projects/a", kind: "resources" }] },
    { roots: [{ path: "/Users/me/code/b" }] },
    { roots: [{ path: "/Users/me/work/c" }] },
    { remote: { hostKey: "h" }, roots: [{ path: "/srv/x" }] },
  ];
  assert.deepEqual(suggestedParents(groups, "/Users/me"), ["/Users/me/code", "/Users/me/work", "/Users/me"]);
});

test("the location check tells new, empty, full, owned and blocked apart", async () => {
  const root = await mkdtemp(join(tmpdir(), "mc-np-"));
  try {
    await mkdir(join(root, "empty"));
    await mkdir(join(root, "full"));
    await writeFile(join(root, "full", "a.txt"), "a");
    await writeFile(join(root, "file"), "x");
    const groups = [{ name: "Owned", roots: [{ path: join(root, "full") }] }];

    const fresh = await checkProjectLocation(join(root, "deep", "er"), "new", groups);
    assert.equal(fresh.exists, false);
    assert.equal(fresh.writable, true, "the nearest existing ancestor decides");
    assert.equal((await checkProjectLocation(root, "empty", [])).entries, 0);
    const full = await checkProjectLocation(root, "full", groups);
    assert.equal(full.entries, 1);
    assert.equal(full.project, "Owned");
    assert.equal((await checkProjectLocation(root, "file", [])).blocked, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("only a folder this run created is removed, and only while empty", async () => {
  const root = await mkdtemp(join(tmpdir(), "mc-np-"));
  try {
    const made = await makeProjectFolder(join(root, "a", "b"));
    assert.equal(made.created, true);
    assert.equal((await makeProjectFolder(made.path)).created, false);
    await writeFile(join(made.path, "keep.txt"), "x");
    assert.equal(await removeCreatedProjectFolder(made.path), false);
    await rm(join(made.path, "keep.txt"));
    assert.equal(await removeCreatedProjectFolder(made.path), true);
    await mkdir(join(root, "theirs"));
    assert.equal(await removeCreatedProjectFolder(join(root, "theirs")), false);
    assert.deepEqual((await readdir(root)).sort(), ["a", "theirs"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the card's answer is shape-checked before it reaches the model", () => {
  assert.deepEqual(projectProposalDecisionOf({ outcome: "revise", name: "x", path: "/p", request: "smaller" }), {
    outcome: "revise",
    name: "x",
    path: "/p",
    request: "smaller",
  });
  assert.equal(projectProposalDecisionOf({ outcome: "failed", step: "weird", name: "x", path: "/p" }).step, "project");
  assert.throws(() => projectProposalDecisionOf({ outcome: "deleted" }));
});

test("the user's locations lead the suggestions and survive a restart", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "mc-np-data-"));
  try {
    assert.deepEqual(await loadProjectLocations(dataDir), []);
    const locations = [
      { path: "/Users/me/code", note: "code projects" },
      { path: "/Users/me/Videos", note: "  video   work " },
    ];
    assert.deepEqual(await saveProjectLocations(dataDir, locations), [
      { path: "/Users/me/code", note: "code projects" },
      { path: "/Users/me/Videos", note: "video work" },
    ]);
    assert.equal((await loadProjectLocations(dataDir)).length, 2);
    await assert.rejects(() => saveProjectLocations(dataDir, [{ path: "relative", note: "" }]));
    await assert.rejects(() => saveProjectLocations(dataDir, [locations[0], locations[0]]));
    const groups = [{ roots: [{ path: "/Users/me/work/a" }] }];
    assert.deepEqual(suggestedParents(groups, "/Users/me", ["/Users/me/code", "/Users/me/Videos"]), [
      "/Users/me/code",
      "/Users/me/Videos",
      "/Users/me/work",
      "/Users/me",
    ]);
    const listed = await createProjectTemplatesTool(() => fakeHost(), () => loadProjectLocations(dataDir))({
      sessionId: "s",
      toolCallId: "t",
      args: {},
      signal: new AbortController().signal,
    });
    assert.equal(listed.content.userLocations[1].note, "video work");
    assert.equal(listed.content.suggestedParents[0], "/Users/me/code");
    assert.deepEqual(await saveProjectLocations(dataDir, []), []);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("a single default location saved by the first version still reads", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "mc-np-data-"));
  try {
    await writeFile(join(dataDir, "mc-project-defaults.json"), JSON.stringify({ version: 1, parent: "/Users/me/code" }));
    assert.deepEqual(await loadProjectLocations(dataDir), [{ path: "/Users/me/code", note: "" }]);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});
