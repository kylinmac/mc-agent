import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  addSuggestions,
  createMemoryReview,
  createRecallTool,
  loadMemorySettings,
  saveMemorySettings,
  sessionMemoryPrompt,
  userMemoryStore,
} from "../electron/main/mc-memory.ts";
import { createRememberTool } from "../electron/main/mc-agent-memory.ts";

const withDataDir = async (run) => {
  const dir = await mkdtemp(join(tmpdir(), "mc-memory-"));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};

/** A host with one project group holding `entries`. */
function fakeHost(entries = []) {
  const state = { entries };
  return {
    state,
    call: async (method, params) => {
      if (method === "session.get") return { session: { projectPath: params.id === "outside" ? "" : "/p", title: "Chat" } };
      if (method === "project.groups.list") return { groups: [{ id: "g", roots: [{ path: "/p" }] }] };
      if (method === "project.group.memory.get") return { memory: { entries: state.entries, content: "" } };
      if (method === "project.group.memory.set") {
        state.entries = params.entries;
        return {};
      }
      throw new Error(`unexpected ${method}`);
    },
  };
}

const signal = new AbortController().signal;

test("the memory about the user is stored bounded and loads into every session", () =>
  withDataDir(async (dir) => {
    assert.deepEqual(await loadMemorySettings(dir), { user: [], review: false });
    await saveMemorySettings(dir, {
      user: [
        { id: "user-1", title: "Language", content: "Reply in Chinese.", kind: "user", junk: 1 },
        { id: "user-1", title: "dup", content: "dropped" },
        { id: "user-2", title: "empty", content: " " },
      ],
      review: true,
    });
    const loaded = await loadMemorySettings(dir);
    assert.deepEqual(loaded, { user: [{ id: "user-1", title: "Language", content: "Reply in Chinese.", kind: "user" }], review: true });
    const prompt = await sessionMemoryPrompt(dir, undefined);
    assert.match(prompt, /About the user[\s\S]*Reply in Chinese\./);
  }));

test("Remember writes notes about the user outside projects, and Recall reads either memory", () =>
  withDataDir(async (dir) => {
    const host = fakeHost([{ id: "agent-1", title: "Tests", content: "Run node tests.", kind: "feedback" }]);
    const remember = createRememberTool(() => host, userMemoryStore(dir));
    const outside = await remember({ sessionId: "outside", toolCallId: "t", signal, args: { title: "Tone", content: "Be brief.", kind: "user" } });
    assert.equal(outside.content.scope, "user");
    const asked = await remember({ sessionId: "s", toolCallId: "t", signal, args: { title: "Lang", content: "Chinese.", scope: "user", hook: "reply language" } });
    assert.equal(asked.content.scope, "user");
    const user = await userMemoryStore(dir).read();
    assert.deepEqual(user.map((entry) => entry.title), ["Tone", "Lang"]);
    assert.equal(user[1].hook, "reply language");
    assert.equal(user[1].source.sessionId, "s");

    const recall = createRecallTool(() => host, dir);
    const project = await recall({ sessionId: "s", toolCallId: "t", signal, args: { id: "[agent-1]" } });
    assert.equal(project.content.content, "Run node tests.");
    assert.equal(project.content.scope, "project");
    const about = await recall({ sessionId: "s", toolCallId: "t", signal, args: { id: user[0].id } });
    assert.equal(about.content.scope, "user");
    assert.equal((await recall({ sessionId: "s", toolCallId: "t", signal, args: { id: "nope" } })).errorCode, "NOT_FOUND");
  }));

test("suggestions wait as pending notes; updates need a note the agent may change", () => {
  let n = 0;
  const options = { editable: (entry) => entry.id.startsWith("agent-"), newId: () => `agent-s${++n}`, sessionId: "s", now: 9 };
  const entries = [
    { id: "agent-1", title: "Tests", content: "old" },
    { id: "mine", title: "Style", content: "Tabs" },
  ];
  const { entries: next, added } = addSuggestions(
    entries,
    [
      { action: "add", scope: "project", title: "Release", content: "Tag first.", reason: "said twice" },
      { action: "update", scope: "project", target: "agent-1", title: "Tests", content: "new" },
      { action: "remove", scope: "project", target: "mine", title: "", content: "" },
      { action: "add", scope: "project", title: "release", content: "duplicate title" },
    ],
    options,
  );
  assert.equal(added, 2);
  assert.deepEqual(next.slice(2).map((entry) => entry.pending), [{ reason: "said twice" }, { replaces: "agent-1" }]);
  assert.equal(next[2].source.sessionId, "s");
});

test("a review runs once the conversation stays idle, only when switched on", () =>
  withDataDir(async (dir) => {
    const host = fakeHost([{ id: "agent-1", title: "Tests", content: "old" }]);
    const asked = [];
    const notices = [];
    const review = createMemoryReview({
      getHost: () => host,
      dataDir: dir,
      idleMs: 5,
      review: async (sessionId, memory, mode) => {
        asked.push({ sessionId, mode, memory });
        return [
          { action: "add", scope: "project", title: "Release", content: "Tag first." },
          { action: "add", scope: "user", title: "Lang", content: "Chinese." },
        ];
      },
      notify: (event) => notices.push(event),
    });
    const settle = () => new Promise((resolve) => setTimeout(resolve, 40));
    review.turnEnded("s", true);
    await settle();
    assert.equal(asked.length, 0, "off by default");

    await saveMemorySettings(dir, { review: true });
    review.turnEnded("s", true);
    review.turnEnded("s", false);
    await settle();
    assert.equal(asked.length, 0, "a turn that did not complete cancels the wait");

    review.turnEnded("s", true);
    await settle();
    assert.equal(asked.length, 1);
    assert.equal(asked[0].mode, "auto");
    assert.match(asked[0].memory, /\[agent-1\] \(project, editable\)/);
    assert.ok(host.state.entries.some((entry) => entry.title === "Release" && entry.pending));
    assert.ok((await userMemoryStore(dir).read()).some((entry) => entry.title === "Lang" && entry.pending));
    assert.deepEqual(notices, [{ sessionId: "s", added: 2 }]);

    const tidy = await review.consolidate("s");
    assert.equal(asked.at(-1).mode, "consolidate");
    assert.equal(tidy.added, 0, "titles already waiting are not suggested twice");
    review.dispose();
  }));
