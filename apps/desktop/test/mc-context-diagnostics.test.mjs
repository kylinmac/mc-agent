import assert from "node:assert/strict";
import test from "node:test";
import { redactValue } from "../electron/main/logger.ts";
import { responseEndDiagnosticData } from "../electron/main/runtime/mc-context-diagnostics.ts";
import { parseResponseRecord } from "../../../scripts/mc-compaction-cache-report.mjs";

test("B-056: responseEndDiagnosticData avoids logger token redaction while preserving missing buckets", () => {
  const raw = {
    reason: "stop",
    modelId: "gpt-6.1-sol",
    api: "openai-codex-responses",
    inputTokens: 1200,
    outputTokens: 80,
    reasoningTokens: 40,
    cacheReadTokens: 24000,
    durationMs: 950,
  };
  const shaped = responseEndDiagnosticData(raw);
  const redacted = redactValue(shaped);
  assert.deepEqual(redacted, {
    reason: "stop",
    modelId: "gpt-6.1-sol",
    api: "openai-codex-responses",
    durationMs: 950,
    input: 1200,
    output: 80,
    reasoning: 40,
    cacheRead: 24000,
  });
  assert.equal("cacheWrite" in redacted, false);

  const line = JSON.stringify({
    ts: "2026-11-16T08:00:00.000Z",
    level: "info",
    channel: "app",
    category: "session",
    event: "session.response.end",
    message: "model response ended",
    sessionId: "s1",
    requestId: "r1",
    data: redacted,
  });
  assert.deepEqual(parseResponseRecord(line), {
    api: "openai-codex-responses",
    input: 1200,
    cacheReported: true,
    cacheRead: 24000,
    cacheWrite: 0,
  });
});
