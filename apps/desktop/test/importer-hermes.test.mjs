import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, symlink } from "node:fs/promises";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { createHermesImporter, defaultHermesHome } = await import("../electron/main/importers/hermes.ts");
const { filterCandidates, toggleItems, importedSessionId, groupByProject } =
  await import("../src/features/project-import/import-model.ts");
const { DatabaseSync } = await import("node:sqlite");

// The sessions/messages columns of Hermes Agent's state.db (hermes_state_common.SCHEMA_SQL, schema 32)
// that matter here; the real file has many more, which the importer never reads.
const SESSIONS = `CREATE TABLE sessions (id TEXT PRIMARY KEY, source TEXT NOT NULL, session_key TEXT,
  model TEXT, model_config TEXT, system_prompt TEXT, parent_session_id TEXT, started_at REAL NOT NULL,
  ended_at REAL, end_reason TEXT, message_count INTEGER DEFAULT 0, cwd TEXT, title TEXT,
  last_activity_at REAL, archived INTEGER NOT NULL DEFAULT 0, hidden INTEGER NOT NULL DEFAULT 0)`;
const MESSAGES = `CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL,
  role TEXT NOT NULL, content TEXT, tool_call_id TEXT, tool_calls TEXT, tool_name TEXT,
  timestamp REAL NOT NULL, reasoning TEXT, _compressed_summary INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1, compacted INTEGER NOT NULL DEFAULT 0, display_kind TEXT,
  display_metadata TEXT, message_uid TEXT)`;
const T0 = 1_760_000_000;

function store(dir, { sessions = [], messages = [], ddl = [SESSIONS, MESSAGES] } = {}) {
  const db = new DatabaseSync(join(dir, "state.db"));
  for (const sql of ddl) db.exec(sql);
  for (const s of sessions) {
    const row = { source: "cli", started_at: T0, ...s };
    if (row.model_config && typeof row.model_config !== "string") row.model_config = JSON.stringify(row.model_config);
    const keys = Object.keys(row);
    db.prepare(`INSERT INTO sessions (${keys.join(", ")}) VALUES (${keys.map(() => "?").join(", ")})`)
      .run(...keys.map((key) => row[key]));
  }
  for (const m of messages) {
    const row = { ...m };
    if (row.tool_calls && typeof row.tool_calls !== "string") row.tool_calls = JSON.stringify(row.tool_calls);
    if (row.content !== null && typeof row.content === "object") row.content = `\u0000json:${JSON.stringify(row.content)}`;
    const keys = Object.keys(row);
    db.prepare(`INSERT INTO messages (${keys.join(", ")}) VALUES (${keys.map(() => "?").join(", ")})`)
      .run(...keys.map((key) => row[key]));
  }
  db.close();
  return join(dir, "state.db");
}

