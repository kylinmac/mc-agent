/** mc-agent (MC-ADR-0023): the home composer's project suggestion and the plan helpers. */
import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

register("./helpers/ts-import-hooks.mjs", import.meta.url);
const { looksLikeNewProject, NEW_PROJECT_PREFIX } = await import(
  "../src/features/project-create/new-project-intent.ts"
);
const { freeTemplateName, planSteps } = await import("../src/features/project-create/plan.ts");

test("project requests are suggested; talk about an existing project is not", () => {
  for (const text of [
    "帮我建一个微信小程序的记账项目，放在 ~/code 下面",
    "我要做一个 B 站知识区视频的项目",
    "新建项目：个人博客",
    "Create a new project for my blog in ~/code",
    "set up a Rust CLI project",
  ]) {
    assert.equal(looksLikeNewProject(text), true, text);
  }
  for (const text of [
    "我在做的项目有个 bug",
    "这个项目怎么做部署",
    "how do I build this project",
    "/skill:mc-agent/new-project 记账",
    "项目",
  ]) {
    assert.equal(looksLikeNewProject(text), false, text);
  }
});

test("the prefix names the built-in skill", () => {
  assert.equal(NEW_PROJECT_PREFIX, "/skill:mc-agent/new-project ");
});

test("a saved draft never overwrites a template", () => {
  assert.equal(freeTemplateName("video", ["software"]), "video");
  assert.equal(freeTemplateName("video", ["Video", "video-2"]), "video-3");
});

test("the progress only lists the steps the plan needs", () => {
  assert.deepEqual(planSteps({ name: "a", path: "/a" }), ["folder", "project"]);
  assert.deepEqual(planSteps({ name: "a", path: "/a", template: "software", promptTemplateId: "p" }), [
    "folder",
    "project",
    "resources",
    "prompt",
  ]);
  assert.deepEqual(
    planSteps({
      name: "a",
      path: "/a",
      draft: { name: "v", description: "", folders: [{ path: "x", description: "" }], systemPrompt: "rules" },
    }),
    ["folder", "project", "resources", "prompt"],
  );
});
