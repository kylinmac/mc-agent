import { afterAll, beforeAll, expect, it } from "vitest";
import { build } from "esbuild";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

let directory: string;
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "mc-context-sidecar-"));
  await build({
    entryPoints: [fileURLToPath(new URL("./sidecar.ts", import.meta.url))],
    outdir: directory, bundle: true, splitting: true, platform: "node", format: "esm",
    outExtension: { ".js": ".mjs" },
    banner: { js: "import {createRequire} from 'node:module'; const require=createRequire(import.meta.url); globalThis.fetch=async()=>{throw new Error('Network forbidden in offline test')};" },
  });
}, 30_000);
afterAll(async () => { if (directory) await rm(directory, { recursive: true, force: true }); });

it.each(["read-error", "missing-session", "missing-messages", "empty-history"])(
  "distinguishes %s from an unreadable conversation over real sidecar RPC",
  async (scenario) => {
    const child = spawn(process.execPath, [join(directory, "sidecar.mjs")], {
      cwd: directory, env: { PATH: process.env.PATH, HOME: directory, USERPROFILE: directory },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const closed = once(child, "close");
    const lines = createInterface({ input: child.stdout });
    const send = (message: object) => child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const timeout = setTimeout(() => child.kill(), 10_000);
    try {
      send({ id: "prepare", method: "agent.prepare", params: {
        sessionId: "offline", mode: "agent", thinkingLevel: "off",
        provider: { id: "offline", name: "Offline", modelId: "offline", authKind: "none", baseUrl: "https://fixture.invalid/v1" },
        commandShell: { id: "bash", label: "Bash", dialect: "posix", available: true, isDefault: true },
      } });
      let received = false;
      for await (const line of lines) {
        const message = JSON.parse(line);
        if (message.method === "host.proxy") {
          expect(message.params.method).toBe("session.get");
          send({ id: message.id, ...(scenario === "read-error"
            ? { error: { code: -32000, message: "private host path and secret" } }
            : { result: { session: scenario === "missing-session" ? null : scenario === "missing-messages" ? {} : { messages: [] } } }) });
        }
        if (message.id !== "prepare") continue;
        received = true;
        if (scenario === "empty-history") {
          expect(message.error).toBeUndefined();
          expect(message.result.breakdown).toBeTruthy();
        } else {
          expect(message.result).toBeUndefined();
          expect(message.error.data).toMatchObject({ retriable: false, details: { origin: "local", phase: "context-validation" } });
          expect(JSON.stringify(message)).not.toContain("private host");
        }
        break;
      }
      expect(received, stderr).toBe(true);
    } finally {
      clearTimeout(timeout);
      lines.close();
      child.kill();
      await closed;
    }
  }, 15_000,
);
