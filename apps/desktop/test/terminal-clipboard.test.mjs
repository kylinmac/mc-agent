import assert from "node:assert/strict";
import test from "node:test";
import { terminalCopyKeyHandler } from "../src/features/work-tools/terminal-clipboard.ts";

function key(overrides = {}) {
  return { type: "keydown", key: "c", ctrlKey: true, shiftKey: true, metaKey: false, altKey: false,
    preventDefault() { this.prevented = true; }, stopPropagation() {}, ...overrides };
}

test("selected terminal output copies without sending the shortcut to the shell", async () => {
  const writes = [];
  const handler = terminalCopyKeyHandler(() => "错误\nsecond line", async text => { writes.push(text); }, assert.fail);
  for (const modifiers of [{}, { shiftKey: false }, { ctrlKey: false, shiftKey: false, metaKey: true }]) {
    const event = key(modifiers);
    assert.equal(handler(event), false);
    assert.equal(event.prevented, true);
  }
  await Promise.resolve();
  assert.deepEqual(writes, Array(3).fill("错误\nsecond line"));
  assert.equal(handler(key({ type: "keyup" })), false);
  assert.equal(writes.length, 3);
});

test("empty selection preserves Ctrl+C interrupt and does not erase clipboard", () => {
  const handler = terminalCopyKeyHandler(() => "", assert.fail, assert.fail);
  assert.equal(handler(key({ shiftKey: false })), true);
  assert.equal(handler(key()), false);
  assert.equal(handler(key({ key: "v" })), true);
  assert.equal(handler(key({ altKey: true })), true);
});

test("clipboard rejection is reported", async () => {
  const errors = [];
  const error = new Error("denied");
  const handler = terminalCopyKeyHandler(() => "text", async () => { throw error; }, value => errors.push(value));
  assert.equal(handler(key()), false);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(errors, [error]);
});

test("terminal shortcuts select, clear and scroll while native paste and shell keys pass through", () => {
  const calls = [];
  const handler = terminalCopyKeyHandler(() => "", assert.fail, assert.fail, {
    selectAll: () => calls.push("all"), clear: () => calls.push("clear"),
    scrollPages: pages => calls.push(pages), scrollToTop: () => calls.push("top"), scrollToBottom: () => calls.push("bottom"),
  });
  for (const name of ["a", "k"]) assert.equal(handler(key({ key: name })), false);
  for (const name of ["PageUp", "PageDown", "Home", "End"]) assert.equal(handler(key({ key: name, ctrlKey: false })), false);
  assert.deepEqual(calls, ["all", "clear", -1, 1, "top", "bottom"]);
  for (const event of [key({ key: "v" }), key({ key: "l", shiftKey: false }), key({ key: "a", shiftKey: false })]) assert.equal(handler(event), true);
});
