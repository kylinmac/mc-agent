/**
 * mc-agent (R43): manages the `mc-mobile-gateway` Rust iroh sidecar over stdio
 * NDJSON. Zero local TCP ports are opened; the sidecar exits cleanly on stdin EOF.
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { hostname as osHostname } from "node:os";
import { join } from "node:path";
import { createInterface, type Interface } from "node:readline";
import {
  MC_MOBILE_DEFAULT_PAIR_TTL_SECS,
  type MobileDeviceInfo,
  type MobileGatewayStatus,
  type MobilePairingOffer,
} from "@pi-desktop/shared";
import { getModuleDirectory } from "../module-path.ts";

export type GatewayRpcRequest = {
  connId: string;
  deviceId: string;
  id: string;
  method: string;
  params: unknown;
};

type HostEventMessage =
  | {
      type: "ready";
      nodeId: string;
      hostname: string;
      relay?: string | null;
      addrs?: string[];
      devices?: MobileDeviceInfo[];
    }
  | {
      type: "reachable";
      relay?: string | null;
      addrs?: string[];
    }
  | {
      type: "pair_created";
      secret: string;
      expiresAt: number;
      pairUri: string;
      qrSvg: string;
    }
  | {
      type: "devices_changed";
      devices: MobileDeviceInfo[];
    }
  | {
      type: "rpc_request";
      connId: string;
      deviceId: string;
      id: string;
      method: string;
      params: unknown;
    }
  | {
      type: "error";
      message: string;
    };

export function resolveMobileGatewayBinary(): string {
  if (process.env.MC_MOBILE_GATEWAY_BIN && existsSync(process.env.MC_MOBILE_GATEWAY_BIN)) {
    return process.env.MC_MOBILE_GATEWAY_BIN;
  }
  const exe = process.platform === "win32" ? ".exe" : "";
  const dir = getModuleDirectory(import.meta.url);
  const candidates = [
    join(process.resourcesPath || "", `bin/mc-mobile-gateway${exe}`),
    join(dir, `../../../../../target/debug/mc-mobile-gateway${exe}`),
    join(dir, `../../../../../target/release/mc-mobile-gateway${exe}`),
    join(dir, `../../../../target/debug/mc-mobile-gateway${exe}`),
    join(dir, `../../../../target/release/mc-mobile-gateway${exe}`),
  ];
  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) return candidate;
  }
  throw new Error(
    "mc-mobile-gateway binary not found. Run `cargo build -p mc-mobile-gateway` first.",
  );
}

type PendingOp<T> = {
  resolve: (value: T) => void;
  reject: (reason: Error) => void;
  timer: NodeJS.Timeout;
};

type PendingRevoke = PendingOp<{ removed: boolean }> & {
  deviceId: string;
  existedBefore: boolean;
};

export type MobileGatewayProcessOptions = {
  dataDir: string;
  hostname?: string;
  binaryPath?: string;
  noMdns?: boolean;
  log?: (level: "info" | "warn" | "error", message: string, data?: unknown) => void;
};

export class MobileGatewayProcess {
  private readonly dataDir: string;
  private readonly hostLabel: string;
  private readonly explicitBinaryPath?: string;
  private readonly noMdns: boolean;
  private readonly log?: MobileGatewayProcessOptions["log"];

  private child: ChildProcessWithoutNullStreams | null = null;
  private rl: Interface | null = null;
  private startPromise: Promise<MobileGatewayStatus> | null = null;
  private stopRequested = false;

  private readonly pendingPairs: PendingOp<MobilePairingOffer>[] = [];
  private readonly pendingRevokes: PendingRevoke[] = [];
  private readonly rpcListeners = new Set<(req: GatewayRpcRequest) => void>();
  private readonly deviceOfflineListeners = new Set<(deviceId: string) => void>();
  private readonly statusListeners = new Set<(status: MobileGatewayStatus) => void>();

  private status: MobileGatewayStatus = {
    enabled: false,
    state: "stopped",
    addrs: [],
    devices: [],
  };

  constructor(options: MobileGatewayProcessOptions) {
    this.dataDir = options.dataDir;
    this.hostLabel = (options.hostname?.trim() || osHostname() || "mc-agent Desktop").slice(0, 80);
    this.explicitBinaryPath = options.binaryPath;
    this.noMdns = Boolean(options.noMdns);
    this.log = options.log;
  }

  getStatus(): MobileGatewayStatus {
    return {
      ...this.status,
      addrs: [...this.status.addrs],
      devices: this.status.devices.map((d) => ({ ...d })),
    };
  }

  setEnabledFlag(enabled: boolean): void {
    if (this.status.enabled === enabled) return;
    this.status = { ...this.status, enabled };
    this.emitStatus();
  }

  onRpcRequest(listener: (req: GatewayRpcRequest) => void): () => void {
    this.rpcListeners.add(listener);
    return () => this.rpcListeners.delete(listener);
  }

  onDeviceOffline(listener: (deviceId: string) => void): () => void {
    this.deviceOfflineListeners.add(listener);
    return () => this.deviceOfflineListeners.delete(listener);
  }

  onStatusChanged(listener: (status: MobileGatewayStatus) => void): () => void {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }

  async start(): Promise<MobileGatewayStatus> {
    if (this.status.state === "running" && this.child) {
      return this.getStatus();
    }
    if (this.startPromise) return this.startPromise;

    this.stopRequested = false;
    let bin: string;
    try {
      bin = this.explicitBinaryPath || resolveMobileGatewayBinary();
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      this.status = { ...this.status, state: "error", error: msg, addrs: [] };
      this.emitStatus();
      throw error;
    }

    this.status = { ...this.status, state: "starting", error: undefined };
    this.emitStatus();

    const args = [
      "--data-dir",
      join(this.dataDir, "mobile"),
      "--name",
      this.hostLabel,
      ...(this.noMdns ? ["--no-mdns"] : []),
    ];

    this.startPromise = new Promise<MobileGatewayStatus>((resolveReady, rejectReady) => {
      let settled = false;
      const finishReady = (value: MobileGatewayStatus) => {
        if (settled) return;
        settled = true;
        clearTimeout(readyTimer);
        this.startPromise = null;
        resolveReady(value);
      };
      const finishError = (error: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(readyTimer);
        this.startPromise = null;
        rejectReady(error);
      };

      const readyTimer = setTimeout(() => {
        const err = new Error("mc-mobile-gateway startup timed out");
        this.status = { ...this.status, state: "error", error: err.message };
        this.emitStatus();
        void this.stop();
        finishError(err);
      }, 20_000);

      let child: ChildProcessWithoutNullStreams;
      try {
        child = spawn(bin, args, {
          stdio: ["pipe", "pipe", "pipe"],
          windowsHide: true,
        });
      } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        this.status = { ...this.status, state: "error", error: err.message };
        this.emitStatus();
        finishError(err);
        return;
      }

      this.child = child;
      this.rl = createInterface({ input: child.stdout, crlfDelay: Infinity });

      this.rl.on("line", (line) => {
        const trimmed = line.trim();
        if (!trimmed) return;
        let msg: HostEventMessage;
        try {
          msg = JSON.parse(trimmed) as HostEventMessage;
        } catch {
          this.log?.("warn", "mc-mobile-gateway emitted invalid JSON line");
          return;
        }
        this.handleEvent(msg, () => finishReady(this.getStatus()));
      });

      child.stderr.on("data", (chunk: Buffer) => {
        const text = chunk.toString("utf8").trim();
        if (text) this.log?.("warn", "mc-mobile-gateway stderr", text.slice(0, 500));
      });

      child.on("error", (error) => {
        const err = error instanceof Error ? error : new Error(String(error));
        this.log?.("error", "mc-mobile-gateway process error", err.message);
        this.cleanupProcess();
        this.status = { ...this.status, state: "error", error: err.message, addrs: [] };
        this.emitStatus();
        finishError(err);
      });

      child.on("exit", (code, signal) => {
        const wasStopRequested = this.stopRequested;
        this.cleanupProcess();
        if (wasStopRequested) {
          this.status = {
            ...this.status,
            state: "stopped",
            error: undefined,
            addrs: [],
            devices: this.status.devices.map((d) => ({ ...d, online: false })),
          };
          this.emitStatus();
          finishError(new Error("mc-mobile-gateway stopped"));
          return;
        }
        const message = `mc-mobile-gateway exited unexpectedly (code=${String(code)}, signal=${String(signal)})`;
        this.log?.("warn", message);
        this.status = {
          ...this.status,
          state: "error",
          error: message,
          addrs: [],
          devices: this.status.devices.map((d) => ({ ...d, online: false })),
        };
        this.emitStatus();
        finishError(new Error(message));
      });
    });

    return this.startPromise;
  }

  async stop(): Promise<void> {
    this.stopRequested = true;
    const child = this.child;
    if (!child) {
      this.status = {
        ...this.status,
        state: "stopped",
        error: undefined,
        addrs: [],
        devices: this.status.devices.map((d) => ({ ...d, online: false })),
      };
      this.emitStatus();
      return;
    }

    try {
      this.sendCommand({ type: "shutdown" });
      child.stdin.end();
    } catch {
      // Ignore write failures during shutdown.
    }

    await new Promise<void>((resolveStop) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        clearTimeout(killTimer);
        resolveStop();
      };
      const killTimer = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          // Already exited.
        }
        finish();
      }, 3000);
      child.once("exit", finish);
    });

    this.cleanupProcess();
    this.status = {
      ...this.status,
      state: "stopped",
      error: undefined,
      addrs: [],
      devices: this.status.devices.map((d) => ({ ...d, online: false })),
    };
    this.emitStatus();
  }

  async createPair(ttlSecs = MC_MOBILE_DEFAULT_PAIR_TTL_SECS): Promise<MobilePairingOffer> {
    if (!this.child || this.status.state !== "running") {
      throw new Error("Mobile gateway is not running");
    }
    return new Promise<MobilePairingOffer>((resolve, reject) => {
      const op: PendingOp<MobilePairingOffer> = {
        resolve,
        reject,
        timer: setTimeout(() => {
          const idx = this.pendingPairs.indexOf(op);
          if (idx >= 0) this.pendingPairs.splice(idx, 1);
          reject(new Error("Timed out creating mobile pairing code"));
        }, 10_000),
      };
      this.pendingPairs.push(op);
      try {
        this.sendCommand({ type: "create_pair", ttlSecs });
      } catch (error) {
        clearTimeout(op.timer);
        const idx = this.pendingPairs.indexOf(op);
        if (idx >= 0) this.pendingPairs.splice(idx, 1);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  async revokeDevice(deviceId: string): Promise<{ removed: boolean }> {
    if (!this.child || this.status.state !== "running") {
      throw new Error("Mobile gateway is not running");
    }
    const existedBefore = this.status.devices.some((d) => d.deviceId === deviceId);
    return new Promise<{ removed: boolean }>((resolve, reject) => {
      const op: PendingRevoke = {
        deviceId,
        existedBefore,
        resolve,
        reject,
        timer: setTimeout(() => {
          const idx = this.pendingRevokes.indexOf(op);
          if (idx >= 0) this.pendingRevokes.splice(idx, 1);
          reject(new Error("Timed out revoking mobile device"));
        }, 10_000),
      };
      this.pendingRevokes.push(op);
      try {
        this.sendCommand({ type: "revoke_device", deviceId });
      } catch (error) {
        clearTimeout(op.timer);
        const idx = this.pendingRevokes.indexOf(op);
        if (idx >= 0) this.pendingRevokes.splice(idx, 1);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  sendRpcResponse(
    connId: string,
    id: string,
    response: { ok: true; result: unknown } | { ok: false; error: { code: string; message: string } },
  ): void {
    if (!this.child || this.status.state !== "running") return;
    try {
      this.sendCommand({
        type: "rpc_response",
        connId,
        id,
        ok: response.ok,
        ...(response.ok ? { result: response.result } : { error: response.error }),
      });
    } catch {
      // Gateway closing; drop late responses safely.
    }
  }

  pushEvent(event: string, payload: unknown, connId?: string): void {
    if (!this.child || this.status.state !== "running") return;
    try {
      this.sendCommand({
        type: "push_event",
        ...(connId ? { connId } : {}),
        event,
        payload,
      });
    } catch {
      // Gateway closing; drop events safely.
    }
  }

  private sendCommand(command: Record<string, unknown>): void {
    if (!this.child || !this.child.stdin.writable) {
      throw new Error("Mobile gateway stdin is not writable");
    }
    this.child.stdin.write(`${JSON.stringify(command)}\n`);
  }

  private handleEvent(msg: HostEventMessage, onReady: () => void): void {
    switch (msg.type) {
      case "ready":
        this.status = {
          ...this.status,
          state: "running",
          nodeId: msg.nodeId,
          hostname: msg.hostname,
          relay: msg.relay ?? null,
          addrs: Array.isArray(msg.addrs) ? msg.addrs : [],
          devices: Array.isArray(msg.devices) ? msg.devices : [],
          error: undefined,
        };
        this.emitStatus();
        onReady();
        return;

      case "reachable":
        this.status = {
          ...this.status,
          relay: msg.relay ?? null,
          addrs: Array.isArray(msg.addrs) ? msg.addrs : [],
        };
        this.emitStatus();
        return;

      case "pair_created": {
        const pending = this.pendingPairs.shift();
        if (pending) {
          clearTimeout(pending.timer);
          pending.resolve({
            secret: msg.secret,
            expiresAt: msg.expiresAt,
            pairUri: msg.pairUri,
            qrSvg: msg.qrSvg,
          });
        }
        return;
      }

      case "devices_changed": {
        const prevOnline = new Set(
          this.status.devices.filter((d) => d.online).map((d) => d.deviceId),
        );
        const nextDevices = Array.isArray(msg.devices) ? msg.devices : [];
        const nextOnline = new Set(nextDevices.filter((d) => d.online).map((d) => d.deviceId));
        this.status = { ...this.status, devices: nextDevices };
        this.emitStatus();

        for (const deviceId of prevOnline) {
          if (!nextOnline.has(deviceId)) {
            for (const listener of this.deviceOfflineListeners) {
              listener(deviceId);
            }
          }
        }

        const revoke = this.pendingRevokes.shift();
        if (revoke) {
          clearTimeout(revoke.timer);
          const stillPresent = nextDevices.some((d) => d.deviceId === revoke.deviceId);
          revoke.resolve({ removed: revoke.existedBefore && !stillPresent });
        }
        return;
      }

      case "rpc_request": {
        const req: GatewayRpcRequest = {
          connId: msg.connId,
          deviceId: msg.deviceId,
          id: msg.id,
          method: msg.method,
          params: msg.params,
        };
        for (const listener of this.rpcListeners) {
          listener(req);
        }
        return;
      }

      case "error": {
        const pair = this.pendingPairs.shift();
        if (pair) {
          clearTimeout(pair.timer);
          pair.reject(new Error(msg.message));
          return;
        }
        const revoke = this.pendingRevokes.shift();
        if (revoke) {
          clearTimeout(revoke.timer);
          revoke.reject(new Error(msg.message));
          return;
        }
        this.log?.("warn", "mc-mobile-gateway error event", msg.message);
        return;
      }
    }
  }

  private cleanupProcess(): void {
    this.rl?.close();
    this.rl = null;
    this.child = null;
    const err = new Error("Mobile gateway process terminated");
    while (this.pendingPairs.length > 0) {
      const op = this.pendingPairs.shift()!;
      clearTimeout(op.timer);
      op.reject(err);
    }
    while (this.pendingRevokes.length > 0) {
      const op = this.pendingRevokes.shift()!;
      clearTimeout(op.timer);
      op.reject(err);
    }
  }

  private emitStatus(): void {
    const snapshot = this.getStatus();
    for (const listener of this.statusListeners) {
      listener(snapshot);
    }
  }
}
