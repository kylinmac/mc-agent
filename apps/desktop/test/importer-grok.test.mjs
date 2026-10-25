import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from "node:fs/promises";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { createGrokImporter } = await import("../electron/main/importers/grok.ts");
const { filterCandidates, toggleItems, importedSessionId, groupByProject } =
  await import("../src/features/project-import/import-model.ts");

const meta = (id) => ({ info: { id, cwd: "D:\\work\\demo" }, chat_format_version: 1,
  generated_title: "Fix the button", current_model_id: "grok-4.7",
  created_at: "2026-10-20T01:00:00Z", updated_at: "2026-10-21T02:00:00Z" });
async function fixture(root, id, rows, patch = {}) {
  const dir = join(root, encodeURIComponent("D:\\work\\demo"), id);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "summary.json"), JSON.stringify({ ...meta(id), ...patch }));
  const history = join(dir, "chat_history.jsonl");
  await writeFile(history, rows.map((row) => JSON.stringify(row)).join("\r\n"));
  return history;
}
const user = { type: "user", content: [{ type: "text", text: "Fix the button" }], prompt_index: 0 };

test("Grok scan, selection and conversion preserve conversation and tool history read-only", async () => {
  const root = await mkdtemp(join(tmpdir(), "grok-import-"));
  try {
    const file = await fixture(root, "session-1", [
      { type: "system", content: "DO NOT IMPORT" },
      { ...user, synthetic_reason: "system_reminder", content: [{ type: "text", text: "INJECTION" }] },
      user,
      { type: "reasoning", encrypted_content: "SECRET", summary: [] },
      { type: "assistant", content: "Reading", tool_calls: [{ id: "call-1", name: "read", arguments: '{"path":"app.ts"}' }] },
      { type: "tool_result", tool_call_id: "call-1", content: "file contents" },
      { type: "assistant", content: "Fixed" },
      { type: "assistant", content: "", tool_calls: [{ id: "pending", name: "test", arguments: "raw" }] },
    ]);
    const before = await readFile(file, "utf8");
    const importer = createGrokImporter(root);
    const sessions = await importer.scan();
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0].messageCount, 5);
    assert.equal(sessions[0].projectPath, "D:\\work\\demo");
    assert.equal(sessions[0].title, "Fix the button");
    assert.equal(sessions[0].model, "grok-4.7");
    const offered = filterCandidates(sessions, { source: "grok", query: "button" });
    assert.equal(offered.length, 1);
    assert.equal(groupByProject(offered).length, 1);
    const converted = await importer.convert(offered[0]);
    assert.equal(converted.session.id, importedSessionId(offered[0]));
    assert.equal(converted.session.id, (await importer.convert(offered[0])).session.id);
    assert.equal(toggleItems(offered, new Set(), new Set([converted.session.id])).size, 0);
    assert.equal(converted.session.modelId, null);
    assert.equal(converted.session.providerId, null);
    assert.deepEqual(converted.messages.map((m) => m.role), ["user", "assistant", "tool", "assistant", "tool"]);
    assert.deepEqual(converted.messages[2].toolArgs, { path: "app.ts" });
    assert.equal(converted.messages[2].toolResult, "file contents");
    assert.equal(converted.messages[4].toolStatus, "interrupted");
    assert.doesNotMatch(JSON.stringify(converted), /INJECTION|SECRET|DO NOT IMPORT/);
    assert.equal(await readFile(file, "utf8"), before);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Grok preserves image placeholders and orphan results without fetching attachments", async () => {
  const root = await mkdtemp(join(tmpdir(), "grok-import-"));
  try {
    await fixture(root, "images", [
      { type: "user", content: [{ type: "text", text: "Look" }, { type: "image", url: "https://invalid.test/private" }] },
      { type: "tool_result", tool_call_id: "old", content: "failed", is_error: true, images: ["data:secret"] },
    ]);
    const importer = createGrokImporter(root);
    const result = await importer.convert((await importer.scan())[0]);
    assert.equal(result.messages[0].content, "Look\n[image]");
    assert.equal(result.messages[1].isError, true);
    assert.doesNotMatch(JSON.stringify(result), /https:|data:secret/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Grok rejects changed, malformed and unsupported sessions instead of importing partial history", async () => {
  const root = await mkdtemp(join(tmpdir(), "grok-import-"));
  try {
    const file = await fixture(root, "good", [user]);
    const importer = createGrokImporter(root);
    const [candidate] = await importer.scan();
    await assert.rejects(importer.convert({ ...candidate, externalId: "another" }), /INVALID_ID/);
    await writeFile(file, '{"type":"user"');
    await assert.rejects(importer.convert(candidate), /INVALID_HISTORY/);
    await fixture(root, "future", [user], { chat_format_version: 99 });
    await fixture(root, "empty", [{ type: "system", content: "instructions" }]);
    assert.deepEqual(await importer.scan(), []);
    assert.deepEqual(await createGrokImporter(join(root, "absent")).scan(), []);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Grok does not scan linked session directories or convert files outside its root", async () => {
  const root = await mkdtemp(join(tmpdir(), "grok-import-"));
  try {
    const source = join(root, "source");
    const outside = join(root, "outside");
    const file = await fixture(outside, "linked", [user]);
    const project = join(source, "project");
    await mkdir(project, { recursive: true });
    await symlink(join(file, ".."), join(project, "linked"), "junction");
    const importer = createGrokImporter(source);
    assert.deepEqual(await importer.scan(), []);
    const [external] = await createGrokImporter(outside).scan();
    await assert.rejects(importer.convert(external), /INVALID_FILE/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
