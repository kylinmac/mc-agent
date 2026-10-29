import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { scanCodexSessions, codexImporter } = await import("../electron/main/importers/codex.ts");
const { DatabaseSync } = await import("node:sqlite");

/*
  mc-agent: newer Codex builds migrate rollout .jsonl files into
  state_<n>.sqlite (threads) + thread_history_<n>.sqlite (thread_items) and
  delete the files, so the file scan alone listed a fraction of the history.
  The columns below are the subset of Codex's schema the importer reads.
*/

const THREADS = `CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT NOT NULL,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, source TEXT NOT NULL, cwd TEXT NOT NULL,
  title TEXT NOT NULL, archived INTEGER NOT NULL DEFAULT 0, first_user_message TEXT NOT NULL DEFAULT '',
  created_at_ms INTEGER, updated_at_ms INTEGER, preview TEXT NOT NULL DEFAULT '', name TEXT, model TEXT,
  attached_thread_parent_id TEXT)`;
const ITEMS = `CREATE TABLE thread_items (thread_id TEXT NOT NULL, turn_id TEXT NOT NULL, item_id TEXT NOT NULL,
  rollout_ordinal INTEGER NOT NULL, created_at_ms INTEGER NOT NULL, item_json TEXT NOT NULL,
  item_type TEXT NOT NULL DEFAULT '', PRIMARY KEY (thread_id, turn_id, item_id))`;
const T0 = Date.UTC(2026, 9, 20, 10);

const user = (text) => ({ type: "userMessage", id: "u", content: [{ type: "text", text, text_elements: [] }] });
const agent = (text) => ({ type: "agentMessage", id: "a", text, phase: "final_answer" });

function seed(home, { threads = [], items = {}, stateName = "state_5.sqlite" }) {
  const state = new DatabaseSync(join(home, stateName));
  state.exec(THREADS);
  for (const t of threads) {
    const row = {
      rollout_path: join(home, "sessions", "gone", `rollout-${t.id}.jsonl`),
      created_at: T0 / 1000, updated_at: T0 / 1000 + 60, created_at_ms: T0, updated_at_ms: T0 + 60_000,
      source: "vscode", cwd: "/Users/me/app", title: "", preview: "x", ...t,
    };
    const keys = Object.keys(row);
    state.prepare(`INSERT INTO threads (${keys.join(", ")}) VALUES (${keys.map(() => "?").join(", ")})`)
      .run(...keys.map((key) => row[key]));
  }
  state.close();
  const history = new DatabaseSync(join(home, "thread_history_1.sqlite"));
  history.exec(ITEMS);
  for (const [threadId, list] of Object.entries(items)) {
    list.forEach((item, index) => {
      history.prepare("INSERT INTO thread_items VALUES (?, ?, ?, ?, ?, ?, ?)")
        .run(threadId, "turn", `item-${index}`, index, T0 + index * 1000, JSON.stringify(item), item.type);
    });
  }
  history.close();
}

