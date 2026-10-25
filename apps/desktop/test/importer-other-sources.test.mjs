import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { createClaudeImporter } = await import("../electron/main/importers/claude.ts");
const { piImporter } = await import("../electron/main/importers/pi.ts");
const { createOpenCodeImporter } = await import("../electron/main/importers/opencode.ts");
const date = "2026-10-25T00:00:00Z";

test("Claude uses custom titles, deduplicates UUID replay, and keeps text beside tool results and literal XML", async () => {
  const root = await mkdtemp(join(tmpdir(), "claude-import-"));
  try {
    await mkdir(join(root, "project"));
    const row = (uuid, type, content) => ({ uuid, type, timestamp: date, cwd: "/repo", message: { content } });
    const replay = row("a", "user", "<div>Please fix this HTML</div>");
    const rows = [replay, row("b", "assistant", [{ type: "tool_use", id: "t", name: "read", input: { path: "a" } }]),
      row("c", "user", [{ type: "tool_result", tool_use_id: "t", content: "result" }, { type: "text", text: "Also fix this" }]),
      replay, { type: "custom-title", customTitle: "Old title" }, { type: "custom-title", customTitle: "My renamed conversation" },
      row("synthetic", "user", "<system-reminder>ignore</system-reminder>")];
    await writeFile(join(root, "project", "session.jsonl"), rows.map(JSON.stringify).join("\n"));
    const importer = createClaudeImporter(root);
    const [summary] = await importer.scan();
    assert.equal(summary.title, "My renamed conversation");
    const { messages } = await importer.convert(summary);
    assert.equal(messages[0].content, "<div>Please fix this HTML</div>");
    assert.equal((await importer.convert(summary)).session.id, "import-claude-code-v2-session");
    assert.equal(messages.filter((m) => m.content.includes("Please fix")).length, 1);
    assert.ok(messages.some((m) => m.content === "Also fix this"));
    assert.ok(messages.some((m) => m.toolName === "read" && m.toolResult === "result"));
    assert.ok(!messages.some((m) => m.content.includes("system-reminder")));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Pi imports only the current branch and rejects missing files or broken parents", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-import-"));
  try {
    const filePath = join(root, "session.jsonl");
    const summary = { source: "pi", externalId: "s", title: "Branch", projectPath: "/repo", model: null, createdAt: date, updatedAt: date, filePath };
    const header = { type: "session", id: "s", timestamp: date };
    const entry = (id, parentId, content) => ({ type: "message", id, parentId, timestamp: date, message: { role: "user", content } });
    await writeFile(filePath, [header, entry("a", null, "first"), entry("b", "a", "abandoned"), entry("c", "a", "active")].map(JSON.stringify).join("\n"));
    assert.deepEqual((await piImporter.convert(summary)).messages.map((m) => m.content), ["first", "active"]);
    await writeFile(filePath, [header, entry("c", "missing", "active")].map(JSON.stringify).join("\n"));
    await assert.rejects(piImporter.convert(summary), /MISSING_PARENT/);
    await rm(filePath);
    await assert.rejects(piImporter.convert(summary), /INVALID_SESSION/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("OpenCode preserves full titles, error details and incomplete tool status without importing system instructions", async () => {
  const root = await mkdtemp(join(tmpdir(), "opencode-import-"));
  try {
    const json = async (dir, name, value) => { await mkdir(join(root, dir), { recursive: true }); await writeFile(join(root, dir, name), JSON.stringify(value)); };
    const title = "A custom title that should not be truncated even when longer than forty eight characters";
    await json("session/project", "s.json", { id: "s", title, time: { created: 1, updated: 2 } });
    await json("message/s", "a.json", { id: "a", sessionID: "s", role: "system" });
    await json("message/s", "b.json", { id: "b", sessionID: "s", role: "assistant" });
    await json("part/a", "a.json", { id: "a", type: "text", text: "system instructions" });
    await json("part/b", "a.json", { id: "a", type: "tool", tool: "read", callID: "failed", state: { status: "error", error: "not found" } });
    await json("part/b", "b.json", { id: "b", type: "tool", tool: "read", callID: "pending", state: { status: "running" } });
    const importer = createOpenCodeImporter(root);
    const [summary] = await importer.scan();
    assert.equal(summary.title, title);
    const { messages } = await importer.convert(summary);
    assert.equal(messages.length, 2);
    assert.equal(messages[0].content, "not found");
    assert.equal(messages[0].toolStatus, "error");
    assert.equal(messages[1].toolStatus, "interrupted");
  } finally { await rm(root, { recursive: true, force: true }); }
});
