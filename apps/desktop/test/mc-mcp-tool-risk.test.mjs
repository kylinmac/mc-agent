/**
 * mc-agent (MC-ADR-0014): a plugin this build ships may mark its own MCP
 * tools low risk (`toolRisk`), so reading a window does not ask every time.
 * Any other plugin, or a development copy, keeps every MCP tool at medium.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
register(pathToFileURL(join(here, "helpers/ts-import-hooks.mjs")));

const dataDir = mkdtempSync(join(tmpdir(), "mc-tool-risk-data-"));
process.env.PI_DESKTOP_DATA_DIR = dataDir;
test.after(() => rmSync(dataDir, { recursive: true, force: true }));

const { PluginRuntime } = await import("../electron/main/plugin-runtime.ts");

const builtin = join(tmpdir(), "mc-app", "Resources", "plugins");
const declared = { get_app_state: "low", click: "medium", wipe: "high", odd: "none" };

function risk(runtime, loaded, tool) {
  return runtime["mcpToolRisk"](loaded, declared, tool);
}

test("a shipped plugin's declared MCP tool risk is honoured", () => {
  const runtime = new PluginRuntime({ builtinPluginsDir: builtin });
  const shipped = { path: join(builtin, "mc.computer-use"), development: false };
  assert.equal(risk(runtime, shipped, "get_app_state"), "low");
  assert.equal(risk(runtime, shipped, "wipe"), "high");
  assert.equal(risk(runtime, shipped, "click"), "medium");
  assert.equal(risk(runtime, shipped, "odd"), "medium");
  assert.equal(risk(runtime, shipped, "undeclared"), "medium");
  assert.equal(runtime["mcpToolRisk"](shipped, undefined, "get_app_state"), "medium");
});

test("other plugins and development copies stay at medium", () => {
  const runtime = new PluginRuntime({ builtinPluginsDir: builtin });
  const installed = { path: join(dataDir, "plugins", "mc.computer-use"), development: false };
  const escaping = { path: join(builtin, "..", "elsewhere"), development: false };
  const dev = { path: join(builtin, "mc.computer-use"), development: true };
  for (const loaded of [installed, escaping, dev]) {
    assert.equal(risk(runtime, loaded, "get_app_state"), "medium");
  }
  const unknownBuild = new PluginRuntime({});
  assert.equal(risk(unknownBuild, { path: join(builtin, "x"), development: false }, "get_app_state"), "medium");
});
