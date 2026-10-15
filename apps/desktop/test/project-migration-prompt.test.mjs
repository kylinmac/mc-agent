import assert from "node:assert/strict";
import test from "node:test";
import { migrationPrompt } from "../src/features/project-workbench/migration-prompt.ts";

test("the instruction names the folders, categories and the copy-only rule for workspaces", () => {
  const prompt = migrationPrompt({
    resourceFolder: "/docs/mc-agent/projects/App",
    categories: ["requirements", "reference"],
    templateName: "software",
    workspaces: [
      { path: "/code/web", description: "前端" },
      { path: "/code/server" },
      { path: "/materials/brand", description: "品牌素材", kind: "reference" },
    ],
  });
  assert.match(prompt, /Resource folder: \/docs\/mc-agent\/projects\/App/);
  assert.match(prompt, /- requirements\/\n- reference\//);
  assert.match(prompt, /Development workspaces[^\n]*\n- \/code\/web — 前端\n- \/code\/server\n/);
  assert.match(prompt, /Reference folders[^\n]*\n- \/materials\/brand — 品牌素材\n/);
  assert.match(prompt, /DRAFT one: write a new Markdown file into that category folder/);
  assert.match(prompt, /index the documents of a reference folder; do not organize it as code/);
  assert.match(prompt, /Never modify, move or delete anything inside a workspace/);
  assert.match(prompt, /Do not copy documents out of a workspace\. INDEX a workspace document/);
  assert.match(prompt, /INDEX, MOVE or DRAFT/);
  assert.match(prompt, /Do not change any file before the plan is approved/);
  assert.match(prompt, /This list is complete; do not look for the template elsewhere/);
  assert.match(prompt, /do not browse their parent folders or any other path/);
});

test("a template without categories keeps files at the root", () => {
  const prompt = migrationPrompt({
    resourceFolder: "/r",
    categories: [],
    templateName: "blank",
    workspaces: [],
  });
  assert.match(prompt, /no categories; keep files at the folder root/);
  assert.match(prompt, /Development workspaces[^\n]*\n- \(none\)/);
});
