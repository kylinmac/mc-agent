import { Worker } from "node:worker_threads";
import { Type } from "@earendil-works/pi-ai";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import {
  checkRunScriptToolAccess,
  clampRunScriptTimeout,
  isRunScriptDiscoverableTool,
  RUN_SCRIPT_DEFAULT_TIMEOUT_MS,
  RUN_SCRIPT_MAX_CALLS,
  RUN_SCRIPT_MAX_CODE_CHARS,
  RUN_SCRIPT_MAX_OUTPUT_CHARS,
  RUN_SCRIPT_MAX_TIMEOUT_MS,
  RUN_SCRIPT_MIN_TIMEOUT_MS,
  RUN_SCRIPT_TOOL_NAME,
  type RunScriptResultDetails,
  type RunScriptSubCallSummary,
} from "@pi-desktop/shared";

/**
 * mc-agent (R39): sandboxed read-only programmatic tool orchestration (`RunScript`).
 *
 * Executes a short JS snippet inside an isolated Node worker thread whose V8
 * context disables dynamic codegen (`strings: false, wasm: false`) and exposes
 * no Node globals (`process`, `require`, `fs`, `fetch`, etc.). Every `callTool`
 * hops back to the runtime's own tool catalog after passing the read-only
 * allowlist, so host-core path checks and mode guards stay intact.
 */

export { RUN_SCRIPT_TOOL_NAME };

export const runScriptDescription = [
  "Run a short sandboxed JavaScript snippet to batch, loop, filter, or aggregate multiple READ-ONLY tool calls in memory, returning only your console.log output to the conversation.",
  "Use when you need 3+ read-only tool calls or need to scan/filter large outputs (e.g. checking 20 files or aggregating ProjectHistory/ProjectResources) without flooding the context window.",
  "Do NOT use for a single tool call. Inside the script you have `await callTool(name, args)` (read-only tools only: Read, Glob, Grep, CanvasRead, WorkPanelList, WorkPanelRead, ContextHistory, ProjectHistory, ProjectTemplates, ResolveRef, and read-only actions of ProjectTasks/ProjectResources), `await listTools()`, and `console.log(...)`. Mutating tools, Bash, Task/Subagent, and interactive tools are blocked and must be called directly.",
].join(" ");

const runScriptParameters = Type.Object({
  code: Type.String({
    minLength: 1,
    maxLength: RUN_SCRIPT_MAX_CODE_CHARS,
    description:
      "Async JavaScript body (top-level await is supported). Use `await callTool(name, args)`, `await listTools()`, and `console.log(...)` for the final concise result.",
  }),
  timeoutMs: Type.Optional(
    Type.Integer({
      minimum: RUN_SCRIPT_MIN_TIMEOUT_MS,
      maximum: RUN_SCRIPT_MAX_TIMEOUT_MS,
      description: `Optional execution timeout in milliseconds (default ${RUN_SCRIPT_DEFAULT_TIMEOUT_MS}, max ${RUN_SCRIPT_MAX_TIMEOUT_MS}).`,
    }),
  ),
});

type WorkerMessageToHost =
  | { type: "call_tool"; id: number; name: string; args: Record<string, unknown> }
  | { type: "list_tools"; id: number }
  | { type: "log"; level: "log" | "warn" | "error"; text: string }
  | { type: "done"; returnValue?: string }
  | { type: "error"; message: string };

type HostMessageToWorker =
  | { type: "tool_result"; id: number; ok: true; value: unknown }
  | { type: "tool_result"; id: number; ok: false; error: string }
  | { type: "tools_list"; id: number; tools: Array<{ name: string; description: string; parameters: unknown }> };

/**
 * Inline worker source (loaded via `new Worker(src, { eval: true })`) so
 * single-file esbuild bundles never depend on an external worker file path.
 */
