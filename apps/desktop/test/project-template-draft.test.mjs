import assert from "node:assert/strict";
import test from "node:test";
import {
  addFolder,
  describeFolder,
  draftFromSummary,
  folderNameError,
  isDirty,
  removeFolder,
  toPayload,
} from "../src/features/project-workbench/template-draft.ts";

const software = {
  name: "software",
  path: "/home/templates/software",
  builtin: true,
  categories: ["architecture", "requirements"],
  folders: ["requirements", "architecture", "requirements/api"],
  version: 2,
  description: "Software project",
  categoryDescriptions: { requirements: "Stories", "requirements/api": "Endpoints" },
};

test("a summary becomes a folder tree and round-trips unchanged", () => {
  const draft = draftFromSummary(software);
  assert.deepEqual(draft.folders, [
    { path: "architecture", description: "", saved: true },
    { path: "requirements", description: "Stories", saved: true },
    { path: "requirements/api", description: "Endpoints", saved: true },
  ]);
  assert.equal(isDirty(draft, software), false);
  assert.deepEqual(toPayload(draft).categories, [
    { name: "architecture", description: "" },
    { name: "requirements", description: "Stories" },
    { name: "requirements/api", description: "Endpoints" },
  ]);
  // An older host without `folders` still gives the first level.
  const { folders: _folders, ...old } = software;
  assert.deepEqual(draftFromSummary(old).folders.map((folder) => folder.path), ["architecture", "requirements"]);
});

test("folders are added at any level, described and removed with their children", () => {
  let draft = draftFromSummary(software);
  assert.deepEqual(addFolder(draft, null, "  "), { error: "empty" });
  assert.deepEqual(addFolder(draft, null, "../x"), { error: "invalid" });
  assert.deepEqual(addFolder(draft, "requirements", "a/b"), { error: "invalid" });
  assert.deepEqual(addFolder(draft, null, "requirements"), { error: "duplicate" });
  assert.deepEqual(addFolder(draft, "a/b/c/d/e/f", "g"), { error: "tooDeep" });
  const nested = addFolder(draft, "requirements", " 设计 ");
  assert.ok("draft" in nested);
  assert.equal(nested.path, "requirements/设计");
  draft = describeFolder(nested.draft, "requirements/设计", "UI 稿");
  assert.deepEqual(
    draft.folders.map((folder) => folder.path),
    ["architecture", "requirements", "requirements/api", "requirements/设计"],
    "a child sorts right under its parent",
  );
  draft = removeFolder(draft, "requirements");
  assert.deepEqual(draft.folders.map((folder) => folder.path), ["architecture"]);
  assert.equal(isDirty(draft, software), true);
  assert.equal(toPayload(draft, { create: true, copyFrom: "software" }).copyFrom, "software");
  assert.equal(folderNameError("a\u0001b"), "invalid");
  assert.equal(folderNameError("x".repeat(81)), "invalid");
});
