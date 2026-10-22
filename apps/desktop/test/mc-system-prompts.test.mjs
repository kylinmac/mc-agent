import assert from "node:assert/strict";
import test from "node:test";
import { modelMatches, resolvePromptTemplate, templatePrompt } from "../electron/main/mc-system-prompts.ts";

// mc-agent: one system prompt template per conversation (MC-ADR-0010).

const template = (id, persona = "", append = "") => ({ id, name: id.toUpperCase(), persona, append });
const config = {
  templates: [template("proj", "P"), template("claude", "C"), template("sonnet", "S"), template("global", "", "G")],
  globalTemplateId: "global",
  modelRules: [
    { pattern: "claude-*", templateId: "claude" },
    { pattern: "claude-sonnet-5", templateId: "sonnet" },
  ],
  projectRules: [{ path: "/work/app/", templateId: "proj" }],
};

test("model patterns match with * and ignore case", () => {
  assert.ok(modelMatches("claude-*", "Claude-Opus-5"));
  assert.ok(modelMatches("gpt-5*", "gpt-5.1"));
  assert.ok(!modelMatches("gpt-5*", "xgpt-5"));
  assert.ok(modelMatches("grok-4.7", "grok-4.7"));
  assert.ok(!modelMatches("grok-4.7", "grok-4x7"));
});

test("project beats model beats global, and the winner applies whole", () => {
  assert.equal(resolvePromptTemplate(config, { projectPaths: ["/work/app"], modelId: "claude-opus-5" }).template.id, "proj");
  // Any folder of a multi-folder project counts.
  assert.equal(
    resolvePromptTemplate(config, { projectPaths: ["/work/docs", "/work/app"], modelId: null }).match.kind,
    "project",
  );
  assert.equal(resolvePromptTemplate(config, { projectPaths: ["/elsewhere"], modelId: "claude-opus-5" }).template.id, "claude");
  assert.equal(resolvePromptTemplate(config, { projectPaths: [], modelId: "grok-4.7" }).match.kind, "global");
  assert.equal(resolvePromptTemplate({ ...config, globalTemplateId: null }, { projectPaths: [], modelId: "grok-4.7" }), null);
});

test("project rules match folders: the start folder first, then the others in list order", () => {
  const folders = {
    ...config,
    templates: [...config.templates, template("docs"), template("app2")],
    projectRules: [
      { path: "/work/docs", templateId: "docs" },
      { path: "/work/app/", templateId: "proj" },
    ],
  };
  // Started in app: its rule wins although docs is listed first.
  const fromApp = resolvePromptTemplate(folders, { projectPaths: ["/work/app", "/work/docs"], modelId: null });
  assert.deepEqual([fromApp.template.id, fromApp.match.path], ["proj", "/work/app/"]);
  // Started in a folder without a rule: the first listed rule among the others.
  const fromTests = resolvePromptTemplate(folders, {
    projectPaths: ["/work/tests", "/work/app", "/work/docs"],
    modelId: null,
  });
  assert.equal(fromTests.template.id, "docs");
  // A rule whose template is gone is skipped, not matched.
  const dangling = { ...folders, projectRules: [{ path: "/work/app", templateId: "gone" }] };
  assert.equal(resolvePromptTemplate(dangling, { projectPaths: ["/work/app"], modelId: null }).match.kind, "global");
});

test("an exact model wins over a pattern", () => {
  const resolved = resolvePromptTemplate(config, { projectPaths: [], modelId: "claude-sonnet-5" });
  assert.equal(resolved.template.id, "sonnet");
  assert.deepEqual(resolved.match, { kind: "model", pattern: "claude-sonnet-5" });
});

test("an empty template part keeps the default", () => {
  assert.deepEqual(templatePrompt(template("x", "  ", "rules")), { append: "rules" });
  assert.deepEqual(templatePrompt(template("y", "persona", "")), { replace: "persona" });
  assert.deepEqual(templatePrompt(template("z")), {});
});
