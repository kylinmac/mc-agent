import { describe, expect, it } from "vitest";
import { zstdDecompressSync } from "node:zlib";
import { apiBindingForStyle, buildProviderModel, createProviderModels, type RuntimeProviderConfig } from "./provider-binding.js";
import { withFastMode } from "./fast-mode.js";

describe("Fast mode outbound requests", () => {
  it("leaves unsupported or disabled adapters untouched", () => {
    const adapter = apiBindingForStyle("responses").adapter();
    for (const binding of [
      { modelId: "deepseek-flash", apiStyle: "responses", fastMode: true },
      { modelId: "gpt-6.1-sol", apiStyle: "anthropic_messages", fastMode: true },
      { modelId: "gpt-6.1-sol", apiStyle: "responses", fastMode: false },
    ]) expect(withFastMode(adapter, { id: "fixture", ...binding })).toBe(adapter);
  });
  it.each(["chat_completions", "responses", "openai_codex_responses"])("sends priority only when enabled through %s", async (apiStyle) => {
    for (const fastMode of [undefined, false, true]) {
      const token = `fixture.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "fixture-account" } })).toString("base64url")}.fixture`;
      const provider: RuntimeProviderConfig = {
        id: "fixture", name: "Fixture", baseUrl: "https://gateway.example/v1",
        apiKey: apiStyle === "openai_codex_responses" ? token : "fixture-key",
        authKind: "api_key_and_base_url", apiStyle, modelId: "gpt-6.1-sol", fastMode,
        supportsReasoning: false, supportedThinkingLevels: ["off"],
      };
      const model = buildProviderModel(provider);
      const bodies: Record<string, unknown>[] = [];
      const result = await createProviderModels(provider, model).streamSimple(model, {
        messages: [{ role: "user", content: "hello", timestamp: 0 }],
      }, {
        transport: "sse",
        onPayload: async (payload) => ({ ...(payload as Record<string, unknown>), fixture_hook: true }),
        fetch: async (input, init) => {
          const request = new Request(input, init);
          const raw = Buffer.from(await request.arrayBuffer());
          bodies.push(JSON.parse((request.headers.get("content-encoding") === "zstd"
            ? zstdDecompressSync(raw) : raw).toString("utf8")) as Record<string, unknown>);
          const completed = { type: "response.completed", response: { id: "fixture", status: "completed", output: [] } };
          const chunk = { id: "fixture", object: "chat.completion.chunk", created: 0, model: provider.modelId,
            choices: [{ index: 0, delta: { role: "assistant", content: "OK" }, finish_reason: "stop" }] };
          return new Response(apiStyle === "chat_completions"
            ? `data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`
            : `event: response.completed\ndata: ${JSON.stringify(completed)}\n\n`,
          { headers: { "content-type": "text/event-stream" } });
        },
      }).result();
      expect(result.stopReason, result.errorMessage).toBe("stop");
      expect(bodies).toHaveLength(1);
      expect(bodies[0].fixture_hook).toBe(true);
      expect(bodies[0].service_tier).toBe(fastMode ? "priority" : undefined);
    }
  });
});