const ROOT = "20251009_090000_aaaaaa";
const TIP = "20251009_093000_bbbbbb";
function conversationFixture() {
  return {
    sessions: [
      { id: ROOT, model: "anthropic/claude-sonnet-4", cwd: "/work/demo", title: "Fix the login button",
        end_reason: "compression", ended_at: T0 + 6 },
      { id: TIP, parent_session_id: ROOT, model: "anthropic/claude-sonnet-4", cwd: "/work/demo",
        started_at: T0 + 6, last_activity_at: T0 + 9 },
      { id: "20251009_091000_cccccc", parent_session_id: ROOT, model_config: { _delegate_from: ROOT } },
      { id: "20251009_092000_tool00", parent_session_id: ROOT, source: "tool" },
      { id: "20251010_110000_eeeeee", started_at: T0 + 100 },
      { id: "20251010_120000_hidden", hidden: 1, started_at: T0 + 200 },
    ],
    messages: [
      { session_id: ROOT, role: "system", content: "SYSTEM PROMPT", timestamp: T0 },
      { session_id: ROOT, role: "user", content: "Fix the login button", timestamp: T0 + 1 },
      { session_id: ROOT, role: "assistant", content: "Let me read it.", timestamp: T0 + 2, reasoning: "PRIVATE THOUGHTS",
        tool_calls: [{ id: "call_1", type: "function", function: { name: "read_file", arguments: '{"path":"login.tsx"}' } },
          { id: "call_2", type: "function", function: { name: "terminal", arguments: "not json" } }] },
      { session_id: ROOT, role: "tool", content: "export function Login() {}", tool_call_id: "call_1",
        tool_name: "read_file", timestamp: T0 + 3 },
      { session_id: ROOT, role: "user", content: "INTERNAL NOTE", display_kind: "internal_notification", timestamp: T0 + 3.5 },
      { session_id: ROOT, role: "user", content: "MODEL ONLY", display_metadata: '{"model_only": true}', timestamp: T0 + 3.6 },
      { session_id: ROOT, role: "user", content: "UNDONE TURN", active: 0, timestamp: T0 + 3.7 },
      { session_id: ROOT, role: "user", timestamp: T0 + 4, active: 0, compacted: 1,
        content: [{ type: "text", text: "Here is a screenshot" }, { type: "image_url", image_url: { url: "data:image/png;base64,SECRETPIXELS" } }] },
      { session_id: ROOT, role: "assistant", content: "Fixed the handler.", timestamp: T0 + 5 },
      { session_id: "20251009_091000_cccccc", role: "user", content: "SUBAGENT TASK", timestamp: T0 + 2.5 },
      { session_id: "20251009_092000_tool00", role: "user", content: "TOOL SESSION", timestamp: T0 + 2.6 },
      { session_id: TIP, role: "user", content: "CONTEXT SUMMARY", _compressed_summary: 1, timestamp: T0 + 6 },
      { session_id: TIP, role: "assistant", content: "Fixed the handler.", timestamp: T0 + 5 },
      { session_id: TIP, role: "user", content: "Now add a test", timestamp: T0 + 7 },
      { session_id: TIP, role: "assistant", content: "Added login.test.tsx.", timestamp: T0 + 8 },
      { session_id: "20251010_110000_eeeeee", role: "system", content: "SYSTEM ONLY", timestamp: T0 + 100 },
      { session_id: "20251010_120000_hidden", role: "user", content: "HIDDEN SESSION", timestamp: T0 + 200 },
    ],
  };
}

