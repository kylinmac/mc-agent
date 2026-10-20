import assert from "node:assert/strict";
import test from "node:test";
import { compactTokens, fillDays } from "../src/features/settings/usage-model.ts";

// mc-agent: usage statistics page helpers (MC-ADR-0011).

const day = (name, total) => ({
  day: name,
  inputTokens: total,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  reasoningTokens: 0,
  totalTokens: total,
  turns: 1,
});

test("token counts read compactly", () => {
  assert.equal(compactTokens(999), "999");
  assert.equal(compactTokens(12_345), "12.3k");
  assert.equal(compactTokens(3_400_000), "3.40M");
  assert.equal(compactTokens(2_000_000_000), "2.00B");
});

test("the chart covers every day of the range, empty days included", () => {
  const from = new Date("2026-10-01T00:00:00").getTime();
  const to = new Date("2026-10-05T12:00:00").getTime();
  const filled = fillDays([day("2026-10-02", 5), day("2026-10-04", 7)], from, to);
  assert.deepEqual(filled.map((entry) => entry.day), ["2026-10-01", "2026-10-02", "2026-10-03", "2026-10-04", "2026-10-05"]);
  assert.deepEqual(filled.map((entry) => entry.totalTokens), [0, 5, 0, 7, 0]);
  assert.deepEqual(fillDays([], from, to), []);
});

const counts = (total) => ({
  inputTokens: total,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  reasoningTokens: 0,
  totalTokens: total,
  turns: 1,
});

test("models get color slots in share order and the tail folds into other", async () => {
  const { MODEL_SERIES_COLORS, dayStacks, daysForModel, modelKey, modelSeries } = await import(
    "../src/features/settings/usage-model.ts"
  );
  const byModel = Array.from({ length: MODEL_SERIES_COLORS + 2 }, (_, index) => ({
    providerId: "p",
    providerName: "P",
    modelId: `m${index}`,
    ...counts(100 - index),
  }));
  const series = modelSeries(byModel, "Other", "Unknown");
  assert.equal(series.length, MODEL_SERIES_COLORS + 1);
  assert.deepEqual(series.slice(0, 2).map((entry) => [entry.label, entry.color]), [["m0", 0], ["m1", 1]]);
  assert.equal(series.at(-1).key, "");
  assert.equal(series.at(-1).total, 100 - MODEL_SERIES_COLORS + (100 - MODEL_SERIES_COLORS - 1));
  assert.ok(Math.abs(series.reduce((sum, entry) => sum + entry.share, 0) - 1) < 1e-9);

  const byDayModel = [
    { day: "2026-10-01", providerId: "p", modelId: "m0", ...counts(5) },
    { day: "2026-10-01", providerId: "p", modelId: `m${MODEL_SERIES_COLORS + 1}`, ...counts(2) },
    { day: "2026-10-02", providerId: "p", modelId: "m0", ...counts(7) },
  ];
  const stacks = dayStacks(byDayModel, series);
  assert.equal(stacks.get("2026-10-01").get(modelKey(byModel[0])), 5);
  assert.equal(stacks.get("2026-10-01").get(""), 2);
  assert.deepEqual(daysForModel(byDayModel, modelKey(byModel[0])).map((day) => [day.day, day.totalTokens]), [
    ["2026-10-01", 5],
    ["2026-10-02", 7],
  ]);
});

test("the y-axis rounds up to a clean scale and dates thin out", async () => {
  const { labelStep, niceCeil } = await import("../src/features/settings/usage-model.ts");
  assert.equal(niceCeil(18_620_000), 20_000_000);
  assert.equal(niceCeil(2_100), 2_500);
  assert.equal(niceCeil(1_000), 1_000);
  assert.equal(niceCeil(0), 1);
  assert.equal(labelStep(30), 4);
  assert.equal(labelStep(7), 1);
});
