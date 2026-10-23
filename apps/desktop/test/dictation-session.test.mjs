import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

test("composer dictation recording user paths", async (t) => {
  const server = await createServer({ root: fileURLToPath(new URL("..", import.meta.url)), configFile: false,
    server: { middlewareMode: true, hmr: false, ws: false }, appType: "custom", optimizeDeps: { noDiscovery: true, include: [] } });
  t.after(() => server.close());
  const { DictationSession } = await server.ssrLoadModule("/src/features/voice/dictation/session.ts");
  const originals = new Map(["window", "navigator", "MediaRecorder", "OfflineAudioContext", "RTCPeerConnection"].map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  t.after(() => { for (const [name, descriptor] of originals) { if (descriptor) Object.defineProperty(globalThis, name, descriptor); else delete globalThis[name]; } });
  const install = (name, value) => Object.defineProperty(globalThis, name, { configurable: true, value });
  let requests; let track; let getMedia; let response; let adapter;
  let currentPeer;
  function reset() {
    requests = []; adapter = "openai"; response = async () => ({ text: "识别文字" });
    track = { enabled: true, stopped: false, stop() { this.stopped = true; } };
    getMedia = async () => ({ getTracks: () => [track], getAudioTracks: () => [track] });
    install("navigator", { mediaDevices: { getUserMedia: (...args) => getMedia(...args) } });
    install("window", { piDesktop: { invoke: async (channel, request) => {
      requests.push({ channel, request });
      const data = channel.endsWith("/begin") ? { adapter } : channel.endsWith("/connect") ? { answerSdp: "v=0\r\n" } : channel.endsWith("/transcribe") ? await response(request) : {};
      return { ok: true, data };
    } } });
  }
  install("MediaRecorder", class {
    static isTypeSupported() { return true; }
    state = "inactive"; mimeType = "audio/webm";
    start() { this.state = "recording"; }
    stop() {
      if (this.state === "inactive") throw new Error("already stopped");
      this.state = "inactive";
      queueMicrotask(() => { this.ondataavailable?.({ data: new Blob(["final audio chunk"]) }); this.onstop?.(); });
    }
  });
  install("OfflineAudioContext", class {
    destination = {};
    async decodeAudioData() { return { duration: 0.1 }; }
    createBufferSource() { return { connect() {}, start() {} }; }
    async startRendering() { return { getChannelData: () => new Float32Array([0.2, 0.4, 0.1]) }; }
  });
  install("RTCPeerConnection", class {
    iceGatheringState = "complete"; connectionState = "connected";
    constructor() { currentPeer = this; }
    createDataChannel() { this.channel = { readyState: "open", close() {} }; return this.channel; }
    addTrack() {}
    async createOffer() { return { type: "offer", sdp: "v=0\r\n" }; }
    async setLocalDescription(value) { this.localDescription = value; }
    async setRemoteDescription() {}
    close() { this.closed = true; }
  });
  await t.test("start, stop, final audio chunk, WAV upload, result and cleanup", async () => {
    reset();
    const session = new DictationSession((error) => assert.fail(error));
    await session.start();
    assert.equal(track.stopped, false);
    const text = await session.finish();
    assert.equal(text, "识别文字");
    const upload = requests.find((item) => item.channel.endsWith("/transcribe"));
    assert.equal(new TextDecoder().decode(upload.request.audio.slice(0, 4)), "RIFF");
    assert.equal(track.stopped, true);
    assert.equal(requests.filter((item) => item.channel.endsWith("/end")).length, 1);
    assert.equal(requests.some((item) => /agent|submit|sendMessage/.test(item.channel)), false);
  });
  await t.test("cancel stops recording without uploading", async () => {
    reset();
    const session = new DictationSession((error) => assert.fail(error));
    await session.start(); await session.cancel(); await session.cancel();
    assert.equal(track.stopped, true);
    assert.equal(requests.some((item) => item.channel.endsWith("/transcribe")), false);
    await assert.rejects(session.finish(), /CANCELLED/);
  });
  await t.test("switch or cancel during microphone permission stops late-granted stream", async () => {
    reset(); let grant;
    getMedia = () => new Promise((resolve) => { grant = resolve; });
    const session = new DictationSession((error) => assert.fail(error));
    const start = session.start();
    while (!grant) await new Promise((resolve) => setImmediate(resolve));
    await session.cancel();
    grant({ getTracks: () => [track], getAudioTracks: () => [track] });
    await assert.rejects(start, /CANCELLED/);
    assert.equal(track.stopped, true);
  });
  await t.test("switch or cancel during recognition cannot return stale text", async () => {
    reset(); let complete;
    response = () => new Promise((resolve) => { complete = resolve; });
    const session = new DictationSession((error) => assert.fail(error));
    await session.start(); const result = session.finish();
    while (!complete) await new Promise((resolve) => setImmediate(resolve));
    await session.cancel(); complete({ text: "stale text" });
    await assert.rejects(result, /CANCELLED/);
  });
  await t.test("Codex keeps only user transcript, never plays or delegates, drains before closing", async () => {
    reset(); adapter = "codex";
    const session = new DictationSession((error) => assert.fail(error));
    await session.start();
    const send = (value) => currentPeer.channel.onmessage({ data: JSON.stringify(value) });
    send({ type: "input_audio_buffer.speech_started" });
    send({ type: "output_transcript.added", text: "ignored assistant" });
    send({ type: "delegation.created", item: { id: "work", type: "delegation", target: "client", content: [{ type: "input_text", text: "execute" }] } });
    const finishing = session.finish();
    assert.equal(track.enabled, false); assert.equal(currentPeer.closed, undefined);
    send({ type: "input_transcript.added", text: "最后一句" });
    assert.equal(await finishing, "最后一句");
    assert.equal(currentPeer.closed, true); assert.equal(track.stopped, true);
    assert.equal(requests.some((item) => item.channel.includes("Delegation")), false);
  });
});
