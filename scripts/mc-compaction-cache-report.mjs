#!/usr/bin/env node
/**
 * mc-agent (R21.3, #122): summarize compaction summary requests from app logs.
 *
 * Answers one question: when a conversation is compacted, how much of the
 * summary request's input was read from the provider's prompt cache, and how
 * long did it take? That is the baseline R21.3 needs before deciding whether a
 * conversation-shaped summary request is worth building.
 *
 * Read-only. It opens the session log files under the directory you pass and
 * looks only at `session.compaction.summary` records, and within those only at
 * the numeric fields listed in NUMERIC_FIELDS plus `api`, `stopReason` and
 * `usageReported`. Nothing else from a record is read into the report, so no
 * conversation text, path or key can appear in its output.
 *
 * Usage:
 *   node scripts/mc-compaction-cache-report.mjs <log-dir> [--json]
 *
 * <log-dir> is the app's log directory (the one that contains `app/`), or the
 * `app/` directory itself. There is no default: the script never goes looking
 * for an installed app's data on its own.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const SUMMARY_EVENT = "session.compaction.summary";
const NUMERIC_FIELDS = ["durationMs", "input", "output", "cacheRead", "cacheWrite", "attempt"];

function finite(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

/** One log line → the whitelisted measurement, or undefined for anything else. */
export function parseSummaryRecord(line) {
  const text = line.trim();
  if (!text || !text.includes(SUMMARY_EVENT)) return undefined;
  let record;
  try {
    record = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!record || typeof record !== "object" || record.event !== SUMMARY_EVENT) return undefined;
  const data = record.data && typeof record.data === "object" ? record.data : {};
  const measure = {
    requestId: typeof record.requestId === "string" ? record.requestId : "",
    api: typeof data.api === "string" && data.api ? data.api : "unknown",
    stopReason: typeof data.stopReason === "string" ? data.stopReason : "unknown",
    usageReported: data.usageReported === true,
  };
  for (const field of NUMERIC_FIELDS) measure[field] = finite(data[field]);
  return measure;
}

function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index];
}

/**
 * Aggregate per wire API. Attempts whose provider reported no usage are counted
 * but kept out of the token sums: an unreported cache read is unknown, not zero.
 */
export function summarize(measures) {
  const byApi = new Map();
  for (const measure of measures) {
    let group = byApi.get(measure.api);
    if (!group) {
      group = { api: measure.api, attempts: 0, requests: new Set(), usageReported: 0, truncated: 0,
        input: 0, cacheRead: 0, cacheWrite: 0, output: 0, durations: [] };
      byApi.set(measure.api, group);
    }
    group.attempts += 1;
    if (measure.requestId) group.requests.add(measure.requestId);
    if (measure.stopReason === "length") group.truncated += 1;
    group.durations.push(measure.durationMs);
    if (!measure.usageReported) continue;
    group.usageReported += 1;
    group.input += measure.input;
    group.cacheRead += measure.cacheRead;
    group.cacheWrite += measure.cacheWrite;
    group.output += measure.output;
  }
  return [...byApi.values()]
    .map((group) => {
      const durations = [...group.durations].sort((a, b) => a - b);
      const requestInput = group.input + group.cacheRead + group.cacheWrite;
      return {
        api: group.api,
        compactions: group.requests.size,
        attempts: group.attempts,
        attemptsWithUsage: group.usageReported,
        truncatedAttempts: group.truncated,
        inputTokens: group.input,
        cacheReadTokens: group.cacheRead,
        cacheWriteTokens: group.cacheWrite,
        outputTokens: group.output,
        // Share of the request side served from cache; null when nothing was reported.
        cacheReadShare: requestInput > 0 ? group.cacheRead / requestInput : null,
        durationMsP50: percentile(durations, 50),
        durationMsP90: percentile(durations, 90),
        durationMsMax: durations.at(-1) ?? 0,
      };
    })
    .sort((a, b) => b.attempts - a.attempts || a.api.localeCompare(b.api));
}

/** `session.log`, `session.1.log`, … under <dir>/app or <dir>. */
export function sessionLogFiles(dir) {
  const appDir = existsSync(join(dir, "app")) ? join(dir, "app") : dir;
  if (!existsSync(appDir) || !statSync(appDir).isDirectory()) return [];
  return readdirSync(appDir)
    .filter((name) => /^session(\.\d+)?\.log$/.test(name))
    .sort()
    .map((name) => join(appDir, name));
}

export function readMeasures(files) {
  const measures = [];
  for (const file of files) {
    for (const line of readFileSync(file, "utf8").split("\n")) {
      const measure = parseSummaryRecord(line);
      if (measure) measures.push(measure);
    }
  }
  return measures;
}

const number = (value) => value.toLocaleString("en-US");
const seconds = (ms) => `${(ms / 1000).toFixed(1)}s`;

export function renderMarkdown(rows) {
  if (rows.length === 0) return "No compaction summary records found.";
  const lines = [
    "| API | Compactions | Attempts | With usage | Truncated | Input | Cache read | Cache write | Output | Cache read share | p50 | p90 | max |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
  ];
  for (const row of rows) {
    lines.push(`| ${[
      row.api, number(row.compactions), number(row.attempts), number(row.attemptsWithUsage), number(row.truncatedAttempts),
      number(row.inputTokens), number(row.cacheReadTokens), number(row.cacheWriteTokens), number(row.outputTokens),
      row.cacheReadShare === null ? "unknown" : `${(row.cacheReadShare * 100).toFixed(1)}%`,
      seconds(row.durationMsP50), seconds(row.durationMsP90), seconds(row.durationMsMax),
    ].join(" | ")} |`);
  }
  return lines.join("\n");
}

function main(argv) {
  const json = argv.includes("--json");
  const dir = argv.find((arg) => !arg.startsWith("--"));
  if (!dir) {
    console.error("Usage: node scripts/mc-compaction-cache-report.mjs <log-dir> [--json]");
    return 2;
  }
  const files = sessionLogFiles(dir);
  if (files.length === 0) {
    console.error(`No session log files under ${dir}`);
    return 1;
  }
  const rows = summarize(readMeasures(files));
  console.log(json ? JSON.stringify(rows, null, 2) : renderMarkdown(rows));
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = main(process.argv.slice(2));
}
