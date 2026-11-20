import { describe, expect, it } from "vitest";
import { Type } from "@earendil-works/pi-ai";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { buildRunScriptTool, RunScriptController } from "./mc-run-script.js";

function makeTool(
  name: string,
  handler: (args: Record<string, unknown>, signal?: AbortSignal) => Promise<string> | string,
): AgentTool {
  return {
    name,
    label: name,
    description: `${name} test tool`,
    parameters: Type.Object({}),
    execute: async (_id, args, signal) => ({
      content: [{ type: "text", text: await handler((args ?? {}) as Record<string, unknown>, signal) }],
      details: {},
    }),
  };
}

describe("mc-run-script (R39)", () => {
  it("batches read-only tool calls in memory and returns concise aggregated output", async () => {
    const files: Record<string, string> = {
      "a.ts": "const x = 1; // TODO fix",
      "b.ts": "const y = 2;",
      "c.ts": "const z = 3; // TODO clean",
    };
    const readCalls: string[] = [];
    const catalog = new Map<string, AgentTool>([
      ["Glob", makeTool("Glob", () => JSON.stringify(Object.keys(files)))],
      [
        "Read",
        makeTool("Read", (args) => {
          const p = String(args.path ?? "");
          readCalls.push(p);
          return files[p] ?? "";
        }),
      ],
      ["Write", makeTool("Write", () => "should never run")],
    ]);
    const controller = new RunScriptController();
    const runScript = buildRunScriptTool({ getCatalog: () => catalog, controller });

    const res = await runScript.execute("tc-1", {
      code: `
        const tools = await listTools();
        const names = tools.map(t => t.name).sort();
        const list = await callTool("Glob", { pattern: "*.ts" });
        const hits = [];
        for (const p of list) {
          const text = await callTool("Read", { path: p });
          if (text.includes("TODO")) hits.push(p);
        }
        console.log("discoverable:", names.join(","));
        console.log("hits:", hits.join(","));
      `,
    });

    const text = res.content[0]?.type === "text" ? res.content[0].text : "";
    expect(text).toContain("discoverable: Glob,Read");
    expect(text).toContain("hits: a.ts,c.ts");
    expect(text).toContain("4 read-only tool call(s)");
    expect(readCalls).toEqual(["a.ts", "b.ts", "c.ts"]);
    expect(res.details.totalCalls).toBe(4);
    expect(res.details.truncated).toBe(false);
    controller.dispose();
  });

  it("blocks mutating, shell, delegation, recursive, and non-readonly actions", async () => {
    let writeExecuted = false;
    let taskCreateExecuted = false;
    const catalog = new Map<string, AgentTool>([
      ["Write", makeTool("Write", () => { writeExecuted = true; return "ok"; })],
      ["Bash", makeTool("Bash", () => "ok")],
      ["Task", makeTool("Task", () => "ok")],
      [
        "ProjectTasks",
        makeTool("ProjectTasks", (args) => {
          if (args.action === "create") taskCreateExecuted = true;
          return JSON.stringify({ ok: true, action: args.action });
        }),
      ],
    ]);
    const controller = new RunScriptController();
    const runScript = buildRunScriptTool({ getCatalog: () => catalog, controller });
    catalog.set(runScript.name, runScript as unknown as AgentTool);

    const res = await runScript.execute("tc-2", {
      code: `
        const results = [];
        for (const [name, args] of [
          ["Write", { path: "x", content: "y" }],
          ["Bash", { command: "echo hi" }],
          ["Task", { prompt: "sub" }],
          ["RunScript", { code: "console.log(1)" }],
          ["ProjectTasks", { action: "create" }],
          ["ProjectTasks", { action: "list" }],
        ]) {
          try {
            const r = await callTool(name, args);
            results.push(name + ":ok:" + JSON.stringify(r));
          } catch (e) {
            results.push(name + ":blocked");
          }
        }
        console.log(results.join("\\n"));
      `,
    });

    const text = res.content[0]?.type === "text" ? res.content[0].text : "";
    expect(writeExecuted).toBe(false);
    expect(taskCreateExecuted).toBe(false);
    expect(text).toContain("Write:blocked");
    expect(text).toContain("Bash:blocked");
    expect(text).toContain("Task:blocked");
    expect(text).toContain("RunScript:blocked");
    expect(text).toContain("ProjectTasks:blocked");
    expect(text).toContain('ProjectTasks:ok:{"ok":true,"action":"list"}');
    controller.dispose();
  });

  it("prevents sandbox escape to process, require, or dynamic Function codegen", async () => {
    const controller = new RunScriptController();
    const runScript = buildRunScriptTool({ getCatalog: () => new Map(), controller });

    const res = await runScript.execute("tc-3", {
      code: `
        const checks = [];
        checks.push("process=" + typeof process);
        checks.push("require=" + typeof require);
        checks.push("fetch=" + typeof fetch);
        try {
          const fn = (function(){}).constructor("return process");
          checks.push("fn=" + typeof fn());
        } catch (e) {
          checks.push("fn=blocked");
        }
        console.log(checks.join(" "));
      `,
    });

    const text = res.content[0]?.type === "text" ? res.content[0].text : "";
    expect(text).toContain("process=undefined");
    expect(text).toContain("require=undefined");
    expect(text).toContain("fetch=undefined");
    expect(text).toContain("fn=blocked");
    controller.dispose();
  });

  it("enforces timeout on infinite loops and allows later turns after abortAll()", async () => {
    const controller = new RunScriptController();
    const runScript = buildRunScriptTool({ getCatalog: () => new Map(), controller });

    await expect(
      runScript.execute("tc-4", {
        code: "while (true) {}",
        timeoutMs: 1_000,
      }),
    ).rejects.toThrow(/timed out/i);

    // Abort an active script via AbortSignal and ensure controller stays reusable
    const abort = new AbortController();
    const pending = runScript.execute(
      "tc-5",
      {
        code: "await new Promise(() => {});",
        timeoutMs: 10_000,
      },
      abort.signal,
    );
    setTimeout(() => abort.abort(), 50);
    await expect(pending).rejects.toThrow(/cancelled/i);

    controller.abortAll();
    const followUp = await runScript.execute("tc-6", { code: 'console.log("reusable")' });
    const text = followUp.content[0]?.type === "text" ? followUp.content[0].text : "";
    expect(text).toContain("reusable");
    controller.dispose();
  });

  it("truncates oversized output and enforces max call budget", async () => {
    const catalog = new Map<string, AgentTool>([
      ["Read", makeTool("Read", () => "ok")],
    ]);
    const controller = new RunScriptController();
    const runScript = buildRunScriptTool({
      getCatalog: () => catalog,
      controller,
      maxCalls: 3,
      maxOutputChars: 120,
    });

    const res = await runScript.execute("tc-7", {
      code: `
        let blockedAt = -1;
        for (let i = 0; i < 5; i++) {
          try {
            await callTool("Read", { path: "f" + i });
          } catch {
            blockedAt = i;
            break;
          }
        }
        console.log("blockedAt=" + blockedAt);
        console.log("x".repeat(500));
      `,
    });

    const text = res.content[0]?.type === "text" ? res.content[0].text : "";
    expect(text).toContain("blockedAt=3");
    expect(text).toContain("output truncated");
    expect(res.details.truncated).toBe(true);
    expect(res.details.totalCalls).toBe(3);
    controller.dispose();
  });
});
