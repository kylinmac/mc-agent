import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { scanCodexSessionsResult, codexImporter } = await import("../electron/main/importers/codex.ts");
const { groupByProject, selectionSummary, candidateKey } = await import("../src/features/project-import/import-model.ts");

const record = (id, text, at) => [
  { type: "session_meta", payload: { id, cwd: "D:\\Repo", timestamp: at } },
  { type: "response_item", timestamp: at, payload: { type: "message", role: "user", content: [{ type: "input_text", text }] } },
].map(JSON.stringify).join("\n");

test("default scan includes older conversations and continuation segments beyond 250 files", async () => {
  const root = await mkdtemp(join(tmpdir(), "codex-complete-"));
  try {
    const dir = join(root, "sessions");
    await mkdir(join(dir, "2026/01/01"), { recursive: true });
    await mkdir(join(dir, "2026/10/01"), { recursive: true });
    await writeFile(join(dir, "2026/01/01/old.jsonl"), record("old", "Original request", "2026-01-01T00:00:00Z"));
    for (let i = 0; i < 251; i++) {
      await writeFile(join(dir, `2026/10/01/new-${i}.jsonl`), record(`new-${i}`, `Question ${i}`, "2026-10-01T00:00:00Z"));
    }
    await writeFile(join(dir, "2026/10/01/continued.jsonl"), record("old", "Follow-up request", "2026-10-02T00:00:00Z"));
    const result = await scanCodexSessionsResult(dir);
    assert.equal(result.truncated, false);
    assert.equal(result.sessions.length, 252);
    const old = result.sessions.find(s => s.externalId === "old");
    assert.equal(old.filePaths.length, 2);
    assert.deepEqual((await codexImporter.convert(old)).messages.map(m => m.content), ["Original request", "Follow-up request"]);
    assert.equal((await scanCodexSessionsResult(dir, 1)).truncated, true);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Windows aliases share a group and selected project count without changing source paths", () => {
  const paths = ["D:\\Repo\\", "\\\\?\\D:\\Repo", "d:/repo", "\\\\?\\UNC\\server\\share\\repo", "\\\\server\\share\\repo", "/repo/A", "/repo/a"];
  const candidates = paths.map((projectPath, i) => ({ source: "codex", externalId: String(i), projectPath, title: "Chat", updatedAt: "2026-10-01", createdAt: "2026-10-01" }));
  const groups = groupByProject(candidates);
  assert.equal(groups.length, 4);
  assert.equal(groups.find(g => g.items.some(i => i.externalId === "0")).items.length, 3);
  assert.equal(selectionSummary(candidates, new Set(candidates.map(candidateKey))).projects, 4);
  assert.deepEqual(candidates.map(c => c.projectPath), paths);
});
