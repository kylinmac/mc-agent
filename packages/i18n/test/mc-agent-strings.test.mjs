import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "vitest";

// mc-agent: the generated `mcProject` block of every catalog must be exactly
// what mc-agent-strings.json produces. They drifted once (18 keys and several
// reworded strings lived only in the catalogs), and regenerating would have
// deleted that copy from all nine languages.
test("every catalog's mc-agent block matches mc-agent-strings.json", () => {
  const script = fileURLToPath(new URL("../scripts/mc-agent-strings.mjs", import.meta.url));
  const result = spawnSync(process.execPath, [script, "--check"], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});
