import { IPC, type DictationAdapter } from "@pi-desktop/shared";
import { parseCodexMessage } from "@pi-desktop/voice-runtime/live";
import { recordingToWav } from "./audio";

async function invoke<T>(channel: string, request: Record<string, unknown>): Promise<T> {
  if (!window.piDesktop) throw new Error("DICTATION_UNAVAILABLE");
  const result = await window.piDesktop.invoke<T>(channel, request);
  if (!result.ok) throw new Error(result.error.code === "LIVE_MICROPHONE_BUSY" ? "DICTATION_BUSY" : result.error.message);
  return result.data;
}

/** One recording, never shared with live calls or another composer. */
export class DictationSession {
  readonly id = crypto.randomUUID();
  private readonly abort = new AbortController();
  private stream?: MediaStream;
  private recorder?: MediaRecorder;
  private peer?: RTCPeerConnection;
  private channel?: RTCDataChannel;
  private chunks: Blob[] = [];
  private size = 0;
  private transcript = "";
  private pendingSpeech = false;
  private lastTranscript = 0;
  private adapter?: DictationAdapter;
  private failure?: Error;
  private finishing = false;
  private endPromise?: Promise<void>;
  private unsubscribe?: () => void;

  constructor(private readonly onFailure: (error: Error) => void) {
    this.unsubscribe = window.piDesktop?.on?.(IPC.event.dictationCancelled, (raw: unknown) => {
      if (raw && typeof raw === "object" && "id" in raw && raw.id === this.id) this.fail(new Error("DICTATION_CANCELLED"));
    });
  }

  async start(deviceId?: string | null): Promise<void> {
    const result = await invoke<{ adapter: DictationAdapter }>(IPC.invoke.dictationBegin, { id: this.id });
    this.check();
    this.adapter = result.adapter;
    const stream = await navigator.mediaDevices.getUserMedia({ audio: {
      channelCount: 1, echoCancellation: true, noiseSuppression: true,
      ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
    }, video: false });
    if (this.abort.signal.aborted) { stream.getTracks().forEach((track) => track.stop()); this.check(); }
    this.stream = stream;
    for (const track of stream.getAudioTracks()) track.onended = () => this.fail(new Error("DICTATION_MICROPHONE_ENDED"));
    if (this.adapter === "codex") return this.startCodex(stream);
    const mimeType = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"].find((mime) => MediaRecorder.isTypeSupported(mime));
    const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
    this.recorder = recorder;
    recorder.ondataavailable = (event) => {
      if (this.abort.signal.aborted) return;
      this.size += event.data.size;
      if (this.size > 12 * 1024 * 1024) return this.fail(new Error("DICTATION_TOO_LONG"));
      this.chunks.push(event.data);
    };
    recorder.onerror = () => this.fail(new Error("DICTATION_RECORDING_FAILED"));
    recorder.start(250);
  }

