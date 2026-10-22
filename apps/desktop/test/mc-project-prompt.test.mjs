/** mc-agent: a project's system prompt template, chosen in the create/edit dialogs. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { register } from "node:module";
import test from "node:test";

register("./helpers/ts-import-hooks.mjs", import.meta.url);
const { projectPromptTemplateId, withProjectPromptTemplate } = await import(
  "../src/features/project-workbench/project-prompt.ts"
);

const config = (projectRules) => ({
  templates: [
    { id: "a", name: "A", persona: "", append: "" },
    { id: "b", name: "B", persona: "", append: "" },
  ],
  globalTemplateId: null,
  modelRules: [],
  projectRules,
});

test("the current template follows the primary folder, then the other folders", () => {
  const rules = config([
    { path: "/p/web", templateId: "b" },
    { path: "/p/api/", templateId: "a" },
    { path: "/p/gone", templateId: "deleted" },
  ]);
  assert.equal(projectPromptTemplateId(rules, ["/p/api", "/p/web"]), "a");
  assert.equal(projectPromptTemplateId(rules, ["/p/main", "/p/web"]), "b");
  assert.equal(projectPromptTemplateId(rules, ["/p/gone"]), "", "a rule for a removed template does not count");
  assert.equal(projectPromptTemplateId(null, ["/p/web"]), "");
});

test("choosing a template replaces the project's rules and keeps the others", () => {
  const before = config([
    { path: "/other", templateId: "a" },
    { path: "/p/web", templateId: "a" },
    { path: "/p/api", templateId: "b" },
  ]);
  const chosen = withProjectPromptTemplate(before, ["/p/web", "/p/api/"], "/p/api", "b");
  assert.deepEqual(chosen.projectRules, [
    { path: "/other", templateId: "a" },
    { path: "/p/api", templateId: "b" },
  ]);
  const cleared = withProjectPromptTemplate(before, ["/p/web", "/p/api"], "/p/api", "");
  assert.deepEqual(cleared.projectRules, [{ path: "/other", templateId: "a" }]);
  const unknown = withProjectPromptTemplate(before, ["/p/web"], "/p/web", "missing");
  assert.ok(!unknown.projectRules.some((rule) => rule.path === "/p/web"));
});

test("both project dialogs offer the template, local projects only", () => {
  const create = readFileSync(new URL("../src/components/ProjectCreateDialog.tsx", import.meta.url), "utf8");
  const edit = readFileSync(new URL("../src/components/ProjectEditDialog.tsx", import.meta.url), "utf8");
  assert.match(create, /source === "remote" \? null : \(\s*<ProjectPromptPicker/);
  assert.match(create, /promptTemplate: promptTemplate \|\| undefined/);
  assert.match(edit, /group && !group\.remote \? \(\s*<ProjectPromptPicker/);
  assert.match(edit, /promptTemplate !== initialPromptTemplate/);
});
