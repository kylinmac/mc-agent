import { dictationProviderMatches, parseDictationSettings, type AppSettings, type DictationSettings, type ProviderPublic } from "@pi-desktop/shared";
import type { LiveAdapter } from "../live-voice/types";
import { dictationRequest, readDictationResponse, validateDictationAudio } from "./transcribe";

type Slot = {
  id: string; owner: string; abort: AbortController; release: () => void;
  timer: ReturnType<typeof setTimeout>; settings?: DictationSettings; provider?: ProviderPublic; busy: boolean; adapter?: LiveAdapter;
};
export type DictationDeps = {
  settings: () => Promise<AppSettings>;
  provider: (id: string) => Promise<{ provider?: ProviderPublic }>;
  secret: (id: string) => Promise<{ value?: string }>;
  acquire: (id: string, owner: string) => () => void;
  onCancelled?: (owner: string, id: string) => void;
  codex: (settings: DictationSettings, signal: AbortSignal) => Promise<LiveAdapter>;
  assertEndpoint: (url: string) => Promise<void>;
  fetch: typeof fetch;
};

export class DictationService {
  private current: Slot | null = null;
  constructor(private readonly deps: DictationDeps) {}

  async begin(owner: string, id: string) {
    if (this.current) throw new Error("DICTATION_BUSY");
    const release = this.deps.acquire(id, owner);
    const slot: Slot = { id, owner, release, abort: new AbortController(), busy: false,
      timer: setTimeout(() => { void this.end(owner, id, true); }, 5 * 60_000) };
    this.current = slot;
    try {
      const settings = parseDictationSettings((await this.deps.settings()).dictation);
      if (!settings.enabled) throw new Error("DICTATION_DISABLED");
      const { provider } = await this.deps.provider(settings.providerId);
      this.assertCurrent(slot);
      if (!provider || !provider.hasSecret || !dictationProviderMatches(settings.adapter, provider)) throw new Error("DICTATION_PROVIDER_UNAVAILABLE");
      slot.settings = settings;
      slot.provider = provider;
      return { adapter: settings.adapter };
    } catch (error) {
      await this.end(owner, id);
      throw error;
    }
  }

  async connect(owner: string, id: string, offerSdp: string) {
    const slot = this.require(owner, id);
    if (slot.busy || slot.settings?.adapter !== "codex") throw new Error("DICTATION_BUSY");
    slot.busy = true;
    try {
      await this.revalidate(slot);
      const adapter = await this.deps.codex(slot.settings, slot.abort.signal);
      if (this.current !== slot || slot.abort.signal.aborted) { await adapter.close("user-ended"); throw new Error("DICTATION_CANCELLED"); }
      slot.adapter = adapter;
      const result = await adapter.connect({ offerSdp });
      this.assertCurrent(slot);
      return result;
    } catch (error) {
      await this.end(owner, id);
      throw error;
    }
  }

  async transcribe(owner: string, id: string, audio: unknown) {
    const slot = this.require(owner, id);
    if (slot.busy || !slot.settings || slot.settings.adapter === "codex") throw new Error("DICTATION_BUSY");
    const bytes = validateDictationAudio(audio);
    slot.busy = true;
    const timeout = setTimeout(() => slot.abort.abort(), 60_000);
    try {
      const provider = await this.revalidate(slot);
      const { value } = await this.deps.secret(slot.settings.providerId);
      this.assertCurrent(slot);
      if (!value) throw new Error("DICTATION_PROVIDER_UNAVAILABLE");
      const base = provider.baseUrl || (slot.settings.adapter === "gemini" ? "https://generativelanguage.googleapis.com/v1beta" : slot.settings.adapter === "xai" ? "https://api.x.ai/v1" : "");
      const request = dictationRequest(slot.settings, base, value, bytes);
      await this.deps.assertEndpoint(request.url);
      await this.revalidate(slot);
      const response = await this.deps.fetch(request.url, { ...request.init, signal: slot.abort.signal, redirect: "manual" });
      const text = await readDictationResponse(response, slot.settings.adapter);
      this.assertCurrent(slot);
      return { text };
    } catch (error) {
      if (slot.abort.signal.aborted) throw new Error("DICTATION_CANCELLED_OR_TIMEOUT");
      // Keep only our own bounded error codes across IPC, never provider/network messages.
      throw new Error(error instanceof Error && /^DICTATION_[A-Z_0-9]+$/.test(error.message) ? error.message : "DICTATION_REQUEST_FAILED");
    } finally {
      clearTimeout(timeout);
      await this.end(owner, id);
    }
  }

  async end(owner: string, id?: string, notify = false) {
    const slot = this.current;
    if (!slot || slot.owner !== owner || (id && slot.id !== id)) return;
    this.current = null;
    slot.abort.abort();
    clearTimeout(slot.timer);
    try {
      if (notify) this.deps.onCancelled?.(owner, slot.id);
      await slot.adapter?.close("user-ended");
    } finally { slot.release(); }
  }
  private require(owner: string, id: string) {
    if (!this.current || this.current.owner !== owner || this.current.id !== id) throw new Error("DICTATION_CANCELLED");
    return this.current;
  }
  private assertCurrent(slot: Slot) {
    if (this.current !== slot || slot.abort.signal.aborted) throw new Error("DICTATION_CANCELLED");
  }
  private async revalidate(slot: Slot): Promise<ProviderPublic> {
    const settings = parseDictationSettings((await this.deps.settings()).dictation);
    const { provider } = await this.deps.provider(settings.providerId);
    this.assertCurrent(slot);
    if (JSON.stringify(settings) !== JSON.stringify(slot.settings) || !settings.enabled || !provider || !provider.hasSecret ||
      !dictationProviderMatches(settings.adapter, provider) || provider.baseUrl !== slot.provider?.baseUrl ||
      provider.authKind !== slot.provider?.authKind || provider.vendorKey !== slot.provider?.vendorKey) throw new Error("DICTATION_PROVIDER_UNAVAILABLE");
    return provider;
  }
}
