/**
 * mc-agent (R43): IPC handlers and lifecycle binding for Mobile Remote Access.
 */
import { app } from "electron";
import {
  ErrorCodes,
  IPC,
  MC_MOBILE_DEFAULT_PAIR_TTL_SECS,
} from "@pi-desktop/shared";
import type { HostProcess } from "../host-process";
import type { Logger } from "../logger";
import { MobileBridge } from "../mobile-bridge/bridge";
import type { IpcRegistrar } from "./types";

export type McMobileIpcDependencies = {
  registrar: IpcRegistrar;
  dataDir: string;
  getHost: () => HostProcess | null;
  invoke: (channel: string, args: unknown[]) => Promise<unknown>;
  activeTurns: ReadonlyMap<string, string>;
  sendToRenderer: (channel: string, payload: unknown) => void;
  logger: Pick<Logger, "app">;
};

let activeMobileBridge: MobileBridge | null = null;

/** Forward renderer broadcast events to the mobile bridge when initialized. */
export function observeMobileBridgeEvent(channel: string, payload: unknown): void {
  activeMobileBridge?.observeEvent(channel, payload);
}

export function registerMcMobileIpc({
  registrar,
  dataDir,
  getHost,
  invoke,
  activeTurns,
  sendToRenderer,
  logger,
}: McMobileIpcDependencies): MobileBridge {
  const bridge = new MobileBridge({
    dataDir,
    appVersion: app.getVersion(),
    getHost,
    invoke,
    activeTurns,
    sendToRenderer,
    log: (level, message, data) =>
      logger.app("runtime", level, `[mobile] ${message}`, data === undefined ? undefined : { data }),
  });

  activeMobileBridge = bridge;
  void bridge.init();

  app.once("will-quit", () => {
    activeMobileBridge = null;
    void bridge.shutdown();
  });

  registrar.handle(IPC.invoke.mcMobileStatus, async () => bridge.getStatus());

  registrar.handle(
    IPC.invoke.mcMobileSetEnabled,
    async (input: { enabled?: unknown } = {}) => {
      if (typeof input?.enabled !== "boolean") {
        throw Object.assign(new Error("enabled boolean is required"), {
          errorCode: ErrorCodes.INVALID_ARGUMENT,
        });
      }
      return bridge.setEnabled(input.enabled);
    },
  );

  registrar.handle(
    IPC.invoke.mcMobileCreatePair,
    async (input: { ttlSecs?: unknown } = {}) => {
      const ttl =
        typeof input?.ttlSecs === "number" && Number.isFinite(input.ttlSecs)
          ? Math.max(60, Math.min(3600, Math.floor(input.ttlSecs)))
          : MC_MOBILE_DEFAULT_PAIR_TTL_SECS;
      return bridge.createPair(ttl);
    },
  );

  registrar.handle(
    IPC.invoke.mcMobileRevokeDevice,
    async (input: { deviceId?: unknown } = {}) => {
      if (typeof input?.deviceId !== "string" || !input.deviceId.trim()) {
        throw Object.assign(new Error("deviceId is required"), {
          errorCode: ErrorCodes.INVALID_ARGUMENT,
        });
      }
      return bridge.revokeDevice(input.deviceId.trim());
    },
  );

  return bridge;
}