async function withHome(setup, run) {
  const home = await mkdtemp(join(tmpdir(), "codex-history-db-"));
  try {
    await mkdir(join(home, "sessions"), { recursive: true });
    await setup(home);
    return await run(join(home, "sessions"), home);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

test("threads whose rollout files were migrated away are listed from the history database", async () => {
  await withHome(
    (home) => seed(home, {
      threads: [
        { id: "named", name: "修复 SQL 解析", cwd: "/Users/me/sql优化", first_user_message: "有个工具" },
        { id: "unnamed", first_user_message: "\n# Files mentioned by the user:\n\n## a.png: /tmp/a.png\n\n## My request:\n帮我看看这张图" },
        { id: "archived", name: "识别虫子", archived: 1 },
        { id: "exec", source: "exec", name: "scripted run" },
        { id: "guardian", source: '{"subagent":{"other":"guardian"}}', name: "Guardian review" },
        { id: "pane", name: "side pane", attached_thread_parent_id: "named" },
        { id: "empty", name: "never answered" },
        { id: "synthetic", first_user_message: "<environment_context>x</environment_context>" },
      ],
      items: Object.fromEntries(
        ["named", "unnamed", "archived", "exec", "guardian", "pane", "synthetic"].map((id) => [id, [user("hi"), agent("hello")]]),
      ),
    }),
    async (dir) => {
      const sessions = await scanCodexSessions(dir);
      assert.deepEqual(sessions.map((s) => s.externalId).sort(), ["archived", "named", "unnamed"]);
      const named = sessions.find((s) => s.externalId === "named");
      assert.equal(named.title, "修复 SQL 解析");
      assert.equal(named.projectPath, "/Users/me/sql优化");
      assert.equal(named.messageCount, 2);
      assert.equal(named.createdAt, new Date(T0).toISOString());
      assert.equal(named.updatedAt, new Date(T0 + 60_000).toISOString());
      assert.equal(sessions.find((s) => s.externalId === "unnamed").title, "帮我看看这张图");
    },
  );
});

test("a migrated thread converts its turns and tool calls, never reasoning or bookkeeping", async () => {
  await withHome(
    (home) => seed(home, {
      threads: [{ id: "t1", name: "Review" }],
      items: {
        t1: [
          user("# AGENTS.md instructions for /Users/me/app\n\nrules"),
          user("# Context from my IDE setup:\n\n## Active file: a.ts\n\n## My request for Codex:\n看看 a.ts"),
          { type: "reasoning", id: "r", summary: [], content: [] },
          { type: "commandExecution", id: "c1", command: "/bin/zsh -lc 'ls'", cwd: "/Users/me/app", status: "completed", aggregatedOutput: "a.ts\n", exitCode: 0 },
          { type: "commandExecution", id: "c2", command: "false", cwd: "/Users/me/app", status: "failed", aggregatedOutput: "", exitCode: 1 },
          { type: "fileChange", id: "f1", changes: [{ path: "/Users/me/app/a.ts", kind: { type: "update" }, diff: "@@ -1 +1 @@\n-a\n+b\n" }], status: "completed" },
          { type: "mcpToolCall", id: "m1", server: "fastctx", tool: "glob", status: "completed", arguments: { pattern: "*" }, result: { content: [{ type: "text", text: "a.ts" }] }, error: null },
          { type: "mcpToolCall", id: "m2", server: "fastctx", tool: "read", status: "failed", arguments: {}, result: null, error: { message: "denied" } },
          { type: "contextCompaction", id: "cc" },
          agent("a.ts 没问题"),
        ],
      },
    }),
    async (dir) => {
      const [summary] = await scanCodexSessions(dir);
      const { session, messages } = await codexImporter.convert(summary);
      assert.equal(session.id, "import-codex-v2-t1");
      assert.equal(session.title, "Review");
      assert.deepEqual(messages.map((m) => [m.role, m.toolName ?? null, m.content]), [
        ["user", null, "看看 a.ts"],
        ["tool", "exec_command", "a.ts\n"],
        ["tool", "exec_command", ""],
        ["tool", "apply_patch", "/Users/me/app/a.ts\n@@ -1 +1 @@\n-a\n+b\n"],
        ["tool", "mcp__fastctx__glob", "a.ts"],
        ["tool", "mcp__fastctx__read", "denied"],
        ["assistant", null, "a.ts 没问题"],
      ]);
      assert.deepEqual(messages[1].toolArgs, { command: "/bin/zsh -lc 'ls'", cwd: "/Users/me/app" });
      assert.deepEqual(messages.map((m) => m.isError === true), [false, false, true, false, false, true, false]);
      assert.equal(messages[0].createdAt, new Date(T0 + 1000).toISOString());
    },
  );
});

test("a thread that still has its rollout file is read from the file, listed once", async () => {
  const meta = (id, timestamp) => JSON.stringify({ timestamp, type: "session_meta", payload: { id, cwd: "/Users/me/app", timestamp, source: "vscode" } });
  const msg = (role, text, timestamp) => JSON.stringify({
    timestamp, type: "response_item",
    payload: { type: "message", role, content: [{ type: role === "user" ? "input_text" : "output_text", text }] },
  });
  await withHome(
    async (home) => {
      const file = join(home, "sessions", "2026", "10", "20", "rollout-2026-10-20T10-00-00-live.jsonl");
      await mkdir(join(file, ".."), { recursive: true });
      await writeFile(file, [
        meta("live", "2026-10-20T10:00:00Z"),
        msg("user", "文件里的完整对话", "2026-10-20T10:00:01Z"),
        msg("assistant", "第一轮", "2026-10-20T10:00:02Z"),
        msg("user", "第二轮", "2026-10-20T10:00:03Z"),
      ].join("\n"));
      seed(home, {
        threads: [{ id: "live", name: "Live", rollout_path: file }],
        items: { live: [user("数据库里只有一部分"), agent("partial")] },
      });
    },
    async (dir) => {
      const sessions = await scanCodexSessions(dir);
      assert.equal(sessions.length, 1);
      assert.equal(sessions[0].historyDb, undefined);
      const { messages } = await codexImporter.convert(sessions[0]);
      assert.deepEqual(messages.map((m) => m.content), ["文件里的完整对话", "第一轮", "第二轮"]);
    },
  );
});

test("sub-agent rollout files such as guardian reviews are not conversations", async () => {
  await withHome(
    async (home) => {
      const file = join(home, "sessions", "2026", "10", "27", "rollout-2026-10-27T16-36-47-guardian.jsonl");
      await mkdir(join(file, ".."), { recursive: true });
      await writeFile(file, [
        JSON.stringify({ timestamp: "2026-10-27T08:36:47Z", type: "session_meta", payload: { id: "guardian", cwd: "/Users/me/app", timestamp: "2026-10-27T08:36:47Z", source: { subagent: { other: "guardian" } } } }),
        JSON.stringify({ timestamp: "2026-10-27T08:36:48Z", type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Review this action" }] } }),
      ].join("\n"));
    },
    async (dir) => {
      assert.deepEqual(await scanCodexSessions(dir), []);
    },
  );
});

test("the newest state database version wins and a missing history database lists nothing extra", async () => {
  await withHome(
    async (home) => {
      seed(home, { threads: [{ id: "old", name: "Old" }], items: { old: [user("hi")] }, stateName: "state_4.sqlite" });
      await rm(join(home, "thread_history_1.sqlite"));
      seed(home, { threads: [{ id: "new", name: "New" }], items: { new: [user("hi")] }, stateName: "state_5.sqlite" });
    },
    async (dir) => {
      assert.deepEqual((await scanCodexSessions(dir)).map((s) => s.externalId), ["new"]);
    },
  );
  await withHome(
    async (home) => {
      seed(home, { threads: [{ id: "orphan", name: "Orphan" }], items: { orphan: [user("hi")] } });
      await rm(join(home, "thread_history_1.sqlite"));
    },
    async (dir) => {
      assert.deepEqual(await scanCodexSessions(dir), []);
    },
  );
});
