import assert from "node:assert/strict";
import test from "node:test";
import { migrationPrompt } from "../src/features/project-workbench/migration-prompt.ts";

test("the instruction names the folders, categories and the copy-only rule for workspaces", () => {
  const prompt = migrationPrompt({
    resourceFolder: "/docs/mc-agent/projects/App",
    categories: ["requirements", "reference"],
    templateName: "software",
    workspaces: [{ path: "/code/web", description: "前端" }, { path: "/code/server" }],
  });
  assert.match(prompt, /Resource folder: \/docs\/mc-agent\/projects\/App/);
  assert.match(prompt, /- requirements\/\n- reference\//);
  assert.match(prompt, /- \/code\/web — 前端\n- \/code\/server\n/);
  assert.match(prompt, /Never modify, move or delete anything inside a workspace/);
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
  assert.match(prompt, /Workspaces to look through \(read only\):\n- \(none\)/);
});
