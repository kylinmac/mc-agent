import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { migrationPrompt } from "../src/features/project-workbench/migration-prompt.ts";

const input = {
  resourceFolder: "/resources/App",
  categories: ["requirements", "reference"],
  templateName: "software",
  workspaces: [
    { path: "/code/web", description: "前端" },
    { path: "/materials/brand", kind: "reference", description: "品牌素材" },
  ],
};

test("English planning prompt scopes inspection and requires explicit approval", () => {
  const prompt = migrationPrompt({ ...input, language: "en-US" });
  for (const text of ["/resources/App", "- requirements/", "- reference/", "/code/web — 前端", "/materials/brand — 品牌素材", "ProjectHistory", "SubmitPlan", "explicit approval", "approval bar", "automatically switches to Agent", "upstream manuals", "Leave empty categories empty", "Never modify, move or delete", "Do not browse parent", "INDEX.md", "Do not register files already inside"]) assert.ok(prompt.includes(text), text);
  assert.doesNotMatch(prompt, /Work directly|DRAFT one/);
});

test("Chinese UI language produces Chinese guidance and an empty-category fallback", () => {
  for (const language of ["zh-CN", "zh-TW"]) {
    const prompt = migrationPrompt({ ...input, language, categories: [], workspaces: [] });
    for (const text of ["ProjectHistory", "请用中文", "只读", "明确批准", "点击计划审批栏批准", "自动切到 Agent", "项目目标", "预计数量", "上游", "留空", "SubmitPlan", "（无）", "根目录"]) assert.ok(prompt.includes(text), text);
    assert.doesNotMatch(prompt, /Organize this project/);
  }
  assert.match(migrationPrompt({ ...input, language: "fr" }), /English/);
});

test("organizing starts in Plan mode using the UI language", () => {
  const source = readFileSync(new URL("../src/features/project-workbench/TemplateMigration.tsx", import.meta.url), "utf8");
  assert.match(source, /language: i18n.resolvedLanguage/);
  assert.match(source, /mode: "plan"/);
  assert.ok(source.indexOf("configureActiveSession") < source.indexOf("sendPrompt(prompt)"));
});
