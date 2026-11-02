import { describe, expect, it } from "vitest";
import type { UiMessage, ContextCompactionRecord } from "@pi-desktop/shared";
import type { MessageEntry } from "./pi-runtime-types.js";
import { contextRequestShape, inspectContextRestore, verifiedContextRestore } from "./mc-context-integrity.js";

const row = (id: string, role: UiMessage["role"], content = "private body"): UiMessage =>
  ({ id, role, content, createdAt: new Date(1).toISOString() });
const history = [row("old", "user"), row("/private/id", "user"), row("result", "assistant")];
const entries: MessageEntry[] = history.map((m, seq) => ({ type: "message", id: m.id, seq,
  parentId: null, timestamp: 1, message: { role: "user", content: m.content, timestamp: 1 } }));
const checkpoint: ContextCompactionRecord = { id: "private-checkpoint", throughMessageId: "old", summary: "private summary", tokensBefore: 10, createdAt: new Date(1).toISOString() };
const messages = entries.map((e) => e.message);

describe("restore integrity", () => {
  it("rejects a boundary present in raw history but filtered from the restored entries", () => {
    const filtered = entries.slice(1);
    const raw = [{ ...history[0], content: "" }, ...history.slice(1)];
    const reports: unknown[] = [];
    const recovered = verifiedContextRestore(raw, filtered, checkpoint,
      () => filtered.map((entry) => entry.message), (report) => reports.push(report));
    expect(recovered.checkpoint).toBeUndefined();
    expect(reports).toMatchObject([
      { ok: false, boundaryMissing: true, missingCount: 0 },
      { ok: true, fallback: true, expectedCount: 2 },
    ]);
  });
  it("checks original post-boundary IDs and order, not just message count", () => {
    const input = { history, entries, checkpoint };
    expect(inspectContextRestore({ ...input, messages: messages.slice(1) })).toMatchObject({ ok: true, expectedCount: 2 });
    const dropped = inspectContextRestore({ ...input, messages: [messages[2]] });
    expect(dropped).toMatchObject({ ok: false, missingCount: 1 });
    expect(JSON.stringify(dropped)).not.toMatch(/private|body|summary/);
    expect(inspectContextRestore({ ...input, messages: [messages[2], messages[1]] })).toMatchObject({ ok: false, reordered: true });
    expect(inspectContextRestore({ ...input, messages: [messages[1], messages[2], messages[2]] })).toMatchObject({ ok: false, reordered: true });
    expect(inspectContextRestore({ ...input, messages, checkpoint: { ...checkpoint, throughMessageId: "absent" } })).toMatchObject({ ok: false, boundaryMissing: true });
  });
  it("accounts for legitimate exclusions without misclassifying failed tool results", () => {
    const excluded: UiMessage[] = [
      row("system", "system"), { ...row("delegate", "assistant"), parentToolCallId: "tool" },
      { ...row("failed", "assistant"), status: "error" }, row("empty-user", "user", ""),
      row("empty-assistant", "assistant", ""), row("tool", "tool"),
    ];
    const check = inspectContextRestore({ history: excluded, entries: [], messages: [] });
    expect(check).toMatchObject({ ok: true, expectedCount: 0, exclusions: { system: 1, delegate: 1, failed_assistant: 1, empty_user: 1, empty_assistant: 1, incomplete_tool: 1 } });
    expect(inspectContextRestore({ history: [{ ...row("tool", "tool"), toolName: "Read", toolCallId: "tool", isError: true }], entries: [], messages: [] })).toMatchObject({ ok: false, missingCount: 1 });
  });
  it("retries full history once and reports the failed attempt before installing recovery", () => {
    const reports: unknown[] = [];
    const recovered = verifiedContextRestore(history, entries, checkpoint,
      (candidate) => candidate ? [messages[2]] : messages, (report) => reports.push(report));
    expect(recovered.checkpoint).toBeUndefined();
    expect(recovered.messages).toEqual(messages);
    expect(reports).toMatchObject([{ ok: false, attempt: 1 }, { ok: true, attempt: 2, fallback: true }]);
  });
  it("stops when projection loses records even without a checkpoint", () => {
    let attempts = 0;
    expect(() => verifiedContextRestore(history, entries.slice(1), checkpoint,
      () => [], () => { attempts++; })).toThrow();
    expect(attempts).toBe(2);
    attempts = 0;
    expect(() => verifiedContextRestore(history, [], undefined, () => [], () => { attempts++; })).toThrow();
    expect(attempts).toBe(1);
  });
  it("records only fixed request roles and counts", () => {
    expect(contextRequestShape([{ role: "user" }, { role: "secret-role" }], 42))
      .toEqual({ requestCount: 2, roleCounts: { user: 1, other: 1 }, estimatedTokens: 42 });
  });
});
