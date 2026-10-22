/**
 * mc-agent creative studio: the renderer's typed `creative.*` methods
 * (@pi-desktop/shared types/creative.ts) are the ones Main lets through and
 * host-core answers. A renamed or misspelled method fails here instead of at
 * run time.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { CREATIVE_RENDERER_METHODS } from "@pi-desktop/shared";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..", "..");
const rpc = readFileSync(join(root, "crates/host-core/src/rpc/mc_creative_rpc.rs"), "utf8");
const ipc = readFileSync(join(here, "..", "electron/main/ipc/mc-creative-ipc.ts"), "utf8");

test("every renderer creative method is one host-core answers", () => {
  const answered = new Set([...rpc.matchAll(/"(creative\.[A-Za-z.]+)"\s*=>/g)].map((match) => match[1]));
  for (const method of CREATIVE_RENDERER_METHODS) {
    assert.ok(answered.has(method), `${method} is not handled by mc_creative_rpc.rs`);
  }
  // Host-only methods stay out of the renderer's reach.
  for (const method of ["creative.jobs.create", "creative.jobs.recordResult", "creative.code.register"]) {
    assert.ok(answered.has(method));
    assert.ok(!CREATIVE_RENDERER_METHODS.includes(method), `${method} must stay Main-only`);
  }
});

test("Main's allowlist is the shared list", () => {
  assert.match(ipc, /new Set\(CREATIVE_RENDERER_METHODS\)/);
  assert.match(ipc, /if \(!PASSTHROUGH\.has\(method\)\) throw invalid/);
});
