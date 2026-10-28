import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { scanCodexSessions, scanCodexSessionsResult, codexImporter } = await import(
  "../electron/main/importers/codex.ts"
);

/*
  mc-agent: the desktop app / IDE extension wrap every request in IDE context
  ending with "## My request for Codex:", and archived threads live in a flat
  ~/.codex/archived_sessions. Both used to drop real sessions from the scan.
*/

const meta = (id, cwd, timestamp) =>
  JSON.stringify({ timestamp, type: "session_meta", payload: { id, cwd, timestamp } });
const msg = (role, text, timestamp) =>
  JSON.stringify({
    timestamp,
    type: "response_item",
    payload: { type: "message", role, content: [{ type: role === "user" ? "input_text" : "output_text", text }] },
  });
const ide = (request) =>
  `# Context from my IDE setup:\n\n## Active file: src/App.tsx\n\n## Open tabs:\n- App.tsx: src/App.tsx\n\n## My request for Codex:\n${request}\n`;

async function withHome(files, run) {
  const root = await mkdtemp(join(tmpdir(), "codex-ide-archived-"));
  try {
    for (const [name, lines] of files) {
      const target = join(root, name);
      await mkdir(join(target, ".."), { recursive: true });
      await writeFile(target, lines.join("\n"));
    }
    await mkdir(join(root, "sessions"), { recursive: true });
    return await run(join(root, "sessions"), join(root, "archived_sessions"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("a session whose every request carries IDE context is listed with the real request as title", async () => {
  await withHome(
    [
      [
        "sessions/2026/10/20/rollout-2026-10-20T10-00-00-ide.jsonl",
        [
          meta("ide-1", "/Users/me/hjy-admin", "2026-10-20T10:00:00Z"),
          msg("user", "# AGENTS.md instructions for /Users/me/hjy-admin\n\nrules", "2026-10-20T10:00:01Z"),
          msg("user", ide("帮我优化这个 SQL"), "2026-10-20T10:00:02Z"),
          msg("assistant", "好的", "2026-10-20T10:00:03Z"),
          msg("user", ide("再加个索引"), "2026-10-20T10:00:04Z"),
        ],
      ],
    ],
    async (dir) => {
      const sessions = await scanCodexSessions(dir);
      assert.equal(sessions.length, 1);
      assert.equal(sessions[0].title, "帮我优化这个 SQL");
      assert.equal(sessions[0].projectPath, "/Users/me/hjy-admin");
      const { messages } = await codexImporter.convert({ ...sessions[0], filePath: sessions[0].filePaths[0] });
      assert.deepEqual(
        messages.map((m) => [m.role, m.content]),
        [
          ["user", "帮我优化这个 SQL"],
          ["assistant", "好的"],
          ["user", "再加个索引"],
        ],
      );
    },
  );
});

test("the request after the LAST marker wins, like Codex's own replay", async () => {
  const selection = "## Active selection:\n```\n## My request for Codex:\nold text inside a file\n```\n";
  await withHome(
    [
      [
        "sessions/2026/10/21/rollout-2026-10-21T00-00-00-last.jsonl",
        [
          meta("last-1", "/repo", "2026-10-21T00:00:00Z"),
          msg("user", `# Context from my IDE setup:\n\n${selection}\n## My request for Codex:\n真正的问题`, "2026-10-21T00:00:01Z"),
        ],
      ],
    ],
    async (dir) => {
      const [s] = await scanCodexSessions(dir);
      assert.equal(s.title, "真正的问题");
    },
  );
});

test("IDE context with an empty request stays synthetic", async () => {
  await withHome(
    [
      [
        "sessions/2026/10/21/rollout-2026-10-21T00-00-00-empty.jsonl",
        [meta("empty-1", "/repo", "2026-10-21T00:00:00Z"), msg("user", ide(""), "2026-10-21T00:00:01Z")],
      ],
    ],
    async (dir) => {
      assert.deepEqual(await scanCodexSessions(dir), []);
    },
  );
});

test("archived rollouts (flat archived_sessions) are listed next to active ones", async () => {
  await withHome(
    [
      [
        "sessions/2026/10/22/rollout-2026-10-22T00-00-00-active.jsonl",
        [meta("active-1", "/repo/a", "2026-10-22T00:00:00Z"), msg("user", "进行中的会话", "2026-10-22T00:00:01Z")],
      ],
      [
        "archived_sessions/rollout-2026-09-01T00-00-00-archived.jsonl",
        [meta("archived-1", "/repo/b", "2026-09-01T00:00:00Z"), msg("user", "已归档的会话", "2026-09-01T00:00:01Z")],
      ],
    ],
    async (dir, archivedDir) => {
      const sessions = await scanCodexSessions(dir);
      assert.deepEqual(sessions.map((s) => s.externalId).sort(), ["active-1", "archived-1"]);
      const archived = sessions.find((s) => s.externalId === "archived-1");
      assert.equal(archived.title, "已归档的会话");
      const { messages } = await codexImporter.convert({ ...archived, filePath: archived.filePaths[0] });
      assert.equal(messages[0].content, "已归档的会话");
      // Explicit directory still works; null opts out of the archive.
      assert.equal((await scanCodexSessions(dir, undefined, archivedDir)).length, 2);
      assert.deepEqual((await scanCodexSessions(dir, undefined, null)).map((s) => s.externalId), ["active-1"]);
    },
  );
});

test("active and archived rollouts share one newest-first cap", async () => {
  await withHome(
    [
      [
        "sessions/2026/01/01/rollout-2026-01-01T00-00-00-old.jsonl",
        [meta("old-active", "/repo", "2026-01-01T00:00:00Z"), msg("user", "旧的", "2026-01-01T00:00:01Z")],
      ],
      [
        "archived_sessions/rollout-2026-10-01T00-00-00-new.jsonl",
        [meta("new-archived", "/repo", "2026-10-01T00:00:00Z"), msg("user", "新的归档", "2026-10-01T00:00:01Z")],
      ],
    ],
    async (dir) => {
      const result = await scanCodexSessionsResult(dir, 1);
      assert.equal(result.truncated, true);
      assert.deepEqual(result.sessions.map((s) => s.externalId), ["new-archived"]);
    },
  );
});
