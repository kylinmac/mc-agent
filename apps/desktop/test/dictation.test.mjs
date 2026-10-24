import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

test("dictation protocols, ownership and cancellation", async (t) => {
  const server = await createServer({ root: fileURLToPath(new URL("..", import.meta.url)), configFile: false,
    server: { middlewareMode: true, hmr: false, ws: false }, appType: "custom", optimizeDeps: { noDiscovery: true, include: [] } });
  t.after(() => server.close());
  const { encodeDictationWav } = await server.ssrLoadModule("/src/features/voice/dictation/audio.ts");
  const { validateDictationAudio, dictationRequest, readDictationResponse } = await server.ssrLoadModule("/electron/main/dictation/transcribe.ts");
  const { DictationService } = await server.ssrLoadModule("/electron/main/dictation/service.ts");
  const { buildCodexCallBody } = await server.ssrLoadModule("/electron/main/live-voice/codex-adapter.ts");
  const { MicrophoneLeaseRegistry } = await server.ssrLoadModule("/electron/main/live-voice/microphone-lease.ts");
  const audio = encodeDictationWav(new Float32Array([0, 0.5, -0.5]));
  const settings = { enabled: true, adapter: "openai", providerId: "account", modelId: "gpt-transcribe" };
  const provider = { id: "account", enabled: true, hasSecret: true, authKind: "api_key", vendorKey: "openai", baseUrl: "https://example.com/v1" };

  await t.test("recording produces bounded mono PCM WAV; malformed input fails before upload", () => {
    assert.deepEqual(validateDictationAudio(audio), audio);
    const wrongRate = audio.slice(); new DataView(wrongRate.buffer).setUint32(24, 48000, true);
    assert.throws(() => validateDictationAudio(wrongRate), /INVALID_AUDIO/);
    assert.throws(() => validateDictationAudio(new Uint8Array(6_000_000)), /INVALID_AUDIO/);
    assert.throws(() => validateDictationAudio(audio.slice(0, 45)), /INVALID_AUDIO/);
  });
  await t.test("OpenAI, Gemini and xAI use distinct request and response formats", async () => {
    const openai = dictationRequest(settings, provider.baseUrl, "fixture-key", audio);
    assert.equal(openai.url, "https://example.com/v1/audio/transcriptions");
    assert.equal(openai.init.body.get("model"), "gpt-transcribe");
    assert.equal(openai.init.body.get("file").type, "audio/wav");
    const xai = dictationRequest({ ...settings, adapter: "xai", modelId: "grok-voice-transcribe-2.0" }, "https://api.x.ai/v1/", "fixture-key", audio);
    assert.equal(xai.url, "https://api.x.ai/v1/stt");
    assert.deepEqual([...xai.init.body.keys()], ["model", "format", "file"]);
    const gemini = dictationRequest({ ...settings, adapter: "gemini", modelId: "gemini-3.8-flash" }, "https://generativelanguage.googleapis.com/v1beta", "fixture-key", audio);
    assert.match(gemini.url, /\/models\/gemini-3.8-flash:generateContent$/);
    const body = JSON.parse(gemini.init.body);
    assert.equal(body.contents[0].parts[0].inlineData.mimeType, "audio/wav");
    assert.equal(body.tools, undefined);
    assert.equal(await readDictationResponse(Response.json({ text: "你好" }), "xai"), "你好");
    assert.equal(await readDictationResponse(Response.json({ candidates: [{ finishReason: "STOP", content: { parts: [{ thought: true, text: "private" }, { text: "hello" }] } }] }), "gemini"), "hello");
    await assert.rejects(readDictationResponse(Response.json({ candidates: [{ finishReason: "MAX_TOKENS" }] }), "gemini"), /INCOMPLETE/);
    await assert.rejects(readDictationResponse(new Response("fixture-key", { status: 401 }), "openai"), { message: "DICTATION_HTTP_401" });
    assert.throws(() => dictationRequest(settings, "https://user:password@example.com/v1", "fixture-key", audio), /INVALID_ENDPOINT/);
  });
  await t.test("Codex dictation cannot advertise delegation or inherit work instructions", () => {
    const body = buildCodexCallBody({ sdp: "v=0\r\n", voice: "cove", dictation: true, workProfile: { instructions: "execute work", startupContext: "secret context" } });
    assert.equal(body.session.delegation, undefined);
    assert.doesNotMatch(body.session.instructions, /secret context|execute work/);
    assert.match(body.session.instructions, /dictation/);
    assert.equal(buildCodexCallBody({ sdp: "v=0\r\n", voice: "cove" }).session.delegation.type, "client");
  });

  function fixture(overrides = {}) {
    let currentProvider = { ...provider };
    const leases = new MicrophoneLeaseRegistry(() => false);
    const requests = [];
    const service = new DictationService({ settings: async () => ({ dictation: settings }), provider: async () => ({ provider: currentProvider }),
      secret: async () => ({ value: "fixture-key" }), acquire: (id) => leases.acquire("cloud-dictation", id),
      codex: async () => { throw new Error("unexpected Codex"); }, assertEndpoint: async () => {},
      fetch: async (url, init) => { requests.push({ url, init }); return Response.json({ text: "hello" }); }, ...overrides });
    return { service, leases, requests, changeProvider: (patch) => { currentProvider = { ...currentProvider, ...patch }; } };
  }
  await t.test("successful transcription enforces ownership and microphone exclusivity", async () => {
    const { service, leases, requests } = fixture();
    assert.deepEqual(await service.begin("owner", "recording"), { adapter: "openai" });
    assert.throws(() => leases.acquire("live", "call"), { errorCode: "LIVE_MICROPHONE_BUSY" });
    await assert.rejects(service.transcribe("other", "recording", audio), /CANCELLED/);
    assert.deepEqual(await service.transcribe("owner", "recording", audio), { text: "hello" });
    assert.equal(requests[0].init.redirect, "manual");
    assert.equal(leases.isHeld(), false);
  });
  await t.test("provider endpoint changes after recording cannot redirect credentials", async () => {
    const { service, changeProvider, requests, leases } = fixture();
    await service.begin("owner", "recording");
    changeProvider({ baseUrl: "https://other.example/v1" });
    await assert.rejects(service.transcribe("owner", "recording", audio), /PROVIDER_UNAVAILABLE/);
    assert.equal(requests.length, 0); assert.equal(leases.isHeld(), false);
  });
  await t.test("cancel while authenticating releases lease and rejects late start", async () => {
    let resolveSettings;
    const { service, leases } = fixture({ settings: () => new Promise((resolve) => { resolveSettings = resolve; }) });
    const start = service.begin("owner", "recording");
    await service.end("owner", "recording");
    resolveSettings({ dictation: settings });
    await assert.rejects(start, /CANCELLED/);
    assert.equal(leases.isHeld(), false);
  });
  await t.test("cancel in-flight transcription aborts network and ignores a late result", async () => {
    let resolveResponse; let requestSignal;
    const { service, leases } = fixture({ fetch: async (_url, init) => { requestSignal = init.signal; return new Promise((resolve) => { resolveResponse = resolve; }); } });
    await service.begin("owner", "recording");
    const result = service.transcribe("owner", "recording", audio);
    while (!resolveResponse) await new Promise((resolve) => setImmediate(resolve));
    await service.end("owner", "recording");
    assert.equal(requestSignal.aborted, true);
    resolveResponse(Response.json({ text: "late" }));
    await assert.rejects(result, /CANCELLED/); assert.equal(leases.isHeld(), false);
  });
  await t.test("suspend or timeout notifies the exact owner and releases its reservation", async () => {
    const notices = [];
    const { service, leases } = fixture({ onCancelled: (owner, id) => notices.push({ owner, id }) });
    await service.begin("owner", "recording");
    await service.end("owner", undefined, true);
    assert.deepEqual(notices, [{ owner: "owner", id: "recording" }]);
    assert.equal(leases.isHeld(), false);
  });
});
