import { IPC, type UpdatePreference } from "@pi-desktop/shared";
import type { AgentSidecar } from "../agent-sidecar";
import type { HostProcess } from "../host-process";
import type { IpcRegistrar } from "./types";
import type { LiveCallService } from "../live-voice/call-service";
import type { AppSettings } from "@pi-desktop/shared";
import { currentSystemProxyRelayUrl } from "../network-proxy";

export type SettingsIpcDependencies = {
  registrar: IpcRegistrar;
  getHost: () => HostProcess | null;
  getSidecar: () => AgentSidecar | null;
  dataDir: string;
  normalizeSettings: (settings: unknown) => unknown;
  validateSettingsWrite: (settings: unknown) => any;
  testNetworkProxy: (settings: unknown) => Promise<unknown>;
  applyNetworkProxyFromAppSettings: (settings: unknown) => Promise<unknown>;
  currentNetworkProxy: () => unknown;
  applyApplicationMenuSettings: (settings?: {
    language?: unknown;
    theme?: unknown;
    keybindings?: unknown;
    developerMode?: unknown;
  } | null) => void;
  applyDeveloperMode: (settings?: { developerMode?: unknown } | null) => void;
  applyPreventScreenSleep: (settings?: { preventScreenSleep?: unknown } | null) => void;
  applyKeepAwakeWhileRunning: (settings?: { keepAwakeWhileRunning?: unknown } | null) => void;
  applyUpdatePreference: (preference: UpdatePreference) => void;
  resolveEffectiveCommandShell: () => Promise<unknown>;
  liveCallService?: Pick<LiveCallService, "beginSettingsWrite" | "settingsWritten">;
};

/** Register app settings and command-shell channels. */
export function registerSettingsIpc({
  registrar,
  getHost,
  getSidecar,
  dataDir,
  normalizeSettings,
  validateSettingsWrite,
  testNetworkProxy,
  applyNetworkProxyFromAppSettings,
  currentNetworkProxy,
  applyApplicationMenuSettings,
  applyDeveloperMode,
  applyPreventScreenSleep,
  applyKeepAwakeWhileRunning,
  applyUpdatePreference,
  resolveEffectiveCommandShell,
  liveCallService,
}: SettingsIpcDependencies): void {
  let host: HostProcess | null = null;
  const handle = (channel: string, fn: (...args: any[]) => Promise<any>) => {
    registrar.handle(channel, async (...args) => {
      host = getHost();
      return fn(...args);
    });
  };

  handle(IPC.invoke.settingsGet, async () => {
    if (!host) throw new Error("host unavailable");
    const settings = await host.call("settings.get");
    return normalizeSettings(settings);
  });

  handle(IPC.invoke.networkProxyTest, async (settings: unknown) => {
    return testNetworkProxy(settings);
  });

  const persistSettings = async (settings: unknown) => {
    const host = getHost();
    const sidecar = getSidecar();
    if (!host) throw new Error("host unavailable");
    const validatedSettings = validateSettingsWrite(settings);
    const currentSettings = await host.call<AppSettings>("settings.get");
    const prospectiveSettings = validatedSettings && typeof validatedSettings === "object" && !Array.isArray(validatedSettings)
      ? { ...currentSettings, ...(validatedSettings as Partial<AppSettings>) }
      : currentSettings;
    const releaseSettingsWrite = liveCallService?.beginSettingsWrite(prospectiveSettings);
    let result: { ok: boolean };
    try {
      result = await host.call<{ ok: boolean }>("settings.set", validatedSettings);
      if (liveCallService) {
        const persisted = await host.call<AppSettings>("settings.get");
        await liveCallService.settingsWritten(persisted);
      }
    } finally {
      releaseSettingsWrite?.();
    }
    const updatePreference = (validatedSettings as { updatePreference?: unknown })
      .updatePreference;
    if (updatePreference === "automatic" || updatePreference === "manual") {
      applyUpdatePreference(updatePreference);
    }
    if (typeof (validatedSettings as { keepAwakeWhileRunning?: unknown })
      .keepAwakeWhileRunning === "boolean") {
      applyKeepAwakeWhileRunning(validatedSettings as { keepAwakeWhileRunning: boolean });
    }
    if (typeof (validatedSettings as { preventScreenSleep?: unknown })
      .preventScreenSleep === "boolean") {
      applyPreventScreenSleep(validatedSettings as { preventScreenSleep: boolean });
    }
    await applyNetworkProxyFromAppSettings(validatedSettings);
    if (sidecar) {
      try {
        await sidecar.call("sidecar.configure", {
          hostBinary: host.binaryPath,
          dataDir,
          networkProxy: currentNetworkProxy(),
          systemProxyRelayUrl: currentSystemProxyRelayUrl(),
        });
      } catch {
        // Sidecar will pick up PI_DESKTOP_PROXY_JSON on the next spawn.
      }
    }
    applyApplicationMenuSettings(
      validatedSettings as {
        language?: unknown;
        theme?: unknown;
        keybindings?: unknown;
        developerMode?: unknown;
      } | null,
    );
    applyDeveloperMode(validatedSettings as { developerMode?: unknown } | null);
    return result;
  };
  // Persistence, voice snapshots and native side effects must share one order.
  let settingsWriteQueue: Promise<void> = Promise.resolve();
  handle(IPC.invoke.settingsSet, (settings: unknown) => {
    const write = settingsWriteQueue.then(() => persistSettings(settings));
    settingsWriteQueue = write.then(() => {}, () => {});
    return write;
  });

  handle(IPC.invoke.commandShellList, async () => resolveEffectiveCommandShell());
}
