import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readReleaseNotesState, writeReleaseNotesSeen } from "../electron/main/mc-release-notes-state.ts";

test("a fresh data directory has no record and is not an existing install", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mc-notes-"));
  assert.deepEqual(await readReleaseNotesState(dir), { lastSeen: null, existingInstall: false });
});

test("an earlier version's files mark an existing install until a record is written", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mc-notes-"));
  writeFileSync(join(dir, "window-state.json"), "{}");
  assert.deepEqual(await readReleaseNotesState(dir), { lastSeen: null, existingInstall: true });
  await writeReleaseNotesSeen(dir, "1.0.21");
  assert.deepEqual(await readReleaseNotesState(dir), { lastSeen: "1.0.21", existingInstall: true });
});
