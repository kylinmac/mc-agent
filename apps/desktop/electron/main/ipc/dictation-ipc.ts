import { net, powerMonitor, type BrowserWindow } from "electron";
import { IPC } from "@pi-desktop/shared";
import type { HostProcess } from "../host-process";
import type { VendorOAuth } from "../oauth";
import type { IpcRegistrar } from "./types";
import type { MicrophoneLeaseRegistry } from "../live-voice/microphone-lease";
import { LiveAuthResolver } from "../live-voice/auth-resolver";
import { createCodexAdapter } from "../live-voice/codex-adapter";
import { assertLiveHttpsEndpoint } from "../live-voice/websocket-transport";
import { DictationService } from "../dictation/service";
import { liveOwnerFromInvoke } from "../live-voice/owner";

export function registerDictationIpc(input: {
  registrar: IpcRegistrar; getHost: () => HostProcess | null;
  vendorOAuth: Pick<VendorOAuth, "resolveAuth">; microphoneLeases: MicrophoneLeaseRegistry;
  getMainWindow: () => BrowserWindow | null;
}) {
  const callHost = <T,>(method: string, params?: unknown): Promise<T> => {
    const host = input.getHost();
    if (!host) return Promise.reject(new Error("DICTATION_HOST_UNAVAILABLE"));
    return host.call<T>(method, params);
  };
  const auth = new LiveAuthResolver({ callHost, vendorOAuth: input.vendorOAuth });
  const service = new DictationService({
    settings: () => callHost("settings.get"),
    provider: (id) => callHost("providers.get", { id }),
    secret: (id) => callHost("providers.getSecret", { id }),
    resolveXaiAuth: (id) => input.vendorOAuth.resolveAuth(id),
    acquire: (id, owner) => input.microphoneLeases.acquire("cloud-dictation", id, owner),
    onCancelled: (owner, id) => {
      const window = input.getMainWindow();
      if (!window || window.isDestroyed() || window.webContents.isDestroyed()) return;
      const frame = window.webContents.mainFrame;
      if (owner === `${window.webContents.id}:${frame.processId}:${frame.routingId}`) frame.send(IPC.event.dictationCancelled, { id });
    },
    assertEndpoint: (url) => assertLiveHttpsEndpoint(url, "user"),
    fetch: (url, init) => net.fetch(url instanceof URL ? url.toString() : url, init),
    codex: async (settings, signal) => {
      const binding = { id: "dictation", adapterId: "codex-live", providerId: settings.providerId, voice: "cove" } as const;
      const resolved = await auth.resolve(binding);
      return createCodexAdapter({ callId: "dictation", binding, ...resolved, signal, onEvent: () => undefined, dictation: true }, {
        fetchImpl: (url, init) => net.fetch(url instanceof URL ? url.toString() : url, init),
        assertEndpoint: (url) => assertLiveHttpsEndpoint(url, "third-party"),
      });
    },
  });
  const watched = new Set<number>();
  const owners = new Map<number, string>();
  const cancelAll = () => { for (const owner of owners.values()) void service.end(owner, undefined, true); };
  powerMonitor.on("suspend", cancelAll);
  powerMonitor.on("lock-screen", cancelAll);
  for (const channel of [IPC.invoke.dictationBegin, IPC.invoke.dictationConnect, IPC.invoke.dictationTranscribe, IPC.invoke.dictationEnd]) {
    input.registrar.handleWithEvent(channel, async (event, raw: unknown) => {
      input.registrar.assertMainWindowSender(event);
      liveOwnerFromInvoke(event, input.getMainWindow());
      const frame = event.senderFrame;
      if (!frame || frame !== event.sender.mainFrame) throw new Error("DICTATION_INVALID_OWNER");
      const owner = `${event.sender.id}:${frame.processId}:${frame.routingId}`;
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("DICTATION_INVALID_REQUEST");
      const request = raw as Record<string, unknown>;
      if (typeof request.id !== "string" || !/^[a-f0-9-]{36}$/.test(request.id)) throw new Error("DICTATION_INVALID_REQUEST");
      if (!watched.has(event.sender.id)) {
        const contents = event.sender;
        watched.add(contents.id);
        const cancel = () => { const previous = owners.get(contents.id); if (previous) void service.end(previous, undefined, true); };
        contents.on("render-process-gone", cancel);
        contents.on("did-start-navigation", (_event, _url, inPlace, mainFrame) => { if (mainFrame && !inPlace) cancel(); });
        contents.once("destroyed", () => { cancel(); watched.delete(contents.id); owners.delete(contents.id); });
      }
      if (channel === IPC.invoke.dictationBegin) {
        owners.set(event.sender.id, owner);
        return service.begin(owner, request.id);
      }
      if (channel === IPC.invoke.dictationEnd) { await service.end(owner, request.id); return { ok: true }; }
      if (channel === IPC.invoke.dictationConnect) {
        if (typeof request.offerSdp !== "string" || request.offerSdp.length > 256 * 1024) throw new Error("DICTATION_INVALID_REQUEST");
        return service.connect(owner, request.id, request.offerSdp);
      }
      return service.transcribe(owner, request.id, request.audio);
    });
  }
}