test("Hermes scan and conversion follow compression lineage and keep visible turns read-only", async () => {
  const home = await mkdtemp(join(tmpdir(), "hermes-import-"));
  try {
    const file = store(home, conversationFixture());
    const before = await readFile(file);
    const importer = createHermesImporter([home]);
    const sessions = await importer.scan();
    assert.equal(sessions.length, 1);
    const [candidate] = sessions;
    assert.equal(candidate.externalId, ROOT);
    assert.equal(candidate.title, "Fix the login button");
    assert.equal(candidate.projectPath, "/work/demo");
    assert.equal(candidate.model, "anthropic/claude-sonnet-4");
    assert.equal(candidate.createdAt, new Date(T0 * 1000).toISOString());
    assert.equal(candidate.updatedAt, new Date((T0 + 9) * 1000).toISOString());
    assert.equal(candidate.messageCount, 8);
    const offered = filterCandidates(sessions, { source: "hermes", query: "login" });
    assert.equal(offered.length, 1);
    assert.equal(groupByProject(offered).length, 1);
    const converted = await importer.convert(offered[0]);
    assert.equal(converted.session.id, importedSessionId(offered[0]));
    assert.equal(converted.session.id, `import-hermes-${ROOT}`);
    assert.equal(toggleItems(offered, new Set(), new Set([converted.session.id])).size, 0);
    assert.equal(converted.session.modelId, null);
    assert.deepEqual(converted.messages.map((m) => [m.role, m.content]), [
      ["user", "Fix the login button"],
      ["assistant", "Let me read it."],
      ["tool", "export function Login() {}"],
      ["tool", ""],
      ["user", "Here is a screenshot\n[image]"],
      ["assistant", "Fixed the handler."],
      ["user", "Now add a test"],
      ["assistant", "Added login.test.tsx."],
    ]);
    assert.deepEqual(converted.messages[2].toolArgs, { path: "login.tsx" });
    assert.equal(converted.messages[2].toolName, "read_file");
    assert.equal(converted.messages[2].toolStatus, "success");
    assert.equal(converted.messages[3].toolArgs, "not json");
    assert.equal(converted.messages[3].toolStatus, "interrupted");
    assert.equal(converted.messages[0].createdAt, new Date((T0 + 1) * 1000).toISOString());
    assert.doesNotMatch(JSON.stringify(converted),
      /SYSTEM|SECRETPIXELS|PRIVATE THOUGHTS|INTERNAL NOTE|MODEL ONLY|UNDONE|SUBAGENT|TOOL SESSION|CONTEXT SUMMARY|HIDDEN/);
    assert.deepEqual(await readFile(file), before);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("Hermes branches and resets are their own conversations; profiles get distinct ids", async () => {
  const home = await mkdtemp(join(tmpdir(), "hermes-import-"));
  try {
    store(home, {
      sessions: [
        { id: "root", title: "Root", end_reason: "branched", ended_at: T0 + 1 },
        { id: "branch", parent_session_id: "root", model_config: { _branched_from: "root" }, started_at: T0 + 2 },
        { id: "reset-parent", session_key: "tg:1", end_reason: "session_reset", started_at: T0 + 3 },
        { id: "reset-child", session_key: "tg:1", parent_session_id: "reset-parent", started_at: T0 + 4 },
      ],
      messages: ["root", "branch", "reset-parent", "reset-child"].map((id, i) =>
        ({ session_id: id, role: "user", content: `hello ${id}`, timestamp: T0 + i })),
    });
    const profile = join(home, "profiles", "work");
    await mkdir(profile, { recursive: true });
    store(profile, { sessions: [{ id: "root", title: "Work root" }],
      messages: [{ session_id: "root", role: "user", content: "work hello", timestamp: T0 }] });
    await mkdir(join(home, "profiles", "empty"));
    const importer = createHermesImporter([home]);
    const sessions = await importer.scan();
    assert.deepEqual(sessions.map((s) => s.externalId).sort(),
      ["branch", "reset-child", "reset-parent", "root", "work.root"]);
    const work = sessions.find((s) => s.externalId === "work.root");
    assert.equal(work.title, "Work root");
    assert.equal(sessions.find((s) => s.externalId === "branch").title, "hello branch");
    const converted = await importer.convert(work);
    assert.equal(converted.session.id, "import-hermes-work.root");
    assert.deepEqual(converted.messages.map((m) => m.content), ["work hello"]);
    assert.deepEqual(await createHermesImporter([join(home, "absent")]).scan(), []);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("Hermes reads older schemas but rejects unsupported stores and files outside its homes", async () => {
  const root = await mkdtemp(join(tmpdir(), "hermes-import-"));
  try {
    const legacy = join(root, "legacy");
    await mkdir(legacy);
    store(legacy, {
      ddl: ["CREATE TABLE sessions (id TEXT PRIMARY KEY, source TEXT, started_at REAL NOT NULL, parent_session_id TEXT)",
        "CREATE TABLE messages (id INTEGER PRIMARY KEY, session_id TEXT, role TEXT, content TEXT, timestamp REAL)"],
      sessions: [{ id: "old" }],
      messages: [{ session_id: "old", role: "user", content: "legacy hello", timestamp: T0 }],
    });
    const [old] = await createHermesImporter([legacy]).scan();
    assert.equal(old.title, "legacy hello");
    assert.equal(old.projectPath, null);

    const broken = join(root, "broken");
    await mkdir(broken);
    store(broken, { sessions: [{ id: "x" }],
      ddl: ["CREATE TABLE sessions (id TEXT PRIMARY KEY, source TEXT, started_at REAL)",
        "CREATE TABLE messages (id INTEGER PRIMARY KEY, session_id TEXT, content TEXT, timestamp REAL)"] });
    assert.deepEqual(await createHermesImporter([broken]).scan(), []);

    const linked = join(root, "linked");
    await mkdir(linked);
    await symlink(join(legacy, "state.db"), join(linked, "state.db"));
    assert.deepEqual(await createHermesImporter([linked]).scan(), []);

    const other = join(root, "other");
    await mkdir(other);
    store(other, conversationFixture());
    const [outside] = await createHermesImporter([other]).scan();
    const importer = createHermesImporter([legacy]);
    await assert.rejects(importer.convert(outside), /INVALID_FILE/);
    await assert.rejects(importer.convert({ ...old, externalId: "missing" }), /EMPTY_HISTORY/);
    await assert.rejects(importer.convert({ ...old, source: "grok" }), /INVALID_ID/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Hermes home follows the platform default", () => {
  assert.equal(defaultHermesHome({ LOCALAPPDATA: "C:\\Users\\me\\AppData\\Local" }, "win32"),
    join("C:\\Users\\me\\AppData\\Local", "hermes"));
  assert.match(defaultHermesHome({}, "darwin"), /[\\/]\.hermes$/);
  assert.match(defaultHermesHome({ HERMES_DATA_DIR_SUFFIX: "-dev" }, "linux"), /[\\/]\.hermes-dev$/);
});
