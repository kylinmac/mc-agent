import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readWindowState, writeWindowState } from "../electron/main/window-preferences.ts";

test("the maximized flag survives a save and a read, with the normal rect", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mc-window-"));
  writeWindowState(dir, { x: 10, y: 20, width: 1200, height: 800, maximized: true });
  assert.deepEqual(await readWindowState(dir, 800, 560), { x: 10, y: 20, width: 1200, height: 800, maximized: true });
  writeWindowState(dir, { x: 10, y: 20, width: 1200, height: 800 });
  assert.deepEqual(await readWindowState(dir, 800, 560), { x: 10, y: 20, width: 1200, height: 800 });
  assert.equal(JSON.parse(readFileSync(join(dir, "window-state.json"), "utf8")).maximized, undefined);
});
