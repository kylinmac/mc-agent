import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
import { IPC, IPC_WHITELIST } from "@pi-desktop/shared";
import { builtinSystemPrompt } from "@pi-desktop/agent-runtime";
register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { registerMcPromptsIpc } = await import("../electron/main/ipc/mc-prompts-ipc.ts");
const { api } = await import("../src/lib/api.ts");

test("built-in prompt is read through preload without a host or session", async () => {
  const handlers = new Map();
  registerMcPromptsIpc({
    registrar: { handle: (channel, handler) => handlers.set(channel, handler) },
    getHost: () => { throw new Error("built-in viewer must not access stored user configuration"); },
  });
  const previous = globalThis.window;
  globalThis.window = { piDesktop: { invoke: async (channel, input) => {
    assert.equal(channel, IPC.invoke.mcPromptsBuiltin);
    assert.ok(IPC_WHITELIST.has(channel));
    return { ok: true, data: await handlers.get(channel)(input) };
  } } };
  try {
    const loaded = await api.builtinSystemPrompt();
    assert.deepEqual(loaded.prompt, builtinSystemPrompt());
    assert.deepEqual(loaded.prompt.sections.map((section) => section.key), ["persona", "runtime", "delegation", "agent", "plan", "goal"]);
    loaded.prompt.sections[0].text = "changed in caller";
    assert.notEqual((await api.builtinSystemPrompt()).prompt.sections[0].text, "changed in caller");
  } finally {
    if (previous === undefined) delete globalThis.window;
    else globalThis.window = previous;
  }
});
