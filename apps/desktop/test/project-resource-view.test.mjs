import assert from "node:assert/strict";
import test from "node:test";
import { attentionItems, groupByCategory } from "../src/features/project-workbench/resource-view.ts";

const items = [
  { key: "folder:notes.md", category: "", title: "notes.md", status: "draft" },
  { key: "folder:reference/api.md", category: "reference", title: "api.md", status: "missing" },
  { key: "entry:1", category: "design", title: "设计稿", status: "confirmed" },
  { key: "folder:requirements/a.md", category: "requirements", title: "a.md", status: "changed" },
];

test("groups follow the folder's categories, keep empty ones, and put loose items last", () => {
  const groups = groupByCategory(items, ["architecture", "reference", "requirements"]);
  assert.deepEqual(
    groups.map((group) => [group.category, group.items.map((item) => item.key)]),
    [
      ["architecture", []],
      ["reference", ["folder:reference/api.md"]],
      ["requirements", ["folder:requirements/a.md"]],
      ["design", ["entry:1"]],
      ["", ["folder:notes.md"]],
    ],
  );
});

test("changed resources come before missing ones in the attention list", () => {
  assert.deepEqual(
    attentionItems(items).map((item) => item.key),
    ["folder:requirements/a.md", "folder:reference/api.md"],
  );
});