const INLINE_WORKER_SOURCE = `
"use strict";
const { parentPort, workerData } = require("node:worker_threads");
const vm = require("node:vm");
const util = require("node:util");

let nextId = 1;
const pending = new Map();

parentPort.on("message", (msg) => {
  if (!msg || typeof msg.id !== "number") return;
  const entry = pending.get(msg.id);
  if (!entry) return;
  pending.delete(msg.id);
  if (msg.type === "tools_list") {
    entry.resolve(msg.tools);
  } else if (msg.type === "tool_result") {
    if (msg.ok) entry.resolve(msg.value);
    else entry.reject(new Error(msg.error || "Tool call failed"));
  }
});

function formatArgs(args) {
  return args.map((arg) => {
    if (typeof arg === "string") return arg;
    try { return util.inspect(arg, { depth: 4, maxArrayLength: 100, maxStringLength: 4000, breakLength: 100 }); }
    catch { return String(arg); }
  }).join(" ");
}

function callTool(name, args) {
  if (typeof name !== "string" || !name.trim()) {
    return Promise.reject(new Error("callTool(name, args): name must be a non-empty string"));
  }
  const safeArgs = args && typeof args === "object" && !Array.isArray(args) ? args : {};
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    parentPort.postMessage({ type: "call_tool", id, name: name.trim(), args: safeArgs });
  });
}

function listTools() {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    parentPort.postMessage({ type: "list_tools", id });
  });
}

const sandboxConsole = Object.freeze({
  log: (...args) => parentPort.postMessage({ type: "log", level: "log", text: formatArgs(args) }),
  info: (...args) => parentPort.postMessage({ type: "log", level: "log", text: formatArgs(args) }),
  warn: (...args) => parentPort.postMessage({ type: "log", level: "warn", text: formatArgs(args) }),
  error: (...args) => parentPort.postMessage({ type: "log", level: "error", text: formatArgs(args) }),
});

// Pure object without prototype chain to harden against constructor escape.
const sandbox = Object.create(null);
sandbox.callTool = callTool;
sandbox.listTools = listTools;
sandbox.console = sandboxConsole;

const context = vm.createContext(sandbox, {
  name: "mc-run-script",
  codeGeneration: { strings: false, wasm: false },
});

(async () => {
  try {
    const wrapped = "(async () => {\\n" + String(workerData.code || "") + "\\n})()";
    const script = new vm.Script(wrapped, { filename: "run-script.js" });
    const result = await script.runInContext(context);
    let returnValue;
    if (result !== undefined) {
      returnValue = typeof result === "string"
        ? result
        : util.inspect(result, { depth: 4, maxArrayLength: 100, maxStringLength: 4000, breakLength: 100 });
    }
    parentPort.postMessage({ type: "done", returnValue });
  } catch (err) {
    const message = err instanceof Error ? (err.message || String(err)) : String(err);
    parentPort.postMessage({ type: "error", message });
  }
})();
`;

/** Track live script workers so `runtime.dispose()` terminates all of them cleanly. */
export class RunScriptController {
  private readonly workers = new Set<Worker>();
  private disposed = false;

  register(worker: Worker): void {
    if (this.disposed) {
      void worker.terminate();
      return;
    }
    this.workers.add(worker);
  }

  unregister(worker: Worker): void {
    this.workers.delete(worker);
  }

  isDisposed(): boolean {
    return this.disposed;
  }

  /** Terminate in-flight workers when a turn is aborted, while keeping the controller reusable for later turns. */
  abortAll(): void {
    for (const worker of this.workers) {
      void worker.terminate();
    }
    this.workers.clear();
  }

  dispose(): void {
    this.disposed = true;
    this.abortAll();
  }
}

function extractToolResultValue(result: AgentToolResult<unknown>): unknown {
  const texts: string[] = [];
  for (const part of result.content ?? []) {
    if (part.type === "text" && typeof part.text === "string") {
      texts.push(part.text);
    }
  }
  const combined = texts.join("\n");
  if (!combined) return result.details ?? "";
  try {
    return JSON.parse(combined);
  } catch {
    return combined;
  }
}

export type RunScriptToolDeps = {
  getCatalog: () => ReadonlyMap<string, AgentTool>;
  controller: RunScriptController;
  maxCalls?: number;
  maxOutputChars?: number;
};

