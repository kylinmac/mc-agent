import { describe, expect, it, vi } from "vitest";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
  RESTORE_FILE_MAX_TOKENS,
  fitRestoreBudget,
  formatRestoredFiles,
  readRestoreFiles,
  restoreCandidates,
  restoredFilesFromDetails,
  type RestoredFile,
} from "./mc-compaction-file-restore.js";

let nextId = 0;
function call(name: string, args: Record<string, unknown>, ok = true): AgentMessage[] {
  const id = `call-${nextId++}`;
  return [
    { role: "assistant", content: [{ type: "toolCall", id, name, arguments: args }], timestamp: nextId } as unknown as AgentMessage,
    { role: "toolResult", toolCallId: id, toolName: name, content: [{ type: "text", text: "r" }], isError: !ok, timestamp: nextId } as unknown as AgentMessage,
  ];
}

const file = (path: string, chars: number): RestoredFile => ({ path, readAt: "2026-10-30T00:00:00.000Z", text: "x".repeat(chars), truncated: false });

describe("restoreCandidates", () => {
  it("keeps successful reads and writes, newest first, with their ranges", () => {
    const summarized = [
      ...call("Read", { path: "/w/a.ts" }),
      ...call("Read", { path: "/w/failed.ts" }, false),
      ...call("read", { path: "/w/b.ts", offset: 10, limit: 20 }),
      ...call("Edit", { path: "/w/c.ts" }),
      ...call("Read", { path: "/w/a.ts" }),
    ];
    expect(restoreCandidates(summarized, [])).toEqual([
      { path: "/w/a.ts" },
      { path: "/w/c.ts" },
      { path: "/w/b.ts", offset: 10, limit: 20 },
    ]);
  });

  it("skips a file still read in the retained tail unless the tail wrote it afterwards", () => {
    const summarized = [...call("Read", { path: "/w/a.ts" }), ...call("Read", { path: "/w/b.ts" })];
    const tail = [
      ...call("Read", { path: "/w/a.ts" }),
      ...call("Read", { path: "/w/b.ts" }),
      ...call("Write", { path: "/w/b.ts" }),
    ];
    expect(restoreCandidates(summarized, tail)).toEqual([{ path: "/w/b.ts" }]);
  });
});

describe("readRestoreFiles", () => {
  it("reads at most two at a time, clips large files and records skip reasons", async () => {
    let active = 0;
    let peak = 0;
    const read = vi.fn(async (candidate: { path: string }) => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active--;
      if (candidate.path === "/w/denied") return { ok: false as const, reason: "APPROVAL_REQUIRED" };
      return { ok: true as const, text: candidate.path === "/w/big" ? "y".repeat(RESTORE_FILE_MAX_TOKENS * 4 + 10) : "small", truncated: false };
    });
    const { files, skipped } = await readRestoreFiles(
      ["/w/a", "/w/big", "/w/denied", "/w/b", "/w/c", "/w/sixth"].map((path) => ({ path })),
      read,
      { now: () => new Date("2026-10-30T00:00:00Z") },
    );
    expect(peak).toBeLessThanOrEqual(2);
    expect(read).toHaveBeenCalledTimes(5);
    expect(files.map((entry) => entry.path)).toEqual(["/w/a", "/w/big", "/w/b", "/w/c"]);
    expect(files[1]).toMatchObject({ truncated: true });
    expect(files[1]!.text.length).toBe(RESTORE_FILE_MAX_TOKENS * 4);
    expect(skipped).toEqual([{ path: "/w/denied", reason: "APPROVAL_REQUIRED" }]);
  });

  it("abandons slow reads at the deadline and keeps what finished", async () => {
    vi.useFakeTimers();
    try {
      const signals: AbortSignal[] = [];
      const read = vi.fn((candidate: { path: string }, signal: AbortSignal) => {
        signals.push(signal);
        if (candidate.path === "/w/fast") return Promise.resolve({ ok: true as const, text: "done", truncated: false });
        return new Promise<never>((_, reject) => signal.addEventListener("abort", () => reject(new Error("aborted"))));
      });
      const pending = readRestoreFiles([{ path: "/w/fast" }, { path: "/w/slow" }], read, { timeBudgetMs: 1_000 });
      await vi.advanceTimersByTimeAsync(1_000);
      const { files, skipped } = await pending;
      expect(files.map((entry) => entry.path)).toEqual(["/w/fast"]);
      expect(skipped).toEqual([{ path: "/w/slow", reason: "cancelled" }]);
      expect(signals.every((signal) => signal.aborted)).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not start reads after Stop", async () => {
    const controller = new AbortController();
    controller.abort();
    const read = vi.fn();
    const { files, skipped } = await readRestoreFiles([{ path: "/w/a" }], read, { signal: controller.signal });
    expect(read).not.toHaveBeenCalled();
    expect(files).toEqual([]);
    expect(skipped).toEqual([{ path: "/w/a", reason: "cancelled" }]);
  });
});

describe("budget and persistence shape", () => {
  it("keeps the newest files that fit, never more than the 8K ceiling", () => {
    // About 3.5K, 3.5K and 1K tokens: the third would cross 8K.
    const files = [file("/w/a", 14_000), file("/w/b", 14_000), file("/w/c", 4_000)];
    expect(fitRestoreBudget(files, 100_000).map((entry) => entry.path)).toEqual(["/w/a", "/w/b"]);
    expect(fitRestoreBudget(files, 3_600).map((entry) => entry.path)).toEqual(["/w/a"]);
    expect(fitRestoreBudget(files, 10)).toEqual([]);
  });

  it("reads only well-formed snapshots back from checkpoint details", () => {
    const valid = file("/w/a", 3);
    expect(restoredFilesFromDetails({ restoredFiles: [valid, { path: 1 }, null] })).toEqual([valid]);
    expect(restoredFilesFromDetails(undefined)).toEqual([]);
  });

  it("labels snapshots with their range and read time", () => {
    const text = formatRestoredFiles([{ ...file("/w/a.ts", 3), offset: 10, limit: 5, truncated: true }]);
    expect(text).toContain('<restored-file path="/w/a.ts" lines="10-14" read-at="2026-10-30T00:00:00.000Z" truncated="true">');
    expect(text).toContain("snapshots from that moment");
  });
});
