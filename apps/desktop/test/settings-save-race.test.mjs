import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { setImmediate } from "node:timers/promises";
import test from "node:test";
import ts from "typescript";

const source = await readFile(new URL("../src/features/settings/SettingsPage.tsx", import.meta.url), "utf8");
const parsed = ts.createSourceFile("SettingsPage.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let initializer;
function visit(node) {
  if (ts.isVariableDeclaration(node) && node.name.getText(parsed) === "saveSettings") initializer = node.initializer;
  ts.forEachChild(node, visit);
}
visit(parsed);
assert.ok(initializer, "exercise the settings page's actual save handler");
const { outputText } = ts.transpileModule(`const save = ${initializer.getText(parsed)};`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
});

function fixture() {
  const initial = { defaultMode: "agent", theme: "light", askToolAutoContinue: false, askToolTimeoutSeconds: 30 };
  let settings = { ...initial };
  let stored = { ...initial };
  const pending = [];
  const writes = [];
  const store = {
    getState: () => ({ settings }),
    setState: (update) => {
      settings = (typeof update === "function" ? update({ settings }) : update).settings;
    },
  };
  const api = {
    setSettings: (patch) => new Promise((resolve, reject) => {
      writes.push(structuredClone(patch));
      pending.push({
        resolve: () => { stored = { ...stored, ...patch }; resolve(); },
        reject,
      });
    }),
  };
  const save = new Function("settings", "useAppStore", "api", "refreshProviders", "settingsSaveQueue", `${outputText}\nreturn save;`)(
    settings, store, api, async () => {}, Promise.resolve(),
  );
  return { save, pending, writes, store, settings: () => settings, stored: () => stored };
}

test("rapid settings edits preserve both preferences in storage and the current view", async () => {
  const f = fixture();
  const first = f.save({ askToolAutoContinue: true });
  const second = f.save({ askToolTimeoutSeconds: 60 });
  await setImmediate();
  // Resolve concurrently issued writes backwards; a serialized writer has one at a time.
  while (f.pending.length) {
    f.pending.pop().resolve();
    await setImmediate();
  }
  await Promise.all([first, second]);
  for (const value of [f.stored(), f.settings()]) {
    assert.equal(value.askToolAutoContinue, true);
    assert.equal(value.askToolTimeoutSeconds, 60);
  }
});

test("a failed preference save does not discard a later edit or overwrite newer store fields", async () => {
  const f = fixture();
  const first = f.save({ askToolAutoContinue: true });
  const rejected = assert.rejects(first, /write failed/);
  const second = f.save({ askToolTimeoutSeconds: 60 });
  await setImmediate();
  f.pending.shift().reject(new Error("write failed"));
  await rejected;
  await setImmediate();
  f.store.setState({ settings: { ...f.settings(), theme: "dark" } });
  f.pending.shift().resolve();
  await second;
  assert.equal(f.settings().askToolAutoContinue, false);
  assert.equal(f.settings().askToolTimeoutSeconds, 60);
  assert.equal(f.settings().theme, "dark");
  assert.deepEqual(f.writes[1], { askToolTimeoutSeconds: 60 });
});
