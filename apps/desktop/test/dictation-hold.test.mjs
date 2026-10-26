import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { KEYBOARD_SHORTCUTS, isAllowedKeybinding, keybindingsConflict } from "@pi-desktop/shared";

test("hold to talk: the key-down starts, any key-up or leaving the window ends", async (t) => {
  const server = await createServer({ root: fileURLToPath(new URL("..", import.meta.url)), configFile: false,
    server: { middlewareMode: true, hmr: false, ws: false }, appType: "custom", optimizeDeps: { noDiscovery: true, include: [] } });
  t.after(() => server.close());
  const originals = new Map(["window", "document"].map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  t.after(() => { for (const [name, descriptor] of originals) { if (descriptor) Object.defineProperty(globalThis, name, descriptor); else delete globalThis[name]; } });
  const listeners = new Map();
  const fire = (type) => { for (const listener of [...(listeners.get(type) ?? [])]) listener({ type }); };
  Object.defineProperty(globalThis, "window", { configurable: true, value: {
    addEventListener: (type, listener) => listeners.set(type, new Set([...(listeners.get(type) ?? []), listener])),
    removeEventListener: (type, listener) => listeners.get(type)?.delete(listener),
  } });
  let active = null;
  Object.defineProperty(globalThis, "document", { configurable: true, value: { get activeElement() { return active; } } });
  const { beginDictationHold, registerDictationHoldTarget } = await server.ssrLoadModule("/src/features/voice/dictation/dictation-hold.ts");

  assert.equal(beginDictationHold(), false, "no composer, nothing to take the hold");

  const events = [];
  const composer = (name) => {
    const dock = { contains: (node) => node === `${name}-input` };
    return { element: () => ({ closest: () => dock }), begin: () => events.push(`${name}:begin`), end: () => events.push(`${name}:end`) };
  };
  const unregisterLeft = registerDictationHoldTarget(composer("left"));
  const unregisterRight = registerDictationHoldTarget(composer("right"));

  // The focused composer takes it; a second key-down while held is ignored.
  active = "left-input";
  assert.equal(beginDictationHold(), true);
  assert.equal(beginDictationHold(), true);
  fire("keyup");
  fire("keyup");
  assert.deepEqual(events, ["left:begin", "left:end"]);

  // Without focus in a composer, the last one registered takes it; leaving the window ends it.
  active = null; events.length = 0;
  beginDictationHold();
  fire("blur");
  assert.deepEqual(events, ["right:begin", "right:end"]);

  // A composer that goes away mid-hold is not ended later.
  events.length = 0;
  beginDictationHold();
  unregisterRight();
  fire("keyup");
  assert.deepEqual(events, ["right:begin"]);
  unregisterLeft();
});

test("the hold shortcut is configurable, allowed and free by default", () => {
  const hold = KEYBOARD_SHORTCUTS.find((shortcut) => shortcut.id === "dictationHold");
  assert.ok(hold);
  assert.equal(hold.group, "agent");
  assert.ok(isAllowedKeybinding(hold.defaultBinding));
  for (const other of KEYBOARD_SHORTCUTS) {
    if (other === hold) continue;
    assert.equal(keybindingsConflict(hold.defaultBinding, other.defaultBinding), false, other.id);
    assert.equal(keybindingsConflict(hold.defaultBinding, other.macDefaultBinding), false, other.id);
  }
});

test("a short tap is dropped and a release while the microphone opens still ends the hold", () => {
  const button = readFileSync(new URL("../src/features/voice/dictation/DictationButton.tsx", import.meta.url), "utf8");
  const shell = readFileSync(new URL("../src/features/app/useAppShellRuntime.tsx", import.meta.url), "utf8");
  assert.match(button, /const HOLD_MIN_MS = 400;/);
  assert.match(button, /Date\.now\(\) - pressed\.pressedAt < HOLD_MIN_MS\) void cancel\(\)/);
  assert.match(button, /if \(hold\.current\?\.released\) endHold\(\);/);
  assert.match(button, /registerDictationHoldTarget\(\{/);
  // A hold whose start failed or was abandoned must not stop a later click-started recording.
  assert.match(button, /catch \(error\) \{\s*\/\/[^\n]*\n\s*hold\.current = null;/);
  assert.match(button, /\{ hold\.current = null; await current\.cancel\(\); return; \}/);
  assert.match(button, /onClick=\{\(\) => \{ hold\.current = null; void \(phase === "recording"/);
  assert.match(shell, /if \(shortcut\.id === "dictationHold"\) \{\s*if \(e\.repeat \|\| beginDictationHold\(\)\) e\.preventDefault\(\);/);
});
