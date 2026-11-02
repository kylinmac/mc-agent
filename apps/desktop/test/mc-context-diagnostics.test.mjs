import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { contextDiagnosticData } = await import("../electron/main/runtime/mc-context-diagnostics.ts");
test("context diagnostics keep only bounded structure and opaque fingerprints", () => {
  const hash = "a".repeat(24);
  assert.deepEqual(contextDiagnosticData({
    ok: false, historyCount: 100, missingCount: 2, estimatedTokens: Infinity,
    checkpointKey: hash, boundaryKey: "/private/path", content: "secret", thinking: "secret",
    missingKeys: ["secret", ...Array(10).fill(hash)], roleCounts: { user: 2, secret: 50 },
    exclusions: { system: 1, secret: 1 }, fallback: true,
  }), { historyCount: 100, missingCount: 2, ok: false, fallback: true,
    checkpointKey: hash, missingKeys: Array(5).fill(hash), roleCounts: { user: 2 }, exclusions: { system: 1 } });
});
test("malformed diagnostics do not log nested free text", () => {
  assert.deepEqual(contextDiagnosticData({ roleCounts: { user: "private" }, exclusions: "secret", restoreId: "secret", requestCount: -1 }), { roleCounts: {} });
});
