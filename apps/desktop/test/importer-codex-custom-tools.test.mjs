import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
register(pathToFileURL(join(here, "helpers/ts-import-hooks.mjs")));
const { codexImporter } = await import("../electron/main/importers/codex.ts");

// mc-agent (MC-ADR-0009): newer Codex rollouts carry `custom_tool_call`.
test("Codex custom tool calls import as tool activity with their output", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mc-codex-"));
  try {
    const file = join(dir, "rollout.jsonl");
    const lines = [
      { type: "session_meta", timestamp: "2026-10-01T00:00:00Z", payload: { id: "s1", cwd: "/w", timestamp: "2026-10-01T00:00:00Z" } },
      { type: "response_item", timestamp: "2026-10-01T00:00:01Z", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "list files" }] } },
      { type: "response_item", timestamp: "2026-10-01T00:00:01Z", payload: { type: "message", role: "developer", content: [{ type: "input_text", text: "<codex_apps_open_page_instructions>x</codex_apps_open_page_instructions>" }] } },
      { type: "response_item", timestamp: "2026-10-01T00:00:02Z", payload: { type: "custom_tool_call", call_id: "c1", name: "exec", input: "ls -la" } },
      { type: "response_item", timestamp: "2026-10-01T00:00:03Z", payload: { type: "custom_tool_call_output", call_id: "c1", output: [{ type: "input_text", text: "a.txt" }, { type: "input_text", text: "b.txt" }] } },
      { type: "response_item", timestamp: "2026-10-01T00:00:04Z", payload: { type: "function_call", call_id: "c2", name: "read", arguments: "{\"path\":\"a.txt\"}" } },
      { type: "response_item", timestamp: "2026-10-01T00:00:05Z", payload: { type: "function_call_output", call_id: "c2", output: "hello" } },
      { type: "response_item", timestamp: "2026-10-01T00:00:06Z", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "done" }] } },
    ];
    await writeFile(file, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);
    const converted = await codexImporter.convert({
      source: "codex",
      externalId: "s1",
      title: "list files",
      projectPath: "/w",
      model: null,
      createdAt: "2026-10-01T00:00:00.000Z",
      updatedAt: "2026-10-01T00:00:06.000Z",
      messageCount: 5,
      filePath: file,
    });
    const tools = converted.messages.filter((message) => message.role === "tool");
    assert.equal(tools.length, 2);
    assert.equal(tools[0].toolName, "exec");
    assert.deepEqual(tools[0].toolArgs, { input: "ls -la" });
    assert.equal(tools[0].content, "a.txt\nb.txt");
    assert.equal(tools[1].toolName, "read");
    assert.deepEqual(tools[1].toolArgs, { path: "a.txt" });
    assert.deepEqual(
      converted.messages.map((message) => message.role),
      ["user", "tool", "tool", "assistant"],
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
