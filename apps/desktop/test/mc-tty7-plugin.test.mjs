/**
 * mc-agent (R42): bundled `mc.tty7` opt-in MCP plugin — manifest & risk tier
 * validation, argument sanitization, real stdio MCP JSON-RPC handshake, and
 * McpServerClient integration.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { register } from "node:module";
import { fileURLToPath } from "node:url";

register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));

const PLUGIN_ROOT = fileURLToPath(new URL("../resources/plugins/mc.tty7", import.meta.url));
const SERVER_PATH = join(PLUGIN_ROOT, "mcp-server.mjs");

const {
  TOOLS,
  buildCliArgs,
  handleJsonRpcMessage,
  invokeTool,
  normalizePaneId,
  validateKeyName,
} = await import("../resources/plugins/mc.tty7/mcp-server.mjs");
const { McpServerClient } = await import("../electron/main/plugin-mcp.ts");
const { validateManifest, validateMcpServer } = await import("@pi-desktop/plugin-sdk");

test("manifest declares opt-in plugin with read-only low-risk tools and guarded write tools", async () => {
  const manifest = JSON.parse(await readFile(join(PLUGIN_ROOT, "manifest.json"), "utf8"));
  const manifestCheck = validateManifest(manifest);
  assert.equal(manifestCheck.ok, true, JSON.stringify(manifestCheck));
  assert.equal(manifest.id, "mc.tty7");
  assert.equal(manifest.enabledByDefault, false);
  assert.ok(manifest.i18n?.en?.name);
  assert.ok(manifest.i18n?.["zh-CN"]?.name);
  assert.ok(manifest.i18n?.["zh-TW"]?.name);

  const [server] = manifest.contributes.mcpServers;
  const validated = validateMcpServer(server);
  assert.equal(validated.ok, true);

  const lowRisk = new Set(Object.keys(server.toolRisk ?? {}));
  for (const ro of [
    "doctor",
    "list_machines",
    "list_workspaces",
    "list_panes",
    "capture_pane",
    "pane_procs",
    "list_agents",
    "wait_pane",
  ]) {
    assert.equal(server.toolRisk[ro], "low", `${ro} should be low risk`);
  }
  for (const writeTool of ["exec_in_pane", "send_to_pane", "split_pane", "new_workspace", "close_pane"]) {
    assert.equal(lowRisk.has(writeTool), false, `${writeTool} must NOT be low risk`);
  }

  const skillText = await readFile(join(PLUGIN_ROOT, manifest.contributes.skills[0].path), "utf8");
  assert.match(skillText, /OPT-IN ONLY/);
  assert.match(skillText, /Never start `tty7-server` yourself/);
});

test("argument normalization builds safe argv and rejects flag injection and invalid inputs", () => {
  assert.equal(normalizePaneId("42"), "%42");
  assert.equal(normalizePaneId("%7"), "%7");
  assert.equal(normalizePaneId(3), "%3");
  assert.throws(() => normalizePaneId("--all"));
  assert.throws(() => normalizePaneId("%1; rm -rf /"));

  assert.equal(validateKeyName("C-c"), "C-c");
  assert.equal(validateKeyName("enter"), "enter");
  assert.throws(() => validateKeyName("--bad"));

  assert.deepEqual(buildCliArgs("doctor", { machine: "prod@host" }).argv, ["-m", "prod@host", "doctor", "--json"]);
  assert.throws(() => buildCliArgs("doctor", { machine: "--evil" }));

  assert.deepEqual(buildCliArgs("capture_pane", { pane: "12", scrollback: true, tail: 50 }).argv, [
    "capture",
    "--plain",
    "--scrollback",
    "--tail",
    "50",
    "%12",
  ]);

  const execSpec = buildCliArgs("exec_in_pane", { pane: "%3", command: "ls -la && pwd", timeoutSecs: 45 });
  assert.deepEqual(execSpec.argv, ["exec", "--timeout", "45", "%3", "--", "ls -la && pwd"]);
  assert.throws(() => buildCliArgs("exec_in_pane", { pane: "%3", command: "echo a\necho b" }));

  const sendSpec = buildCliArgs("send_to_pane", {
    pane: "%5",
    text: "hello",
    paste: true,
    enter: true,
    keys: ["C-c"],
  });
  assert.deepEqual(sendSpec.argv, ["send", "--json", "--stdin", "--paste", "--enter", "--key", "C-c", "%5"]);
  assert.equal(sendSpec.stdinText, "hello");
  assert.throws(() => buildCliArgs("send_to_pane", { pane: "%5" }));
});

test("invokeTool handles untrusted output wrapping, wait timeout 124, and errors", async () => {
  const captured = await invokeTool(
    "capture_pane",
    { pane: "%1" },
    {
      run: async () => ({ exitCode: 0, stdout: "prompt$ ls\nREADME.md\n", stderr: "", stdoutExceeded: false }),
    },
  );
  assert.equal(captured.isError, undefined);
  assert.match(captured.content[0].text, /untrusted data/i);
  assert.match(captured.content[0].text, /README\.md/);

  const timedOut = await invokeTool(
    "wait_pane",
    { pane: "%1", until: ["free"] },
    {
      run: async () => ({ exitCode: 124, stdout: "", stderr: "timed out", stdoutExceeded: false }),
    },
  );
  assert.equal(timedOut.isError, undefined);
  assert.equal(JSON.parse(timedOut.content[0].text).timedOut, true);

  const failed = await invokeTool(
    "doctor",
    {},
    {
      run: async () => ({ exitCode: 1, stdout: "", stderr: "server not reachable", stdoutExceeded: false }),
    },
  );
  assert.equal(failed.isError, true);
  assert.match(failed.content[0].text, /server not reachable/);

  const unknown = await handleJsonRpcMessage({
    jsonrpc: "2.0",
    id: 9,
    method: "tools/call",
    params: { name: "nope", arguments: {} },
  });
  assert.equal(unknown.result.isError, true);
});

test("McpServerClient connects to real stdio mcp-server.mjs and invokes stubbed tty7 binary", async () => {
  const temp = await mkdtemp(join(tmpdir(), "mc-tty7-stub-"));
  const stub = join(temp, "fake-tty7.mjs");
  try {
    await writeFile(
      stub,
      `#!/usr/bin/env node
const args = process.argv.slice(2);
let stdin = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => { stdin += c; });
process.stdin.on("end", () => {
  if (args[0] === "doctor") {
    process.stdout.write(JSON.stringify({ server: { reachable: true, build: "26.10.0" } }) + "\\n");
    return;
  }
  if (args[0] === "send") {
    process.stdout.write(JSON.stringify({ ok: true, stdin, args }) + "\\n");
    return;
  }
  process.stdout.write(JSON.stringify({ args }) + "\\n");
});
`,
      "utf8",
    );
    await chmod(stub, 0o755);

    const manifest = JSON.parse(await readFile(join(PLUGIN_ROOT, "manifest.json"), "utf8"));
    const validated = validateMcpServer(manifest.contributes.mcpServers[0]);
    assert.equal(validated.ok, true);

    const client = new McpServerClient({
      pluginId: "mc.tty7",
      rootPath: PLUGIN_ROOT,
      server: validated.server,
      values: { TTY7_BIN: stub },
    });

    try {
      const discovered = await client.connect();
      assert.equal(discovered.length, TOOLS.length);
      assert.ok(discovered.some((t) => t.name === "doctor"));
      assert.ok(discovered.some((t) => t.name === "exec_in_pane"));

      const docRes = await client.callTool("doctor", {});
      assert.match(docRes.content[0].text, /"reachable":true/);

      const sendRes = await client.callTool("send_to_pane", {
        pane: "%9",
        text: "secret-line",
        enter: true,
      });
      const parsed = JSON.parse(sendRes.content[0].text);
      assert.equal(parsed.stdin, "secret-line");
      assert.ok(parsed.args.includes("--stdin"));
      assert.ok(!parsed.args.includes("secret-line"));
    } finally {
      client.close();
    }
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("real mcp-server.mjs speaks valid NDJSON initialize and tools/list over stdio", async () => {
  const child = spawn(process.execPath, [SERVER_PATH], { stdio: ["pipe", "pipe", "pipe"] });
  const lines = [];
  let buf = "";
  const received = new Promise((resolveDone) => {
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      buf += chunk;
      let idx = buf.indexOf("\n");
      while (idx >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (line) lines.push(JSON.parse(line));
        if (lines.length >= 2) resolveDone();
        idx = buf.indexOf("\n");
      }
    });
  });

  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })}\n`);
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} })}\n`);
  await received;
  child.kill("SIGTERM");

  assert.equal(lines[0].id, 1);
  assert.equal(lines[0].result.serverInfo.name, "mc-tty7");
  assert.equal(lines[1].id, 2);
  assert.equal(lines[1].result.tools.length, TOOLS.length);
});
