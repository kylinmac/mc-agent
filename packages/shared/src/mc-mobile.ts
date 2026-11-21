/**
 * mc-agent (R43): shared contract for Mobile Remote Access (`mc-mobile-gateway`
 * over iroh P2P/Relay + Electron Main `mobile-bridge` + Settings UI).
 */

export const MC_MOBILE_PROTOCOL_VERSION = 1 as const;
export const MC_MOBILE_PAIR_URI_PREFIX = "mc-pair://v1";
export const MC_MOBILE_DEFAULT_PAIR_TTL_SECS = 600;
export const MC_MOBILE_MAX_EVENT_HISTORY = 300;
export const MC_MOBILE_MAX_IMAGE_BYTES = 10 * 1024 * 1024;

/** Allowlisted small-vocabulary RPC methods exposed to paired mobile devices. */
export const MC_MOBILE_METHODS = [
  "host.info",
  "attention.list",
  "projects.list",
  "sessions.list",
  "session.create",
  "session.configure",
  "session.history",
  "session.subscribe",
  "session.unsubscribe",
  "turn.send",
  "turn.stop",
  "approval.respond",
  "ask.respond",
  "proposal.respond",
  "diff.summary",
  "diff.file",
  "canvas.list",
  "canvas.get",
  "canvas.createWhiteboard",
  "canvas.saveWhiteboard",
] as const;

export type McMobileMethod = (typeof MC_MOBILE_METHODS)[number];

export const MC_MOBILE_METHOD_SET: ReadonlySet<string> = new Set(MC_MOBILE_METHODS);

export type MobileDeviceInfo = {
  deviceId: string;
  name: string;
  platform: string;
  pairedAt: number;
  lastSeenAt: number;
  online: boolean;
};

export type MobileGatewayStateKind = "stopped" | "starting" | "running" | "error";

export type MobileGatewayStatus = {
  enabled: boolean;
  state: MobileGatewayStateKind;
  nodeId?: string;
  hostname?: string;
  relay?: string | null;
  addrs: string[];
  devices: MobileDeviceInfo[];
  error?: string;
};

export type MobilePairingOffer = {
  secret: string;
  expiresAt: number;
  pairUri: string;
  qrSvg: string;
};

export type MobileAttentionKind =
  | "permission"
  | "ask"
  | "plan"
  | "project_proposal"
  | "alchemy_proposal"
  | "running"
  | "completed";

export type MobileAttentionItem = {
  id: string;
  kind: MobileAttentionKind;
  sessionId: string;
  sessionTitle: string;
  projectName?: string;
  summary: string;
  createdAt: number;
  payload?: Record<string, unknown>;
};

export type MobilePairCode = {
  nodeId: string;
  secret: string;
  name: string;
  relay?: string;
  addrs: string[];
};

export type MobilePairParseResult =
  | { ok: true; value: MobilePairCode }
  | { ok: false; error: string };

const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

/** Parse and validate an `mc-pair://v1?...` pairing URI. */
export function parseMobilePairUri(raw: unknown): MobilePairParseResult {
  if (typeof raw !== "string") return { ok: false, error: "Pairing code must be a string." };
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > 2048 || CONTROL_CHARS.test(trimmed)) {
    return { ok: false, error: "Pairing code is empty, too long, or malformed." };
  }
  if (!trimmed.startsWith(`${MC_MOBILE_PAIR_URI_PREFIX}?`)) {
    return { ok: false, error: `Pairing code must start with ${MC_MOBILE_PAIR_URI_PREFIX}?` };
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { ok: false, error: "Invalid pairing URI syntax." };
  }
  const nodeId = parsed.searchParams.get("node")?.trim() ?? "";
  const secret = parsed.searchParams.get("secret")?.trim() ?? "";
  const name = (parsed.searchParams.get("name")?.trim() || "mc-agent Desktop").slice(0, 80);
  const relay = parsed.searchParams.get("relay")?.trim() || undefined;
  const addrs = parsed.searchParams
    .getAll("addr")
    .map((a) => a.trim())
    .filter((a) => a.length > 0 && a.length <= 128)
    .slice(0, 8);

  if (!nodeId || nodeId.length < 16 || nodeId.length > 128) {
    return { ok: false, error: "Missing or invalid gateway node id." };
  }
  if (!secret || secret.length < 16 || secret.length > 128) {
    return { ok: false, error: "Missing or invalid pairing secret." };
  }
  return {
    ok: true,
    value: {
      nodeId,
      secret,
      name,
      ...(relay ? { relay } : {}),
      addrs,
    },
  };
}

export function isAllowedMobileMethod(method: unknown): method is McMobileMethod {
  return typeof method === "string" && MC_MOBILE_METHOD_SET.has(method);
}
