import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { McUserHook } from "@pi-desktop/shared";
import { hookMatches, runUserHooks, shellHookRunner, type HookRunner } from "./mc-user-hooks.js";

const hook = (fields: Partial<McUserHook>): McUserHook => ({ id: "h", event: "PreToolUse", command: "true", ...fields });

describe("mc user hooks", () => {
  it("matches the event and the whole tool name", () => {
    expect(hookMatches(hook({ matcher: "Bash" }), "PreToolUse", "Bash")).toBe(true);
    expect(hookMatches(hook({ matcher: "Bash" }), "PreToolUse", "BashOutput")).toBe(false);
    expect(hookMatches(hook({ matcher: "Write|Edit" }), "PreToolUse", "Edit")).toBe(true);
    expect(hookMatches(hook({ matcher: "*" }), "PreToolUse", "Read")).toBe(true);
    expect(hookMatches(hook({}), "PostToolUse", "Read")).toBe(false);
    expect(hookMatches(hook({ enabled: false }), "PreToolUse", "Read")).toBe(false);
    expect(hookMatches(hook({ matcher: "(" }), "PreToolUse", "Read")).toBe(false);
    expect(hookMatches(hook({ event: "Stop", matcher: "Bash" }), "Stop")).toBe(true);
  });

  it("only exit code 2 gives feedback, and PreToolUse stops at the first", async () => {
    const calls: string[] = [];
    const runner: HookRunner = async (command) => {
      calls.push(command);
      if (command === "block") return { exitCode: 2, stdout: "", stderr: "no pushes\n", timedOut: false };
      if (command === "fail") return { exitCode: 1, stdout: "", stderr: "broken", timedOut: false };
      return { exitCode: 0, stdout: "fine", stderr: "", timedOut: false };
    };
    const hooks = [hook({ command: "fail" }), hook({ command: "block" }), hook({ command: "after" })];
    const input = { event: "PreToolUse" as const, sessionId: "s", cwd: "/", toolName: "Bash" };
    expect(await runUserHooks(hooks, input, runner)).toBe("no pushes");
    expect(calls).toEqual(["fail", "block"]);
    const post = hooks.map((item) => ({ ...item, event: "PostToolUse" as const }));
    expect(await runUserHooks([...post, { ...post[1], id: "again" }], { ...input, event: "PostToolUse" }, runner)).toBe("no pushes\n\nno pushes");
    expect(await runUserHooks([hook({ command: "fail" })], input, runner)).toBeUndefined();
  });

  it("runs a real shell command in the workspace with the event in its environment", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mc-hooks-"));
    const command = 'printf "%s %s" "$MC_TOOL_NAME" "$MC_TOOL_INPUT" > seen.txt; echo "lint failed" >&2; exit 2';
    const feedback = await runUserHooks(
      [hook({ event: "PostToolUse", command })],
      { event: "PostToolUse", sessionId: "s", cwd: dir, toolName: "Edit", toolInput: { path: "a.ts" } },
      shellHookRunner,
    );
    expect(feedback).toBe("lint failed");
    expect(readFileSync(join(dir, "seen.txt"), "utf8")).toBe('Edit {"path":"a.ts"}');
  });

  it("a hook that runs too long is killed and ignored", async () => {
    const started = Date.now();
    const feedback = await runUserHooks(
      [hook({ command: "sleep 5; exit 2", timeoutSeconds: 1 })],
      { event: "PreToolUse", sessionId: "s", cwd: tmpdir(), toolName: "Bash" },
      shellHookRunner,
    );
    expect(feedback).toBeUndefined();
    expect(Date.now() - started).toBeLessThan(4_000);
  });
});
