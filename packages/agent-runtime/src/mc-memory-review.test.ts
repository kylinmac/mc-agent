import { describe, expect, it } from "vitest";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { memoryReviewRequest, parseMemoryReview } from "./mc-memory-review.js";

const reply = (text: string) => ({ role: "assistant", content: [{ type: "text", text }] }) as unknown as AssistantMessage;

describe("memory review", () => {
  it("asks with the current notes and the mode", () => {
    const request = memoryReviewRequest("- [agent-1] (project, editable) Tests: run node", "consolidate");
    expect(request).toContain("[agent-1]");
    expect(request).toContain("duplicates");
    expect(memoryReviewRequest("", "auto")).toContain("(none)");
  });

  it("reads suggestions out of a JSON answer, even wrapped in prose", () => {
    const parsed = parseMemoryReview(
      reply(`Sure:\n{"suggestions":[
        {"action":"add","scope":"user","kind":"user","title":"Language","hook":"replies in Chinese","content":"Reply in Chinese, briefly.","reason":"asked twice"},
        {"action":"update","target":"agent-1","title":"Tests","content":"Run the Node tests."},
        {"action":"remove","target":"agent-2","title":"","content":""},
        {"action":"update","title":"no target","content":"x"},
        {"action":"delete","target":"x","title":"t","content":"c"}
      ]}`),
    );
    expect(parsed).toEqual([
      { action: "add", scope: "user", kind: "user", title: "Language", hook: "replies in Chinese", content: "Reply in Chinese, briefly.", reason: "asked twice" },
      { action: "update", scope: "project", target: "agent-1", title: "Tests", content: "Run the Node tests." },
      { action: "remove", scope: "project", target: "agent-2", title: "", content: "" },
    ]);
  });

  it("gives nothing for an answer that is not JSON, and keeps at most three", () => {
    expect(parseMemoryReview(reply("Nothing worth keeping."))).toEqual([]);
    const many = JSON.stringify({
      suggestions: Array.from({ length: 6 }, (_, i) => ({ action: "add", title: `t${i}`, content: "c" })),
    });
    expect(parseMemoryReview(reply(many))).toHaveLength(3);
  });
});
