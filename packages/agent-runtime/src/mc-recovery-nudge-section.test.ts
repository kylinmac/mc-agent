import { mkdtempSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { getCurrentSystemMessage } from "@earendil-works/pi-ai";
import { DEEPSEEK_MODELS } from "@earendil-works/pi-ai/providers/deepseek.models";
import type { UiMessage } from "@pi-desktop/shared";
import { modelConfigFromPi } from "./model-capabilities.js";
import { DesktopAgentRuntime, type RuntimeProviderConfig } from "./runtime.js";
import {
  initialSystemTranscript,
  RECOVERY_NUDGE_SECTION,
  setSystemSection,
  systemPromptContent,
  systemTranscriptCheckpoint,
} from "./system-transcript.js";

// mc-agent (#119): the recovery reminder as its own system section.

type SystemRow = Extract<AgentMessage, { role: "system" }>;
const system = (sections: Record<string, string | null>, timestamp: number): AgentMessage =>
  ({ role: "system", content: "", sections, timestamp }) as AgentMessage;
const systems = (messages: AgentMessage[]) => messages.filter((message): message is SystemRow => message.role === "system");

describe("setSystemSection", () => {
  const base = [system({ runtime: "RUNTIME", skills: "SKILLS", context: "CONTEXT" }, 1)];

  it("adds and clears one section with one small delta each, touching nothing else", () => {
    const withNudge = setSystemSection(base, RECOVERY_NUDGE_SECTION, "NUDGE");
    expect(withNudge).toHaveLength(2);
    expect((withNudge[1] as SystemRow).sections).toEqual({ [RECOVERY_NUDGE_SECTION]: "NUDGE" });
    expect(getCurrentSystemMessage(withNudge)?.sections).toEqual({
      runtime: "RUNTIME", skills: "SKILLS", context: "CONTEXT", [RECOVERY_NUDGE_SECTION]: "NUDGE",
    });
    // The composed prompt the runtime compares against does not see it.
    expect(systemPromptContent(withNudge)).toBe("RUNTIME\n\nSKILLS\n\nCONTEXT");

    const cleared = setSystemSection(withNudge, RECOVERY_NUDGE_SECTION, null);
    expect((cleared[2] as SystemRow).sections).toEqual({ [RECOVERY_NUDGE_SECTION]: null });
    expect(getCurrentSystemMessage(cleared)?.sections).toEqual({ runtime: "RUNTIME", skills: "SKILLS", context: "CONTEXT" });
  });

  it("is a no-op when the section already has that value", () => {
    expect(setSystemSection(base, RECOVERY_NUDGE_SECTION, null)).toBe(base);
    const withNudge = setSystemSection(base, RECOVERY_NUDGE_SECTION, "NUDGE");
    expect(setSystemSection(withNudge, RECOVERY_NUDGE_SECTION, "NUDGE")).toBe(withNudge);
  });

  it("does not survive a restore or a checkpoint", () => {
    const stale = setSystemSection(base, RECOVERY_NUDGE_SECTION, "NUDGE");
    const restored = initialSystemTranscript("RUNTIME", [], stale, { runtime: "RUNTIME", skills: "SKILLS", context: "CONTEXT" });
    expect(getCurrentSystemMessage(restored)?.sections?.[RECOVERY_NUDGE_SECTION]).toBeUndefined();
    expect(systemTranscriptCheckpoint(stale)?.sections).toEqual({ runtime: "RUNTIME", skills: "SKILLS", context: "CONTEXT" });
  });
});

function provider(): RuntimeProviderConfig {
  const model = Object.values(DEEPSEEK_MODELS).find((item) => item.id === "deepseek-flash")!;
  return { id: "nudge-fixture", name: "Flash", modelId: model.id, baseUrl: model.baseUrl,
    apiKey: "fixture", authKind: "api_key", supportsReasoning: false, supportedThinkingLevels: ["off"],
    modelConfig: modelConfigFromPi(model) };
}

type Payload = { messages: { role: string; content?: unknown }[] };
async function scriptedModel(replies: string[]) {
  const requests: Payload[] = [];
  const fetch = globalThis.fetch;
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    requests.push(JSON.parse(Buffer.concat(chunks).toString()));
    const delta = { role: "assistant", content: replies.shift() ?? "Done." };
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing HTTP address");
  vi.stubGlobal("fetch", ((_url, init) => fetch(`http://127.0.0.1:${address.port}`, init)) satisfies typeof fetch);
  return { requests, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

afterEach(() => vi.unstubAllGlobals());

describe("a silent turn re-run in the runtime", () => {
  it("shows the reminder to the re-run only, without rewriting the runtime section", async () => {
    // First reply is empty: nothing visible, no tool call.
    const model = await scriptedModel(["", "Here is the answer.", "Second answer."]);
    const rows: UiMessage[] = [];
    const agent = new DesktopAgentRuntime({
      sessionId: "nudge", mode: "agent", provider: provider(), thinkingLevel: "off", history: rows,
      projectPath: mkdtempSync(join(tmpdir(), "mc-nudge-")),
      commandShell: { id: "bash", label: "Bash", dialect: "posix", available: true, isDefault: true },
      host: { call: async <T>(): Promise<T> => undefined as T },
      onEvent: () => {},
    });
    try {
      const state = () => (agent as unknown as { agent: { state: { messages: AgentMessage[] } } }).agent.state.messages;
      const runtimeWrites = () => systems(state()).filter((message) => typeof message.sections?.runtime === "string").length;
      const runtimeWritesBefore = runtimeWrites();

      await agent.prompt("answer me", "u1", "t1");
      expect(model.requests).toHaveLength(2);
      const text = (request: Payload) => JSON.stringify(request.messages);
      expect(text(model.requests[0]!)).not.toContain("<no_output_recovery>");
      expect(text(model.requests[1]!)).toContain("<no_output_recovery>");

      // The whole prompt was not written again for the reminder or its removal.
      expect(runtimeWrites()).toBe(runtimeWritesBefore);
      const nudgeDeltas = systems(state()).filter((message) => message.sections && RECOVERY_NUDGE_SECTION in message.sections);
      expect(nudgeDeltas.map((message) => Object.keys(message.sections!))).toEqual([[RECOVERY_NUDGE_SECTION], [RECOVERY_NUDGE_SECTION]]);
      expect(nudgeDeltas[1]!.sections![RECOVERY_NUDGE_SECTION]).toBeNull();
      // No other section was dropped along the way.
      expect(systems(state()).some((message) =>
        Object.entries(message.sections ?? {}).some(([name, value]) => name !== RECOVERY_NUDGE_SECTION && value === null))).toBe(false);

      await agent.prompt("and again", "u2", "t2");
      const next = model.requests[2]!;
      expect(JSON.stringify(next.messages[0])).not.toContain("<no_output_recovery>");
    } finally { await agent.dispose(); await model.close(); }
  });
});