export function buildRunScriptTool(deps: RunScriptToolDeps): AgentTool<typeof runScriptParameters> {
  const maxCalls = deps.maxCalls ?? RUN_SCRIPT_MAX_CALLS;
  const maxOutputChars = deps.maxOutputChars ?? RUN_SCRIPT_MAX_OUTPUT_CHARS;

  return {
    name: RUN_SCRIPT_TOOL_NAME,
    label: "Run Script",
    description: runScriptDescription,
    parameters: runScriptParameters,
    execute: async (_toolCallId, input, signal) => {
      if (signal?.aborted || deps.controller.isDisposed()) {
        throw new Error("RunScript was cancelled");
      }
      const code = typeof input.code === "string" ? input.code : "";
      if (!code.trim()) {
        throw new Error("RunScript requires non-empty JavaScript code");
      }
      if (code.length > RUN_SCRIPT_MAX_CODE_CHARS) {
        throw new Error(`RunScript code exceeds limit (${RUN_SCRIPT_MAX_CODE_CHARS} chars)`);
      }

      const timeoutMs = clampRunScriptTimeout(input.timeoutMs);
      const startedAt = Date.now();
      const outputLines: string[] = [];
      let outputChars = 0;
      let truncated = false;
      let totalCalls = 0;
      const callCounts = new Map<string, { count: number; failed: number }>();

      const appendLine = (line: string) => {
        if (truncated) return;
        const remaining = maxOutputChars - outputChars;
        if (remaining <= 0) {
          truncated = true;
          return;
        }
        if (line.length + 1 > remaining) {
          outputLines.push(line.slice(0, Math.max(0, remaining)));
          outputChars = maxOutputChars;
          truncated = true;
          return;
        }
        outputLines.push(line);
        outputChars += line.length + 1;
      };

      const recordCall = (name: string, failed: boolean) => {
        const current = callCounts.get(name) ?? { count: 0, failed: 0 };
        current.count += 1;
        if (failed) current.failed += 1;
        callCounts.set(name, current);
      };

      const summarizeCalls = (): RunScriptSubCallSummary[] =>
        [...callCounts.entries()]
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([tool, stat]) => ({ tool, count: stat.count, failed: stat.failed }));

      const worker = new Worker(INLINE_WORKER_SOURCE, {
        eval: true,
        workerData: { code },
        resourceLimits: {
          maxOldGenerationSizeMb: 128,
          maxYoungGenerationSizeMb: 32,
        },
      });
      deps.controller.register(worker);

      const childAbort = new AbortController();

      return await new Promise<AgentToolResult<RunScriptResultDetails>>((resolve, reject) => {
        let settled = false;
        let timer: ReturnType<typeof setTimeout> | undefined;

        const cleanup = () => {
          if (timer) {
            clearTimeout(timer);
            timer = undefined;
          }
          if (signal) signal.removeEventListener("abort", onAbort);
          childAbort.abort();
          deps.controller.unregister(worker);
          void worker.terminate();
        };

        const finishOk = (returnValue?: string) => {
          if (settled) return;
          settled = true;
          cleanup();
          if (outputLines.length === 0 && returnValue !== undefined) {
            appendLine(returnValue);
          }
          const calls = summarizeCalls();
          const durationMs = Math.max(0, Date.now() - startedAt);
          const header =
            calls.length > 0
              ? `[RunScript: ${totalCalls} read-only tool call(s) (${calls.map((c) => `${c.tool}×${c.count}${c.failed ? `/${c.failed}err` : ""}`).join(", ")}) in ${durationMs}ms]`
              : `[RunScript: 0 tool calls in ${durationMs}ms]`;
          const body = outputLines.join("\n") || "(no output)";
          const suffix = truncated
            ? `\n... [output truncated at ${maxOutputChars} chars; filter more strictly in script]`
            : "";
          resolve({
            content: [{ type: "text", text: `${header}\n${body}${suffix}` }],
            details: {
              kind: "run-script",
              durationMs,
              totalCalls,
              truncated,
              calls,
            },
          });
        };

        const finishErr = (message: string) => {
          if (settled) return;
          settled = true;
          cleanup();
          reject(new Error(message));
        };

        const onAbort = () => finishErr("RunScript was cancelled");
        if (signal) signal.addEventListener("abort", onAbort, { once: true });

        timer = setTimeout(() => {
          finishErr(`RunScript timed out after ${timeoutMs}ms`);
        }, timeoutMs);

        const post = (msg: HostMessageToWorker) => {
          if (settled) return;
          try {
            worker.postMessage(msg);
          } catch {
            // Worker already exited or terminated while an async tool call settled.
          }
        };

        worker.on("message", (msg: WorkerMessageToHost) => {
          if (settled || !msg || typeof msg !== "object") return;
          if (msg.type === "log") {
            const prefix = msg.level === "log" ? "" : `[${msg.level}] `;
            appendLine(`${prefix}${msg.text}`);
            return;
          }
          if (msg.type === "done") {
            finishOk(msg.returnValue);
            return;
          }
          if (msg.type === "error") {
            finishErr(`RunScript error: ${msg.message}`);
            return;
          }
          if (msg.type === "list_tools") {
            const catalog = deps.getCatalog();
            const tools = [...catalog.values()]
              .filter((tool) => isRunScriptDiscoverableTool(tool.name))
              .map((tool) => ({
                name: tool.name,
                description: tool.description,
                parameters: tool.parameters,
              }));
            post({ type: "tools_list", id: msg.id, tools });
            return;
          }
          if (msg.type === "call_tool") {
            const toolName = msg.name;
            const args = msg.args ?? {};
            const access = checkRunScriptToolAccess(toolName, args);
            if (!access.allowed) {
              recordCall(toolName, true);
              post({ type: "tool_result", id: msg.id, ok: false, error: access.reason });
              return;
            }
            if (totalCalls >= maxCalls) {
              recordCall(toolName, true);
              post({
                type: "tool_result",
                id: msg.id,
                ok: false,
                error: `RunScript call limit reached (${maxCalls} calls per script).`,
              });
              return;
            }
            const tool = deps.getCatalog().get(toolName);
            if (!tool) {
              recordCall(toolName, true);
              post({
                type: "tool_result",
                id: msg.id,
                ok: false,
                error: `Tool "${toolName}" is not available in this session or mode.`,
              });
              return;
            }
            totalCalls += 1;
            const callId = `run-script-${totalCalls}-${msg.id}`;
            void Promise.resolve()
              .then(() => tool.execute(callId, args, childAbort.signal))
              .then(
                (result) => {
                  recordCall(toolName, false);
                  post({ type: "tool_result", id: msg.id, ok: true, value: extractToolResultValue(result) });
                },
                (err: unknown) => {
                  recordCall(toolName, true);
                  const errMsg = err instanceof Error ? err.message : String(err);
                  post({ type: "tool_result", id: msg.id, ok: false, error: errMsg });
                },
              );
          }
        });

        worker.on("error", (err) => {
          finishErr(`RunScript worker failed: ${err instanceof Error ? err.message : String(err)}`);
        });

        worker.on("exit", (exitCode) => {
          if (!settled) {
            finishErr(`RunScript worker exited unexpectedly (code ${exitCode})`);
          }
        });
      });
    },
  };
}
