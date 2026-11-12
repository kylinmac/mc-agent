import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileRevealLineScript, revealFileLine } from "../electron/main/mc-file-reveal-line.ts";
import { fileManagerPluginTab } from "../src/lib/work-panel-tabs.ts";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");

test("a file manager tab carries the reference's line beside its path", () => {
  assert.equal(fileManagerPluginTab("docs/a.md", 69).line, 69);
  assert.equal(fileManagerPluginTab("docs/a.md", 69).location, "docs/a.md");
  assert.equal("line" in fileManagerPluginTab("docs/a.md"), false);
});

test("the reveal script embeds the path and line as data", () => {
  const script = fileRevealLineScript('/p/it\'s "odd"\\name.md', 12);
  assert.doesNotThrow(() => new Function(script));
  assert.ok(script.includes(JSON.stringify('/p/it\'s "odd"\\name.md')));
  assert.match(script, /const line = 12;/);
});

test("revealing a line runs once in a live view and never in a destroyed one", () => {
  const calls = [];
  const live = { isDestroyed: () => false, executeJavaScript: async (s) => { calls.push(s); } };
  revealFileLine(live, "a.md", 3);
  revealFileLine({ ...live, isDestroyed: () => true }, "a.md", 3);
  assert.equal(calls.length, 1);
});

test("only an explicit open sends a line, and only the file manager moves to it", async () => {
  const [tab, host] = await Promise.all([
    read("../src/components/workpanel/PluginViewTab.tsx"),
    read("../electron/main/plugin-view-host.ts"),
  ]);
  // A restored or re-measured tab must not jump back to an old line.
  assert.match(tab, /\.\.\.\(explicit \? \{ force: true, \.\.\.\(lineRef\.current \? \{ line: lineRef\.current \} : \{\}\) \} : \{\}\)/);
  assert.match(host, /entry\.pluginId !== "pi\.file-manager" \|\| !location \|\| !line/);
  // A document still loading is reached once it finishes.
  assert.match(host, /wc\.once\("did-finish-load", \(\) => revealFileLine\(wc, location, line\)\)/);
});
