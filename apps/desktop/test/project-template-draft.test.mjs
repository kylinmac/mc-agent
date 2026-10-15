import assert from "node:assert/strict";
import test from "node:test";
import {
  addCategory,
  describeCategory,
  draftFromSummary,
  folderNameError,
  isDirty,
  removeCategory,
  toPayload,
} from "../src/features/project-workbench/template-draft.ts";

const software = {
  name: "software",
  path: "/home/templates/software",
  builtin: true,
  categories: ["architecture", "requirements"],
  version: 2,
  description: "Software project",
  categoryDescriptions: { requirements: "Stories" },
};

test("a summary becomes an editable draft and round-trips unchanged", () => {
  const draft = draftFromSummary(software);
  assert.deepEqual(draft.categories, [
    { name: "architecture", description: "", saved: true },
    { name: "requirements", description: "Stories", saved: true },
  ]);
  assert.equal(isDirty(draft, software), false);
  assert.deepEqual(toPayload(draft), {
    name: "software",
    description: "Software project",
    categories: [
      { name: "architecture", description: "" },
      { name: "requirements", description: "Stories" },
    ],
  });
});

test("categories are added, described and removed with host-core's name rules", () => {
  let draft = draftFromSummary(software);
  assert.deepEqual(addCategory(draft, "  "), { error: "empty" });
  assert.deepEqual(addCategory(draft, "../x"), { error: "invalid" });
  assert.deepEqual(addCategory(draft, ".hidden"), { error: "invalid" });
  assert.deepEqual(addCategory(draft, "requirements"), { error: "duplicate" });
  const added = addCategory(draft, " 设计 ");
  assert.ok("draft" in added);
  draft = describeCategory(added.draft, "设计", "UI 稿");
  assert.deepEqual(draft.categories.at(-1), { name: "设计", description: "UI 稿", saved: false });
  draft = removeCategory(draft, "architecture");
  assert.equal(isDirty(draft, software), true);
  assert.deepEqual(toPayload(draft, { create: true, copyFrom: "software" }).categories.map((c) => c.name), [
    "requirements",
    "设计",
  ]);
  assert.equal(toPayload(draft, { create: true, copyFrom: "software" }).copyFrom, "software");
  assert.equal(folderNameError("a\u0001b"), "invalid");
  assert.equal(folderNameError("x".repeat(81)), "invalid");
});
