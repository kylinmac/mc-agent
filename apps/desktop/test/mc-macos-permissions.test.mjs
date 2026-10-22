/**
 * mc-agent macOS permissions page (X-PERM-02): Accessibility and Screen
 * Recording come from the Computer Use helper, never from Main; checking does
 * not prompt; one item is requested at a time; settings pages are fixed URLs.
 */
import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

register("./helpers/ts-import-hooks.mjs", import.meta.url);
const { MacPermissions, SETTINGS_URLS, macPermissionItemOf, parseHelperAnswer } = await import(
  "../electron/main/mc-macos-permissions.ts"
);

function helper(answer, calls) {
  return {
    execute: async (args) => {
      calls.push(args);
      if (answer instanceof Error) throw answer;
      return { content: [{ type: "text", text: JSON.stringify(answer) }], isError: false };
    },
  };
}

function setup({ tool = null, mic = "not-determined", platform = "darwin" } = {}) {
  const opened = [];
  const asked = [];
  const permissions = new MacPermissions({
    platform,
    helperTool: () => tool,
    microphoneStatus: () => mic,
    askMicrophone: async () => {
      asked.push("mic");
      return true;
    },
    openUrl: async (url) => opened.push(url),
    identity: () => ({ name: "mc-agent", version: "1.0.3", bundlePath: "/Applications/mc-agent.app", bundleId: "x", signature: "adhoc" }),
    now: () => 42,
    timeoutMs: 50,
  });
  return { permissions, opened, asked };
}

const state = (report, item) => report.items.find((entry) => entry.item === item).state;

test("checking asks the running helper without prompting and keeps microphone states", async () => {
  const calls = [];
  const tool = helper(
    { accessibility: true, screenRecording: false, checkedBy: { pid: 7, executable: "/x/mc-computer" } },
    calls,
  );
  const { permissions, opened } = setup({ tool, mic: "restricted" });
  const report = await permissions.check();
  assert.deepEqual(calls, [{}], "no request_item, no open_settings");
  assert.equal(state(report, "accessibility"), "granted");
  assert.equal(state(report, "screenRecording"), "notGranted");
  assert.equal(state(report, "microphone"), "restricted");
  assert.equal(report.app.helperPid, 7);
  assert.deepEqual(opened, []);
});

test("a stopped helper is not started, and a failing one is told apart from a refusal", async () => {
  assert.equal(state(await setup().permissions.check(), "accessibility"), "helperOff");
  const broken = setup({ tool: helper(new Error("boom"), []) });
  const report = await broken.permissions.check();
  assert.equal(state(report, "screenRecording"), "helperError");
  assert.match(report.items[0].detail, /boom/);
  const silent = setup({ tool: { execute: () => new Promise(() => undefined) } });
  assert.equal(state(await silent.permissions.check(), "accessibility"), "helperError");
});

test("requests go one item at a time to the right place", async () => {
  const calls = [];
  const tool = helper({ accessibility: false, screenRecording: false }, calls);
  const { permissions, opened, asked } = setup({ tool });
  await permissions.request("accessibility");
  await permissions.request("screenRecording");
  assert.deepEqual(calls, [
    { request_item: "accessibility", open_settings: "accessibility" },
    { request_item: "screenRecording" },
  ]);
  await permissions.request("microphone");
  assert.deepEqual(asked, ["mic"], "never asked: the system prompt");
  const denied = setup({ tool, mic: "denied" });
  await denied.permissions.request("microphone");
  assert.deepEqual(denied.asked, []);
  assert.deepEqual(denied.opened, [SETTINGS_URLS.microphone], "denied: the settings page instead");
});

test("only known items pass, and other platforms report unsupported", async () => {
  assert.equal(macPermissionItemOf("microphone"), "microphone");
  for (const bad of ["camera", "x-apple.systempreferences:evil", undefined, 3]) {
    assert.throws(() => macPermissionItemOf(bad));
  }
  const windows = await setup({ platform: "win32" }).permissions.check();
  assert.equal(windows.supported, false);
  assert.ok(windows.items.every((entry) => entry.state === "unsupported"));
  assert.throws(() => parseHelperAnswer({ content: [{ type: "text", text: "{}" }] }));
  assert.throws(() => parseHelperAnswer({ isError: true, content: [{ type: "text", text: "nope" }] }), /nope/);
});
