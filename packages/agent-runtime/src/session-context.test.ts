import { describe, expect, it } from "vitest";
import type {
  AgentMessage,
} from "@earendil-works/pi-agent-core";
import type { CompactionEntry, MessageEntry } from "./pi-runtime-types.js";
import { buildSessionContext } from "./session-context.js";

function user(id: string, text: string, seq: number): MessageEntry {
  return {
    type: "message",
    id,
    parentId: null,
    seq,
    timestamp: seq,
    message: { role: "user", content: text, timestamp: seq },
  };
}

function assistant(
  id: string,
  text: string,
  seq: number,
  stopReason: "stop" | "error" | "aborted" = "stop",
): MessageEntry {
  return {
    type: "message",
    id,
    parentId: null,
    seq,
    timestamp: seq,
    message: {
      role: "assistant",
      api: "openai-completions",
      provider: "local",
      model: "local",
      usage: {
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason,
      timestamp: seq,
      content: [{ type: "text", text }],
    } as AgentMessage,
  };
}

function compaction(
  id: string,
  seq: number,
  tail: AgentMessage[] = [],
): CompactionEntry {
  return {
    type: "compaction",
    id,
    parentId: null,
    seq,
    timestamp: seq,
    summary: "older work",
    tokensBefore: 100,
    retainedTail: tail,
    fromHook: false,
  };
}

describe("buildSessionContext", () => {
  it.each([false, true])("restores a split tool batch without replaying compacted results (retained=%s)", (retained) => {
    const carrier = assistant("calls", "compacted text", 1);
    if (carrier.message.role !== "assistant") throw new Error("expected assistant");
    carrier.message.content.push(
      { type: "toolCall", id: "early", name: "Read", arguments: { path: "early.ts" } },
      { type: "toolCall", id: "late", name: "Read", arguments: { path: "late.ts" } },
    );
    const result = (id: string, seq: number): MessageEntry => ({ type: "message", id, seq,
      parentId: "calls", timestamp: seq, message: { role: "toolResult", toolCallId: id, toolName: "Read",
        content: [{ type: "text", text: `result ${id}` }], isError: false, timestamp: seq } });
    const late = result("late", 4);
    const entries = [user("old", "old request", 0), carrier, result("early", 2),
      compaction("checkpoint", 3, retained ? [late.message] : []), ...(retained ? [] : [late])];
    const original = structuredClone(entries);
    const { messages } = buildSessionContext(entries);
    expect(messages).toMatchObject([
      { role: "compactionSummary" },
      { role: "assistant", content: [{ type: "toolCall", id: "late", name: "Read", arguments: { path: "late.ts" } }] },
      { role: "toolResult", toolCallId: "late" },
    ]);
    expect(messages[2]).toBe(late.message);
    expect(JSON.stringify(messages)).not.toMatch(/compacted text|early/);
    expect(entries).toEqual(original);
    expect(buildSessionContext(entries).messages).toEqual(messages);
  });

  it("does not duplicate a call already present in the retained tail", () => {
    const carrier = assistant("call", "", 0);
    if (carrier.message.role !== "assistant") throw new Error("expected assistant");
    carrier.message.content = [{ type: "toolCall", id: "read", name: "Read", arguments: {} }];
    const result: AgentMessage = { role: "toolResult", toolCallId: "read", toolName: "Read",
      content: [{ type: "text", text: "kept" }], isError: false, timestamp: 1 };
    const messages = buildSessionContext([carrier, compaction("checkpoint", 2, [carrier.message, result])]).messages;
    expect(messages).toHaveLength(3);
    expect(messages[1]).toBe(carrier.message);
    expect(messages[2]).toBe(result);
  });

  it("passes message entries through and drops failed assistants", () => {
    const messages = buildSessionContext([
      user("u1", "hello", 0),
      assistant("a1", "failed", 1, "error"),
      assistant("a2", "ok", 2),
    ]).messages;
    expect(messages.map((message) => message.role)).toEqual(["user", "assistant"]);
    expect(
      messages[1] && "content" in messages[1]
        ? (messages[1].content as { text?: string }[])[0]?.text
        : undefined,
    ).toBe("ok");
  });

  it("drops assistants that have no content blocks", () => {
    // D446: an accepted silent completion reply, or any other empty
    // assistant, is not worth resending and would be rejected by providers.
    const empty = assistant("a1", "", 1);
    (empty.message as { content: unknown[] }).content = [];
    const messages = buildSessionContext([
      user("u1", "notice", 0),
      empty,
      user("u2", "next", 2),
      assistant("a2", "answer", 3),
    ]).messages;
    expect(messages.map((message) => message.role)).toEqual(["user", "user", "assistant"]);
  });

  it("slices from the newest compaction and puts the summary before the tail", () => {
    const keptUser = user("u2", "keep me", 3).message;
    const messages = buildSessionContext([
      user("u0", "old", 0),
      assistant("a0", "old answer", 1),
      compaction("c1", 2, [keptUser]),
      user("u3", "next", 3),
    ]).messages;
    expect(messages.map((message) => message.role)).toEqual([
      "compactionSummary",
      "user",
      "user",
    ]);
    expect(JSON.stringify(messages)).toContain("older work");
    expect(JSON.stringify(messages)).toContain("keep me");
    expect(JSON.stringify(messages)).toContain("next");
    expect(JSON.stringify(messages)).not.toContain("old answer");
  });

  it("replays retained reasoning between the summary and the user tail", () => {
    // #296
    const keptUser = user("u2", "keep me", 3).message;
    const entry = compaction("c1", 2, [keptUser]);
    entry.details = {
      retainedReasoning: [{ thinking: "prior plan", text: "prior answer" }],
    };
    const messages = buildSessionContext([
      user("u0", "old", 0),
      assistant("a0", "old answer", 1),
      entry,
      user("u3", "next", 3),
    ]).messages;
    expect(messages.map((message) => message.role)).toEqual([
      "compactionSummary",
      "assistant",
      "user",
      "user",
    ]);
    expect(JSON.stringify(messages)).toContain("prior plan");
    expect(JSON.stringify(messages)).toContain("keep me");
    expect(JSON.stringify(messages)).not.toContain("old answer");
  });

  it("does not replay DeepSeek reasoning into a different provider", () => {
    const keptUser = user("u2", "keep me", 3).message;
    const entry = compaction("c1", 2, [keptUser]);
    entry.details = {
      retainedReasoning: [{ thinking: "prior DeepSeek plan", text: "answer" }],
    };
    const messages = buildSessionContext(
      [entry, user("u3", "next", 4)],
      {
        api: "anthropic-messages",
        provider: "anthropic",
        model: "claude-opus-4-6",
        requiresCompletionsReasoningReplay: false,
      },
    ).messages;
    expect(messages.map((message) => message.role)).toEqual([
      "compactionSummary",
      "user",
      "user",
    ]);
    expect(JSON.stringify(messages)).not.toContain("prior DeepSeek plan");
  });

});
