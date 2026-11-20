import { describe, expect, it } from "vitest";
import { normalizeAlchemyProposalArgs, parseMcRefUri } from "./mc-alchemy.js";

describe("mc-alchemy", () => {
  describe("parseMcRefUri", () => {
    it("parses valid mc:// URIs across all supported kinds", () => {
      expect(parseMcRefUri("mc://resource/rules/review.md")).toEqual({
        ok: true,
        ref: { kind: "resource", relativePath: "rules/review.md" },
        normalized: "mc://resource/rules/review.md",
      });
      expect(parseMcRefUri("mc://workspace/src/app.ts")).toEqual({
        ok: true,
        ref: { kind: "workspace", relativePath: "src/app.ts" },
        normalized: "mc://workspace/src/app.ts",
      });
      expect(parseMcRefUri("mc://prompt/code-review")).toEqual({
        ok: true,
        ref: { kind: "prompt", templateId: "code-review" },
        normalized: "mc://prompt/code-review",
      });
      expect(parseMcRefUri("mc://skill/weekly-report")).toEqual({
        ok: true,
        ref: { kind: "skill", skillId: "weekly-report" },
        normalized: "mc://skill/weekly-report",
      });
      expect(parseMcRefUri("mc://session/sess-123")).toEqual({
        ok: true,
        ref: { kind: "session", sessionId: "sess-123" },
        normalized: "mc://session/sess-123",
      });
      expect(parseMcRefUri("mc://memory")).toEqual({
        ok: true,
        ref: { kind: "memory" },
        normalized: "mc://memory",
      });
    });

    it("rejects traversal, absolute paths, invalid schemes, and bad encoding", () => {
      for (const bad of [
        "",
        "http://example.com/a",
        "mc://resource/../secret.txt",
        "mc://resource/a/%2e%2e/secret.txt",
        "mc://workspace//etc/passwd",
        "mc://workspace/a\\b",
        "mc://memory/extra",
        "mc://prompt/a/b",
        "mc://unknown/foo",
        "mc://resource/%E0%A4%A",
      ]) {
        expect(parseMcRefUri(bad).ok).toBe(false);
      }
    });
  });

  describe("normalizeAlchemyProposalArgs", () => {
    it("normalizes a valid skill proposal and deduplicates refs", () => {
      const res = normalizeAlchemyProposalArgs(
        {
          kind: "skill",
          name: "月度资料核查",
          description: "按项目核查口径检查月度资料并生成汇总。",
          body: "# 步骤\n1. 先调 ResolveRef 读取 mc://resource/rules.md",
          scope: "project",
          refs: ["mc://resource/rules.md", "mc://resource/rules.md", "mc://memory"],
          note: "固化本次核查流程",
          suggestedTrigger: "用月度资料核查处理这批文件",
        },
        { hasProjectPath: true },
      );
      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.value.scope).toBe("project");
        expect(res.value.refs).toEqual(["mc://resource/rules.md", "mc://memory"]);
      }
    });

    it("falls back to global scope when session has no project path", () => {
      const res = normalizeAlchemyProposalArgs(
        {
          kind: "skill",
          name: "Code Review",
          description: "Review PR diffs",
          body: "Check edge cases.",
          scope: "project",
        },
        { hasProjectPath: false },
      );
      expect(res.ok).toBe(true);
      if (res.ok) expect(res.value.scope).toBe("global");
    });

    it("requires description for skill but allows empty description for prompt-template", () => {
      const missingSkillDesc = normalizeAlchemyProposalArgs({
        kind: "skill",
        name: "Test",
        body: "Hello",
      });
      expect(missingSkillDesc.ok).toBe(false);

      const promptTemplate = normalizeAlchemyProposalArgs({
        kind: "prompt-template",
        name: "架构评审模板",
        body: "严格检查边界与测试覆盖。",
      });
      expect(promptTemplate.ok).toBe(true);
    });

    it("rejects invalid refs inside proposal", () => {
      const res = normalizeAlchemyProposalArgs({
        kind: "prompt-template",
        name: "Bad",
        body: "Body",
        refs: ["mc://workspace/../etc/passwd"],
      });
      expect(res.ok).toBe(false);
    });
  });
});
