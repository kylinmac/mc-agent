import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { scanCodexSessions, codexImporter } = await import("../electron/main/importers/codex.ts");
const { mergeCodexRecords } = await import("../electron/main/importers/codex-segments.ts");
const { importedSessionId, toggleItems } = await import("../src/features/project-import/import-model.ts");
const stamp = (second) => `2026-10-23T00:00:${String(second).padStart(2, "0")}Z`;
const header = (second) => ({ type: "session_meta", timestamp: stamp(second), payload: { id: "same-session", cwd: "/repo", timestamp: stamp(second) } });
const item = (second, payload) => ({ type: "response_item", timestamp: stamp(second), payload });
const message = (second, role, text) => item(second, { type: "message", role, content: [{ type: "text", text }] });

test("Codex groups rotated archives, uses the real title, and imports both sides of a split tool call", async () => {
  const root = await mkdtemp(join(tmpdir(), "codex-segments-"));
  try {
    const dir = join(root, "sessions");
    await mkdir(dir);
    const early = [header(0), message(1, "user", "Original request"),
      item(2, { type: "custom_tool_call", call_id: "call-1", name: "exec", input: "echo test" })];
    const late = [header(3), early[1], early[2],
      item(4, { type: "custom_tool_call_output", call_id: "call-1", output: "test" }),
      message(5, "assistant", "Finished"),
      message(6, "user", "# Files mentioned by the user:\nimage.png\n\n## My request:\nFix this screenshot"),
      message(7, "assistant", "Latest answer")];
    await writeFile(join(dir, "old.jsonl"), early.map(JSON.stringify).join("\n"));
    await writeFile(join(dir, "new.jsonl"), late.map(JSON.stringify).join("\n"));
    await writeFile(join(root, "session_index.jsonl"), [
      JSON.stringify({ id: "same-session", thread_name: "Old title" }),
      JSON.stringify({ id: "same-session", thread_name: "Actual Codex title" }),
      '{"partial":',
    ].join("\n"));
    const candidates = await scanCodexSessions(dir);
    assert.equal(candidates.length, 1);
    const [candidate] = candidates;
    assert.equal(candidate.title, "Actual Codex title");
    assert.equal(candidate.filePaths.length, 2);
    assert.equal(candidate.createdAt, new Date(stamp(0)).toISOString());
    assert.equal(candidate.updatedAt, new Date(stamp(7)).toISOString());
    assert.equal(candidate.messageCount, null);
    const result = await codexImporter.convert(candidate);
    assert.deepEqual(result.messages.map((row) => row.content), ["Original request", "test", "Finished", "Fix this screenshot", "Latest answer"]);
    assert.equal(result.messages[1].toolName, "exec");
    assert.deepEqual(result.messages[1].toolArgs, { input: "echo test" });
    // Legacy copies stay untouched; selecting the corrected copy yields a distinct stable id.
    assert.equal(toggleItems(candidates, new Set(), new Set(["import-codex-same-session"])).size, 1);
    assert.equal(result.session.id, importedSessionId(candidate));
    assert.equal(result.session.id, "import-codex-v2-same-session");
    assert.equal(toggleItems(candidates, new Set(), new Set([result.session.id])).size, 0);
    await rm(join(dir, "old.jsonl"));
    await assert.rejects(codexImporter.convert(candidate), /INVALID_SEGMENT/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("replay dedup preserves repeated messages within one segment and records without timestamps", () => {
  const row = { timestamp: stamp(0), item: { content: "same" } };
  const untimed = { timestamp: null, item: { content: "same" } };
  assert.equal(mergeCodexRecords([[row, row], [row, row, row]]).length, 3);
  assert.equal(mergeCodexRecords([[untimed], [untimed]]).length, 2);
});

test("assistant-only continuation files remain attached to their conversation without a title index", async () => {
  const root = await mkdtemp(join(tmpdir(), "codex-continuation-"));
  try {
    await writeFile(join(root, "a.jsonl"), [header(0), message(1, "user", "Question")].map(JSON.stringify).join("\n"));
    await writeFile(join(root, "b.jsonl"), [header(2), message(3, "assistant", "Answer")].map(JSON.stringify).join("\n"));
    const [candidate] = await scanCodexSessions(root);
    assert.equal(candidate.title, "Question");
    assert.equal(candidate.filePaths.length, 2);
    assert.equal((await codexImporter.convert(candidate)).messages.length, 2);
  } finally { await rm(root, { recursive: true, force: true }); }
});