  async finish(): Promise<string> {
    this.check();
    if (this.finishing) throw new Error("DICTATION_BUSY");
    this.finishing = true;
    try {
      if (this.adapter === "codex") {
        // Keep the connection alive while silence reaches server VAD and its final transcript arrives.
        for (const track of this.stream?.getAudioTracks() ?? []) track.enabled = false;
        const started = Date.now();
        while (Date.now() - started < 10_000) {
          await delay(100, this.abort.signal); this.check();
          if (Date.now() - started >= 2500 && !this.pendingSpeech && Date.now() - this.lastTranscript >= 1500) return this.transcript.trim();
        }
        throw new Error("DICTATION_FINAL_TRANSCRIPT_TIMEOUT");
      }
      const recorder = this.recorder;
      if (!recorder || recorder.state === "inactive") throw new Error("DICTATION_RECORDING_FAILED");
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => done(new Error("DICTATION_RECORDING_FAILED")), 5000);
        const cancelled = () => done(new Error("DICTATION_CANCELLED"));
        const done = (error?: Error) => { clearTimeout(timeout); this.abort.signal.removeEventListener("abort", cancelled); recorder.onstop = null; error ? reject(error) : resolve(); };
        this.abort.signal.addEventListener("abort", cancelled, { once: true });
        recorder.onstop = () => done(); recorder.stop();
      });
      this.stopTracks();
      this.check();
      const wav = await recordingToWav(new Blob(this.chunks, { type: recorder.mimeType }));
      this.chunks = [];
      this.check();
      const result = await invoke<{ text: string }>(IPC.invoke.dictationTranscribe, { id: this.id, audio: wav });
      this.check();
      return result.text;
    } finally { await this.cancel(); }
  }

  cancel(): Promise<void> {
    if (this.endPromise) return this.endPromise;
    this.abort.abort();
    this.unsubscribe?.(); this.unsubscribe = undefined;
    if (this.recorder?.state !== "inactive") this.recorder?.stop();
    this.stopTracks();
    this.channel?.close(); this.peer?.close(); this.chunks = [];
    this.endPromise = invoke(IPC.invoke.dictationEnd, { id: this.id }).then(() => undefined);
    return this.endPromise;
  }
  private stopTracks() {
    this.stream?.getTracks().forEach((track) => { track.onended = null; track.stop(); });
  }
  private check() { if (this.failure) throw this.failure; if (this.abort.signal.aborted) throw new Error("DICTATION_CANCELLED"); }
  private fail(error: Error) {
    if (this.abort.signal.aborted || this.failure) return;
    this.failure = error; this.onFailure(error);
    void this.cancel().catch(() => this.onFailure(new Error("DICTATION_RELEASE_FAILED")));
  }
  private async startCodex(stream: MediaStream) {
    const peer = new RTCPeerConnection({ iceServers: [] }); this.peer = peer;
    const channel = peer.createDataChannel("oai-events"); this.channel = channel;
    // No remote audio element or task/delegation handler is created for dictation.
    peer.ontrack = (event) => { event.track.enabled = false; };
    peer.onconnectionstatechange = () => { if (peer.connectionState === "failed") this.fail(new Error("DICTATION_NETWORK_ERROR")); };
    channel.onerror = () => this.fail(new Error("DICTATION_NETWORK_ERROR"));
    channel.onclose = () => { if (!this.abort.signal.aborted) this.fail(new Error("DICTATION_NETWORK_ERROR")); };
    channel.onmessage = (message) => {
      if (this.abort.signal.aborted) return;
      try {
        if (typeof message.data !== "string" || message.data.length > 128 * 1024) throw new Error("DICTATION_INVALID_RESPONSE");
        for (const event of parseCodexMessage(JSON.parse(message.data))) {
          if (event.kind === "activity" && event.userSpeaking === true) this.pendingSpeech = true;
          if (event.kind === "transcript" && event.role === "user") {
            this.transcript += event.text; this.lastTranscript = Date.now(); this.pendingSpeech = false;
            if (this.transcript.length > 32000) throw new Error("DICTATION_TOO_LONG");
          }
          if (event.kind === "error") throw new Error("DICTATION_INVALID_RESPONSE");
        }
      } catch { this.fail(new Error("DICTATION_INVALID_RESPONSE")); }
    };
    for (const track of stream.getAudioTracks()) { track.enabled = false; peer.addTrack(track, stream); }
    await peer.setLocalDescription(await peer.createOffer());
    await until(() => peer.iceGatheringState === "complete", this.abort.signal);
    this.check();
    const { answerSdp } = await invoke<{ answerSdp: string }>(IPC.invoke.dictationConnect, { id: this.id, offerSdp: peer.localDescription?.sdp });
    this.check();
    await peer.setRemoteDescription({ type: "answer", sdp: answerSdp });
    await until(() => peer.connectionState === "connected" && channel.readyState === "open", this.abort.signal);
    this.check();
    for (const track of stream.getAudioTracks()) track.enabled = true;
  }
}

async function until(predicate: () => boolean, signal: AbortSignal) {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > 15_000) throw new Error("DICTATION_CONNECTION_TIMEOUT");
    await delay(50, signal);
  }
}
function delay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(new Error("DICTATION_CANCELLED"));
  return new Promise((resolve, reject) => {
    const cancel = () => { clearTimeout(timer); reject(new Error("DICTATION_CANCELLED")); };
    const timer = setTimeout(() => { signal.removeEventListener("abort", cancel); resolve(); }, ms);
    signal.addEventListener("abort", cancel, { once: true });
  });
}
