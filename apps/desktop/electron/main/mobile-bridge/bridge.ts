/**
 * mc-agent (R43): Electron Main bridge between `mc-mobile-gateway` (iroh P2P/Relay)
 * and existing desktop IPC / host-core capabilities.
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  IPC,
  MC_MOBILE_DEFAULT_PAIR_TTL_SECS,
  MC_MOBILE_MAX_EVENT_HISTORY,
  type AgentEventEnvelope,
  type MobileDeviceInfo,
  type MobileGatewayStatus,
  type MobilePairingOffer,
  type WorkspaceDiff,
} from "@pi-desktop/shared";
import { collectWorkspaceDiff } from "@pi-desktop/host-runtime";
import {
  MobileGatewayProcess,
  type GatewayRpcRequest,
} from "./gateway-process.ts";
import { asNonEmptyString, rpcError, type HostLike, type RpcHandlerContext } from "./rpc-context.ts";
import { dispatchMobileRpc } from "./rpc-handlers.ts";

export type MobileBridgeDependencies = {
  dataDir: string;
  appVersion: string;
  hostname?: string;
  binaryPath?: string;
  noMdns?: boolean;
  getHost: () => HostLike | null;
  invoke: (channel: string, args: unknown[]) => Promise<unknown>;
  activeTurns: ReadonlyMap<string, string>;
  sendToRenderer: (channel: string, payload: unknown) => void;
  collectDiff?: (cwd: string) => Promise<WorkspaceDiff>;
  log?: (level: "info" | "warn" | "error", message: string, data?: unknown) => void;
};

type MobileConfig = { enabled: boolean };

type BufferedSessionEvent = {
  cursor: number;
  event: AgentEventEnvelope;
};

const ATTENTION_AGENT_EVENT_TYPES = new Set([
  "turn_start",
  "turn_end",
  "agent_start",
  "agent_end",
  "permission_request",
  "ask_request",
  "plan_proposal",
  "error",
]);

function errorCodeOf(error: unknown): string {
  if (error && typeof error === "object") {
    const rec = error as Record<string, unknown>;
    if (typeof rec.rpcCode === "string" && rec.rpcCode) return rec.rpcCode;
    if (typeof rec.errorCode === "string" && rec.errorCode) return rec.errorCode;
  }
  return "INTERNAL_ERROR";
}

function errorMessageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class MobileBridge {
  private readonly deps: MobileBridgeDependencies;
  private readonly gateway: MobileGatewayProcess;
  private readonly collectDiff: (cwd: string) => Promise<WorkspaceDiff>;
  private readonly configPath: string;
  private readonly devicesPath: string;

  private enabled = false;
  private configLoaded = false;
  private eventCursor = 0;
  private readonly sessionBuffers = new Map<string, BufferedSessionEvent[]>();
  private readonly subscriptions = new Map<string, Set<string>>();
  private readonly connDevices = new Map<string, string>();
  private attentionTimer: NodeJS.Timeout | null = null;
  private stoppedDevices: MobileDeviceInfo[] = [];

  constructor(deps: MobileBridgeDependencies) {
    this.deps = deps;
    this.collectDiff = deps.collectDiff ?? collectWorkspaceDiff;
    const mobileDir = join(deps.dataDir, "mobile");
    this.configPath = join(mobileDir, "config.json");
    this.devicesPath = join(mobileDir, "devices.json");

    this.gateway = new MobileGatewayProcess({
      dataDir: deps.dataDir,
      hostname: deps.hostname,
      binaryPath: deps.binaryPath,
      noMdns: deps.noMdns,
      log: deps.log,
    });

    this.gateway.onStatusChanged((status) => {
      if (status.state === "running") {
        this.stoppedDevices = status.devices;
      }
      this.deps.sendToRenderer(IPC.event.mcMobileStatusChanged, this.mergeStatus(status));
    });

    this.gateway.onDeviceOffline((deviceId) => {
      for (const [connId, owner] of [...this.connDevices]) {
        if (owner !== deviceId) continue;
        this.connDevices.delete(connId);
        for (const [sessionId, conns] of this.subscriptions) {
          conns.delete(connId);
          if (conns.size === 0) this.subscriptions.delete(sessionId);
        }
      }
    });

    this.gateway.onRpcRequest((req) => {
      this.connDevices.set(req.connId, req.deviceId);
      void this.handleRpc(req);
    });
  }

  async init(): Promise<MobileGatewayStatus> {
    await this.ensureConfigLoaded();
    if (this.enabled) {
      try {
        await this.gateway.start();
      } catch (error) {
        this.deps.log?.("warn", "Failed to auto-start mobile gateway", errorMessageOf(error));
      }
    }
    return this.getStatus();
  }

  async getStatus(): Promise<MobileGatewayStatus> {
    await this.ensureConfigLoaded();
    return this.mergeStatus(this.gateway.getStatus());
  }

  async setEnabled(enabled: boolean): Promise<MobileGatewayStatus> {
    await this.ensureConfigLoaded();
    this.enabled = Boolean(enabled);
    await this.saveConfig({ enabled: this.enabled });
    this.gateway.setEnabledFlag(this.enabled);

    if (this.enabled) {
      await this.gateway.start();
    } else {
      await this.gateway.stop();
      this.subscriptions.clear();
      this.stoppedDevices = await this.readDevicesFromDisk();
    }
    const status = this.mergeStatus(this.gateway.getStatus());
    this.deps.sendToRenderer(IPC.event.mcMobileStatusChanged, status);
    return status;
  }

  async createPair(ttlSecs = MC_MOBILE_DEFAULT_PAIR_TTL_SECS): Promise<MobilePairingOffer> {
    await this.ensureConfigLoaded();
    if (!this.enabled) {
      await this.setEnabled(true);
    } else if (this.gateway.getStatus().state !== "running") {
      await this.gateway.start();
    }
    return this.gateway.createPair(ttlSecs);
  }

  async revokeDevice(deviceId: string): Promise<{ removed: boolean; status: MobileGatewayStatus }> {
    await this.ensureConfigLoaded();
    const id = asNonEmptyString(deviceId, 128);
    if (!id) throw rpcError("INVALID_ARGUMENT", "deviceId is required");

    let removed = false;
    if (this.gateway.getStatus().state === "running") {
      const res = await this.gateway.revokeDevice(id);
      removed = res.removed;
    } else {
      const devices = await this.readDevicesFromDisk();
      const next = devices.filter((d) => d.deviceId !== id);
      removed = next.length !== devices.length;
      if (removed) {
        await this.writeDevicesToDisk(next);
        this.stoppedDevices = next;
      }
    }
    const status = this.mergeStatus(this.gateway.getStatus());
    this.deps.sendToRenderer(IPC.event.mcMobileStatusChanged, status);
    return { removed, status };
  }

  async shutdown(): Promise<void> {
    if (this.attentionTimer) {
      clearTimeout(this.attentionTimer);
      this.attentionTimer = null;
    }
    this.subscriptions.clear();
    await this.gateway.stop();
  }

  observeEvent(channel: string, payload: unknown): void {
    if (channel === IPC.event.agentMessage) {
      const envelope = payload as AgentEventEnvelope | undefined;
      const sessionId = envelope?.sessionId;
      if (typeof sessionId === "string" && sessionId) {
        const entry = this.appendSessionEvent(sessionId, envelope);
        const subscribers = this.subscriptions.get(sessionId);
        if (subscribers && subscribers.size > 0) {
          for (const connId of subscribers) {
            this.gateway.pushEvent(
              "session.event",
              { sessionId, cursor: entry.cursor, event: entry.event },
              connId,
            );
          }
        }
        const eventType =
          envelope.event && typeof envelope.event === "object"
            ? (envelope.event as { type?: unknown }).type
            : undefined;
        if (typeof eventType === "string" && ATTENTION_AGENT_EVENT_TYPES.has(eventType)) {
          this.scheduleAttentionBroadcast();
        }
      }
      return;
    }

    if (
      channel === IPC.event.mcProjectProposalsChanged ||
      channel === IPC.event.mcAlchemyProposalsChanged ||
      channel === IPC.event.plansChanged ||
      channel === IPC.event.agentQueueChanged
    ) {
      this.scheduleAttentionBroadcast();
      return;
    }

    if (channel === IPC.event.canvasChanged) {
      this.gateway.pushEvent("canvas.changed", payload ?? {});
    }
  }

  async dispatchRpc(connId: string, method: string, params: unknown): Promise<unknown> {
    return dispatchMobileRpc(this.rpcContext(), connId, method, params);
  }

  private rpcContext(): RpcHandlerContext {
    return {
      dataDir: this.deps.dataDir,
      appVersion: this.deps.appVersion,
      hostname: this.deps.hostname,
      getHost: this.deps.getHost,
      invoke: this.deps.invoke,
      activeTurns: this.deps.activeTurns,
      sendToRenderer: this.deps.sendToRenderer,
      collectDiff: this.collectDiff,
      getGatewayStatus: () => this.gateway.getStatus(),
      pushGatewayEvent: (event, payload, connId) => this.gateway.pushEvent(event, payload, connId),
      subscribeSession: (connId, sessionId, afterCursor) => {
        let conns = this.subscriptions.get(sessionId);
        if (!conns) {
          conns = new Set();
          this.subscriptions.set(sessionId, conns);
        }
        conns.add(connId);
        const buf = this.sessionBuffers.get(sessionId) ?? [];
        const replayed = afterCursor > 0 ? buf.filter((entry) => entry.cursor > afterCursor) : [];
        for (const entry of replayed) {
          this.gateway.pushEvent(
            "session.event",
            { sessionId, cursor: entry.cursor, event: entry.event },
            connId,
          );
        }
        return {
          sessionId,
          cursor: this.latestCursorFor(sessionId),
          replayedCount: replayed.length,
          isRunning: this.deps.activeTurns.has(sessionId),
        };
      },
      unsubscribeSession: (connId, sessionId) => {
        const conns = this.subscriptions.get(sessionId);
        if (conns) {
          conns.delete(connId);
          if (conns.size === 0) this.subscriptions.delete(sessionId);
        }
      },
      latestCursorFor: (sessionId) => this.latestCursorFor(sessionId),
    };
  }

  private async handleRpc(req: GatewayRpcRequest): Promise<void> {
    try {
      const result = await this.dispatchRpc(req.connId, req.method, req.params);
      this.gateway.sendRpcResponse(req.connId, req.id, { ok: true, result });
    } catch (error) {
      this.gateway.sendRpcResponse(req.connId, req.id, {
        ok: false,
        error: {
          code: errorCodeOf(error),
          message: errorMessageOf(error),
        },
      });
    }
  }

  private appendSessionEvent(sessionId: string, event: AgentEventEnvelope): BufferedSessionEvent {
    const entry: BufferedSessionEvent = { cursor: ++this.eventCursor, event };
    let buf = this.sessionBuffers.get(sessionId);
    if (!buf) {
      buf = [];
      this.sessionBuffers.set(sessionId, buf);
    }
    buf.push(entry);
    if (buf.length > MC_MOBILE_MAX_EVENT_HISTORY) {
      buf.splice(0, buf.length - MC_MOBILE_MAX_EVENT_HISTORY);
    }
    return entry;
  }

  private latestCursorFor(sessionId: string): number {
    const buf = this.sessionBuffers.get(sessionId);
    return buf && buf.length > 0 ? buf[buf.length - 1]!.cursor : this.eventCursor;
  }

  private scheduleAttentionBroadcast(): void {
    if (this.attentionTimer || this.gateway.getStatus().state !== "running") return;
    this.attentionTimer = setTimeout(() => {
      this.attentionTimer = null;
      this.gateway.pushEvent("attention.updated", { at: Date.now() });
    }, 200);
  }

  private mergeStatus(status: MobileGatewayStatus): MobileGatewayStatus {
    return {
      ...status,
      enabled: this.enabled,
      devices: status.state === "running" ? status.devices : this.stoppedDevices,
    };
  }

  private async ensureConfigLoaded(): Promise<void> {
    if (this.configLoaded) return;
    this.configLoaded = true;
    try {
      const raw = await readFile(this.configPath, "utf8");
      const parsed = JSON.parse(raw) as Partial<MobileConfig>;
      this.enabled = parsed.enabled === true;
    } catch {
      this.enabled = false;
    }
    this.stoppedDevices = await this.readDevicesFromDisk();
    this.gateway.setEnabledFlag(this.enabled);
  }

  private async saveConfig(config: MobileConfig): Promise<void> {
    const dir = join(this.deps.dataDir, "mobile");
    await mkdir(dir, { recursive: true });
    const tmp = `${this.configPath}.tmp`;
    await writeFile(tmp, `${JSON.stringify(config, null, 2)}\n`, "utf8");
    await rename(tmp, this.configPath);
  }

  private async readDevicesFromDisk(): Promise<MobileDeviceInfo[]> {
    try {
      const raw = await readFile(this.devicesPath, "utf8");
      const parsed = JSON.parse(raw) as Array<{
        deviceId: string;
        name: string;
        platform: string;
        pairedAt: number;
        lastSeenAt: number;
      }>;
      if (!Array.isArray(parsed)) return [];
      return parsed.map((d) => ({
        deviceId: d.deviceId,
        name: d.name,
        platform: d.platform,
        pairedAt: d.pairedAt,
        lastSeenAt: d.lastSeenAt,
        online: false,
      }));
    } catch {
      return [];
    }
  }

  private async writeDevicesToDisk(devices: MobileDeviceInfo[]): Promise<void> {
    const dir = join(this.deps.dataDir, "mobile");
    await mkdir(dir, { recursive: true });
    const serialized = devices.map(({ deviceId, name, platform, pairedAt, lastSeenAt }) => ({
      deviceId,
      name,
      platform,
      pairedAt,
      lastSeenAt,
    }));
    const tmp = `${this.devicesPath}.tmp`;
    await writeFile(tmp, `${JSON.stringify(serialized, null, 2)}\n`, "utf8");
    await rename(tmp, this.devicesPath);
  }
}
