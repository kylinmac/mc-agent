#!/usr/bin/env node
// Own test window only; no model, user profile or installed desktop app.
import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, relative, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";

assert.equal(process.platform, "win32", "This test requires an unlocked Windows desktop");
const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const temp = await mkdtemp(join(tmpdir(), "mc-computer-test-"));
const stateFile = join(temp, "state.json");
const pending = new Map();
let sequence = 0;
// Extensionless command intentionally matches the bundled plugin manifest.
const helper = spawn(join(root, "apps/desktop/resources/plugins/mc.computer-use/bin/mc-computer"), ["mcp"], { windowsHide: true, stdio: ["pipe", "pipe", "inherit"] });
helper.on("error", error => { for (const entry of pending.values()) entry.reject(error); });
const lines = createInterface({ input: helper.stdout });
lines.on("line", line => {
  const response = JSON.parse(line);
  const entry = pending.get(response.id);
  if (entry) { clearTimeout(entry.timer); pending.delete(response.id); entry.resolve(response.result); }
});
function rpc(method, params = {}) {
  const id = ++sequence;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Timeout: ${method}`)); }, 30000);
    pending.set(id, { resolve, reject, timer });
    helper.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  });
}
async function call(name, args = {}, error = false) {
  const result = await rpc("tools/call", { name, arguments: args });
  assert.equal(!!result.isError, error, `${name}: ${JSON.stringify(result).slice(0, 1800)}`);
  return result;
}
const text = result => result.content.filter(c => c.type === "text").map(c => c.text).join("\n");
async function state() { try { return JSON.parse((await readFile(stateFile, "utf8")).replace(/^\uFEFF/, "")); } catch { return null; } }
async function wait(check, label) {
  for (let n = 0; n < 100; n++) { if (await check()) return; await delay(100); }
  throw new Error(`Timed out: ${label}; fixture=${JSON.stringify(await state())}`);
}
let fixture;
try {
  assert.equal((await rpc("initialize")).serverInfo.name, "mc-computer");
  assert.equal((await rpc("tools/list")).tools.length, 11);
  await call("permissions");
  const fixtureExe = join(temp, "ComputerUseFixture.exe");
  const compiler = join(process.env.SystemRoot ?? "C:/Windows", "Microsoft.NET/Framework64/v4.0.30319/csc.exe");
  await promisify(execFile)(compiler, ["/nologo", "/target:winexe", "/platform:x64", "/reference:System.Windows.Forms.dll", "/reference:System.Drawing.dll", "/reference:System.Web.Extensions.dll", `/out:${fixtureExe}`, join(root, "scripts/e2e/fixtures/computer-use/WindowsFixture.cs")], { windowsHide: true });
  // This is the interactive GUI under test, not a console or background helper.
  fixture = spawn(fixtureExe, [stateFile], { stdio: ["ignore", "ignore", "inherit"] });
  await wait(async () => !!await state(), "fixture ready");
  const app = String((await state()).pid);
  assert.ok(JSON.parse(text(await call("list_apps"))).some(item => String(item.pid) === app), "fixture appears in list_apps");
  await call("get_app_state", { app });
  assert.match(text(await call("click", { app, x: 10, y: 10 }, true)), /screenshot before/);
  let snapshot = await call("get_app_state", { app, full: true, screenshot: true });
  assert.ok(snapshot.content.some(c => c.type === "image" && c.mimeType === "image/png"), text(snapshot));
  assert.doesNotMatch(text(snapshot), /fixture-secret-do-not-expose/);
  await writeFile(`${stateFile}.maximize`, "");
  await wait(async () => (await state())?.windowState === "Maximized", "maximize fixture");
  const maximized = await call("get_app_state", { app, screenshot: true });
  assert.ok(maximized.content.some(c => c.type === "image"), text(maximized));
  await writeFile(`${stateFile}.restore`, "");
  await wait(async () => (await state())?.windowState === "Normal", "restore fixture");
  snapshot = await call("get_app_state", { app, full: true });
  const element = name => {
    const line = text(snapshot).split("\n").find(line => line.includes(name));
    assert.ok(line, `Missing ${name}: ${text(snapshot)}`);
    const match = line.match(/^\s*(\d+)\s/);
    assert.ok(match, line);
    return Number(match[1]);
  };
  const read = async () => { snapshot = await call("get_app_state", { app, full: true }); };
  await call("set_value", { app, element_index: element("Test input"), value: "UIA replacement" });
  await wait(async () => (await state())?.text === "UIA replacement", "ValuePattern");
  await read();
  await call("click", { app, element_index: element("Test input") });
  await call("run", { app, steps: [
    { do: "press_key", key: "ctrl+Home" }, { do: "press_key", key: "ctrl+shift+End" },
    { do: "type_text", text: "Windows 中文🙂" },
    { do: "press_key", key: "Return" }, { do: "type_text", text: "second line" },
  ] });
  await wait(async () => (await state())?.text.replace(/\r/g, "") === "Windows 中文🙂\nsecond line", "Unicode text and chord");
  await read();
  await call("perform_action", { app, element_index: element("Test button"), action: "Invoke" });
  await wait(async () => (await state())?.clicks === 1, "InvokePattern");
  await read();
  await call("click", { app, element_index: element("Test button") });
  await wait(async () => (await state())?.clicks === 2, "SendInput click");
  await read();
  await call("perform_action", { app, element_index: element("Test checkbox"), action: "Toggle" });
  await wait(async () => (await state())?.checked, "TogglePattern");
  await read();
  await call("perform_action", { app, element_index: element("Expandable test node"), action: "Expand" });
  await wait(async () => (await state())?.expanded, "ExpandCollapsePattern");
  await read();
  await call("set_value", { app, element_index: element("Test password"), value: "blocked" }, true);
  await writeFile(`${stateFile}.password`, "");
  await wait(async () => (await state())?.passwordFocused, "focus fixture password");
  assert.match(text(await call("type_text", { app, text: "blocked" }, true)), /Password/);
  assert.ok((await state()).passwordUnchanged);
  await call("click", { app, x: -1, y: 0 }, true);
  await call("click", { app, element_index: 999999 }, true);
  snapshot = await call("get_app_state", { app, full: true, screenshot: true });
  const png = Buffer.from(snapshot.content.find(c => c.type === "image").data, "base64");
  const width = png.readUInt32BE(16), height = png.readUInt32BE(20);
  assert.ok(Math.max(width, height) <= 1280);
  const x = Math.floor(width * 0.8), y = Math.floor(height * 0.85);
  await call("scroll", { app, x, y, direction: "down", pages: 1 });
  await wait(async () => (await state())?.wheel > 0, "wheel input");
  await call("drag", { app, from_x: x - 100, from_y: y, to_x: x, to_y: y });
  await wait(async () => (await state())?.drag > 0, "drag input");
  const original = (await state()).left;
  await writeFile(`${stateFile}.move`, "");
  await wait(async () => (await state())?.left !== original, "move fixture");
  assert.match(text(await call("click", { app, x, y }, true)), /moved or resized/);
  await writeFile(`${stateFile}.close`, "");
  await new Promise(resolve => fixture.once("exit", resolve));
  await call("press_key", { app, key: "a" }, true);
  console.log("PASS Windows Computer Use: MCP, UIA tree/value/actions, PNG, Unicode/chords, click/drag/scroll, stale coordinates, password and closed-window rejection");
} finally {
  helper.stdin.end();
  helper.kill();
  fixture?.kill();
  lines.close();
  for (const entry of pending.values()) clearTimeout(entry.timer);
  assert.ok(!relative(resolve(tmpdir()), resolve(temp)).startsWith("..") && basename(temp).startsWith("mc-computer-test-"), "cleanup stays in the test's temporary directory");
  await rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
