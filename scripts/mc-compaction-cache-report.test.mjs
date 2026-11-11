import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  parseResponseRecord,
  renderResponsesMarkdown,
  summarizeResponses,
  parseSummaryRecord,
  readMeasures,
  renderMarkdown,
  sessionLogFiles,
  summarize,
  SUMMARY_EVENT,
} from "./mc-compaction-cache-report.mjs";

const SECRET = "sk-secret-should-never-appear";
function record(requestId, data, extra = {}) {
  return JSON.stringify({
    ts: "2026-11-10T00:00:00.000Z", level: "info", channel: "app", category: "session",
    event: SUMMARY_EVENT, message: "context compaction summary attempt",
    sessionId: "s1", requestId, data, ...extra,
  });
}

test("reads only whitelisted fields from a summary record", () => {
  const measure = parseSummaryRecord(record("r1", {
    attempt: 1, api: "anthropic-messages", durationMs: 4200, stopReason: "stop", usageReported: true,
    input: 1000, output: 300, cacheRead: 9000, cacheWrite: 0,
    // Not part of the contract; must not leak into the report.
    summaryText: SECRET, path: "/Users/someone/project",
  }, { apiKey: SECRET }));
  assert.deepEqual(measure, {
    requestId: "r1", api: "anthropic-messages", stopReason: "stop", usageReported: true,
    durationMs: 4200, input: 1000, output: 300, cacheRead: 9000, cacheWrite: 0, attempt: 1,
  });
  assert.equal(JSON.stringify(measure).includes(SECRET), false);
});

test("ignores other events, broken lines and non-numeric values", () => {
  assert.equal(parseSummaryRecord(""), undefined);
  assert.equal(parseSummaryRecord("{not json " + SUMMARY_EVENT), undefined);
  assert.equal(parseSummaryRecord(JSON.stringify({ event: "session.response.end", data: { input: 5 } })), undefined);
  // The event name appearing inside another record's text is not a match.
  assert.equal(parseSummaryRecord(JSON.stringify({ event: "other", message: SUMMARY_EVENT })), undefined);
  const odd = parseSummaryRecord(record("r2", { api: 7, input: "many", cacheRead: -5, durationMs: Number.NaN }));
  assert.equal(odd.api, "unknown");
  assert.equal(odd.input, 0);
  assert.equal(odd.cacheRead, 0);
  assert.equal(odd.durationMs, 0);
  assert.equal(odd.usageReported, false);
});

test("aggregates per API and keeps unreported usage out of the token sums", () => {
  const measures = [
    record("a", { api: "openai-responses", durationMs: 1000, stopReason: "stop", usageReported: true, input: 800, cacheRead: 200, cacheWrite: 0, output: 100 }),
    record("a", { api: "openai-responses", durationMs: 3000, stopReason: "length", usageReported: true, input: 1000, cacheRead: 0, cacheWrite: 0, output: 50 }),
    record("b", { api: "openai-responses", durationMs: 2000, stopReason: "stop", usageReported: false, input: 0, cacheRead: 0, cacheWrite: 0, output: 0 }),
    record("c", { api: "anthropic-messages", durationMs: 500, stopReason: "stop", usageReported: false }),
  ].map(parseSummaryRecord);
  const rows = summarize(measures);
  assert.deepEqual(rows.map((row) => row.api), ["openai-responses", "anthropic-messages"]);
  const openai = rows[0];
  assert.equal(openai.compactions, 2);
  assert.equal(openai.attempts, 3);
  assert.equal(openai.attemptsWithUsage, 2);
  assert.equal(openai.truncatedAttempts, 1);
  assert.equal(openai.inputTokens, 1800);
  assert.equal(openai.cacheReadTokens, 200);
  assert.equal(openai.cacheReadShare, 0.1);
  assert.equal(openai.durationMsP50, 2000);
  assert.equal(openai.durationMsMax, 3000);
  // No usage at all: the share is unknown, not 0%.
  assert.equal(rows[1].cacheReadShare, null);
  assert.match(renderMarkdown(rows), /\| anthropic-messages \|.*\| unknown \|/);
  assert.match(renderMarkdown(rows), /\| openai-responses \|.*\| 10\.0% \|/);
  assert.equal(renderMarkdown([]), "No compaction summary records found.");
});

test("reads session logs and their rotations from a log directory, and nothing else", () => {
  const dir = mkdtempSync(join(tmpdir(), "mc-compaction-report-"));
  mkdirSync(join(dir, "app"));
  const line = record("r1", { api: "openai-responses", durationMs: 10, usageReported: true, input: 1, cacheRead: 1 });
  writeFileSync(join(dir, "app", "session.log"), `${line}\nnot json\n`);
  writeFileSync(join(dir, "app", "session.1.log"), `${line}\n`);
  writeFileSync(join(dir, "app", "tool.log"), `${line}\n`);
  writeFileSync(join(dir, "app", "session.log.bak"), `${line}\n`);
  const files = sessionLogFiles(dir);
  assert.deepEqual(files.map((file) => file.slice(dir.length + 1)), ["app/session.1.log", "app/session.log"]);
  assert.equal(readMeasures(files).length, 2);
  // Passing the app directory itself works too; a missing directory yields nothing.
  assert.equal(sessionLogFiles(join(dir, "app")).length, 2);
  assert.deepEqual(sessionLogFiles(join(dir, "missing")), []);
});

function response(data, extra = {}) {
  return JSON.stringify({ ts: "2026-11-11T00:00:00.000Z", level: "info", channel: "app", category: "session",
    event: "session.response.end", message: "model response ended", sessionId: "s1", requestId: "q", data, ...extra });
}

test("ordinary responses: only the request-side numbers are read, and a missing cache figure is unknown", () => {
  const withCache = parseResponseRecord(response(
    { api: "openai-codex-responses", reason: "stop", modelId: "m", inputTokens: 500, cacheReadTokens: 4500, outputTokens: 80, text: SECRET },
    { apiKey: SECRET },
  ));
  assert.deepEqual(withCache, { api: "openai-codex-responses", input: 500, cacheReported: true, cacheRead: 4500, cacheWrite: 0 });
  const withoutCache = parseResponseRecord(response({ api: "openai-codex-responses", inputTokens: 900 }));
  assert.equal(withoutCache.cacheReported, false);
  // Records from before the request side was logged carry no input at all.
  assert.equal(parseResponseRecord(response({ reason: "stop", outputTokens: 3 })), undefined);
  assert.equal(parseResponseRecord(record("r", { api: "x", input: 1 })), undefined);

  const rows = summarizeResponses([withCache, withoutCache,
    parseResponseRecord(response({ api: "other-api", inputTokens: 10 }))]);
  assert.deepEqual(rows[0], { api: "openai-codex-responses", responses: 2, responsesWithCacheFigure: 1,
    inputTokens: 500, cacheReadTokens: 4500, cacheWriteTokens: 0, cacheReadShare: 0.9 });
  // No response on this API reported a cache figure: unknown, not 0%.
  assert.equal(rows[1].cacheReadShare, null);
  const table = renderResponsesMarkdown(rows);
  assert.match(table, /\| openai-codex-responses \|.*\| 90\.0% \|/);
  assert.match(table, /\| other-api \|.*\| unknown \|/);
  assert.equal(table.includes(SECRET), false);
});
