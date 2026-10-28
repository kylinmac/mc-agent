import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import {
  enabledAppendPrompts,
  modelMatches,
  resolvePromptTemplate,
  templatePrompt,
  withAppendPrompts,
} from "../electron/main/mc-system-prompts.ts";

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

test("the template chosen for a conversation beats project, model and global rules", () => {
  const context = { projectPaths: ["/work/app"], modelId: "claude-opus-5" };
  const chosen = resolvePromptTemplate(config, { ...context, sessionTemplateId: "sonnet" });
  assert.deepEqual([chosen.template.id, chosen.match.kind], ["sonnet", "session"]);
  // No choice, or a choice whose template was deleted: the rules decide as before.
  assert.equal(resolvePromptTemplate(config, { ...context, sessionTemplateId: null }).match.kind, "project");
  assert.equal(resolvePromptTemplate(config, { ...context, sessionTemplateId: "gone" }).match.kind, "project");
  // It applies even where no rule would match at all.
  assert.equal(
    resolvePromptTemplate({ ...config, globalTemplateId: null }, { projectPaths: [], sessionTemplateId: "claude" }).template.id,
    "claude",
  );
});

const appendPrompt = (id, text, enabled = true) => ({ id, name: id.toUpperCase(), text, enabled });

test("enabled append prompts with text apply in list order", () => {
  const withAppends = {
    ...config,
    appendPrompts: [appendPrompt("b", "B"), appendPrompt("off", "X", false), appendPrompt("blank", "  "), appendPrompt("a", " A ")],
  };
  assert.deepEqual(enabledAppendPrompts(withAppends).map((prompt) => prompt.id), ["b", "a"]);
  // Documents saved before append prompts existed have none.
  assert.deepEqual(enabledAppendPrompts(config), []);
  assert.deepEqual(enabledAppendPrompts(null), []);
});

test("append prompts go after the template's rules and replace nothing", () => {
  const prompts = [appendPrompt("b", "B"), appendPrompt("a", " A ")];
  assert.deepEqual(withAppendPrompts({ replace: "P", append: "rules" }, prompts), { replace: "P", append: "rules\n\nB\n\nA" });
  // With no template and no APPEND_SYSTEM.md they still apply.
  assert.deepEqual(withAppendPrompts(undefined, prompts), { append: "B\n\nA" });
  assert.deepEqual(withAppendPrompts({ replace: "SYSTEM.md" }, prompts), { replace: "SYSTEM.md", append: "B\n\nA" });
  // None enabled: the template's prompt is unchanged.
  const template = { replace: "P", append: "rules" };
  assert.equal(withAppendPrompts(template, []), template);
  assert.equal(withAppendPrompts(undefined, []), undefined);
});

test("append prompts never take part in choosing the template", () => {
  // An append prompt id in a rule or as the session choice matches nothing.
  const withAppends = { ...config, globalTemplateId: null, appendPrompts: [appendPrompt("extra", "E")] };
  assert.equal(resolvePromptTemplate(withAppends, { projectPaths: [], sessionTemplateId: "extra" }), null);
});

test("a launch adds the append prompts after choosing the template", () => {
  const source = readFileSync(new URL("../electron/main/runtime/session-launch.ts", import.meta.url), "utf8");
  const chosen = source.indexOf("customSystemPrompt = templatePrompt(resolved.template)");
  const appended = source.indexOf("customSystemPrompt = withAppendPrompts(customSystemPrompt, appendPrompts)");
  assert.ok(chosen > 0 && appended > chosen);
});
