/** mc-agent (bugs.md B-005): weekly schedules name their days. */
import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

register("./helpers/ts-import-hooks.mjs", import.meta.url);
const { cadenceLabel } = await import("../src/features/scheduled/scheduled-labels.ts");

const t = (key, values) => (values?.days ? `${key}:${values.days}` : key);
const weekly = (weekdays, weekday = 0) => ({ cadence: "weekly", schedule: { hour: 9, minute: 0, weekday, weekdays } });

test("weekly cadences say which days", () => {
  assert.equal(cadenceLabel(t, weekly([4, 0, 1, 2, 3]), "en"), "mcProject.schedEveryWeekday");
  assert.equal(cadenceLabel(t, weekly([6, 5]), "en"), "mcProject.schedEveryWeekend");
  assert.equal(cadenceLabel(t, weekly([0, 1, 2, 3, 4, 5, 6]), "en"), "scheduled.cadenceDaily");
  assert.equal(cadenceLabel(t, weekly([0, 2]), "en"), "mcProject.schedWeeklyOn:Mon · Wed");
  // Older tasks have only the single legacy day.
  assert.equal(cadenceLabel(t, weekly(undefined, 4), "en"), "mcProject.schedWeeklyOn:Fri");
  assert.equal(cadenceLabel(t, { cadence: "daily", schedule: { hour: 9, minute: 0, weekday: 0 } }, "en"), "scheduled.cadenceDaily");
});
