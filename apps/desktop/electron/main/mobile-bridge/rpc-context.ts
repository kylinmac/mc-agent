import type { MobileGatewayStatus, WorkspaceDiff } from "@pi-desktop/shared";

export type HostLike = {
  call: <T = unknown>(method: string, params?: unknown) => Promise<T>;
};

export type RpcHandlerContext = {
  dataDir: string;
  appVersion: string;
  hostname?: string;
  getHost: () => HostLike | null;
  invoke: (channel: string, args: unknown[]) => Promise<unknown>;
  activeTurns: ReadonlyMap<string, string>;
  sendToRenderer: (channel: string, payload: unknown) => void;
  collectDiff: (cwd: string) => Promise<WorkspaceDiff>;
  getGatewayStatus: () => MobileGatewayStatus;
  pushGatewayEvent: (event: string, payload: unknown, connId?: string) => void;
  subscribeSession: (connId: string, sessionId: string, afterCursor: number) => {
    sessionId: string;
    cursor: number;
    replayedCount: number;
    isRunning: boolean;
  };
  unsubscribeSession: (connId: string, sessionId: string) => void;
  latestCursorFor: (sessionId: string) => number;
};

export function rpcError(code: string, message: string): Error & { rpcCode: string } {
  return Object.assign(new Error(message), { rpcCode: code });
}

export function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function asNonEmptyString(value: unknown, maxLen = 512): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > maxLen) return null;
  return trimmed;
}
