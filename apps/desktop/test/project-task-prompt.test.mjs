import assert from "node:assert/strict";
import test from "node:test";
import { taskPrompt } from "../src/features/project-workbench/task-prompt.ts";

test("the run prompt carries goal, criteria, resources and the last rejection", () => {
  const prompt = taskPrompt({
    title: "登录接口",
    goal: "实现 POST /login",
    acceptance: "单元测试通过",
    resources: [
      { title: "login.md", path: "/docs/App/requirements/login.md", status: "confirmed" },
      { title: "设计稿", url: "https://example.com/d", status: "draft" },
    ],
    previousRejection: "缺少错误处理",
  });
  assert.match(prompt, /^Task: 登录接口\n\nGoal:\n实现 POST \/login\n/);
  assert.match(prompt, /Acceptance criteria \(the work is reviewed against these\):\n单元测试通过/);
  assert.match(prompt, /- login\.md: \/docs\/App\/requirements\/login\.md\n/);
  assert.match(prompt, /- 设计稿: https:\/\/example\.com\/d \(draft, not yet confirmed\)/);
  assert.match(prompt, /The previous attempt was not accepted:\n缺少错误处理/);
  assert.match(prompt, /Do not claim a criterion is met without checking it/);
});

test("optional parts are left out", () => {
  const prompt = taskPrompt({ title: "T", goal: " ", acceptance: "ok", resources: [] });
  assert.doesNotMatch(prompt, /Goal:|Resources to work from|previous attempt/);
});
