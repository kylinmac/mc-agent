import type { ProviderPublic, SubscriptionQuota, SubscriptionQuotaWindow } from "@pi-desktop/shared";
import {
  codexAccountId,
  parseClaudeUsage,
  parseCodexUsage,
  parseCopilotUsage,
  parseGlmUsage,
  parseKimiUsage,
  parseMinimaxUsage,
} from "./parse.ts";

/*
  mc-agent: read the remaining quota of the provider a conversation uses.
  Only subscription logins and coding-plan keys of known services are asked,
  each at its own fixed official host, so a credential never goes anywhere
  else. Answers (including "nothing to show") are cached per provider:
  some endpoints throttle hard, and the composer asks after every reply.
*/

type ModelAuth = { apiKey?: string; headers?: Record<string, string | null>; baseUrl?: string };

/** Request headers without the entries a provider clears with null. */
function present(headers: Record<string, string | null> | undefined): Record<string, string> {
  return Object.fromEntries(Object.entries(headers ?? {}).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
}

export type SubscriptionQuotaDeps = {
  provider: (id: string) => Promise<ProviderPublic | null>;
  secret: (id: string) => Promise<string | null>;
  resolveAuth: (id: string) => Promise<ModelAuth>;
  copilotGithubToken: (id: string) => Promise<string | undefined>;
  fetch: (url: string, init: RequestInit) => Promise<Response>;
  now?: () => number;
};

type Reader = {
  source: string;
  /** How long an answer is reused. */
  ttlMs: number;
  request: () => Promise<{ url: string; headers: Record<string, string> } | null>;
  parse: (body: unknown) => SubscriptionQuotaWindow[];
};

const MINUTE = 60_000;
const REQUEST_TIMEOUT_MS = 10_000;
const OAUTH_KIND = "oauth";

function hostOf(baseUrl: string | undefined): string {
  try {
    return baseUrl ? new URL(baseUrl).hostname.toLowerCase() : "";
  } catch {
    return "";
  }
}

function bearer(token: string | undefined): Record<string, string> | null {
  return token ? { Authorization: `Bearer ${token}` } : null;
}

/** The reader for a provider, or null when it has no known quota endpoint. */
export function quotaReaderFor(provider: ProviderPublic, deps: SubscriptionQuotaDeps): Reader | null {
  const oauth = provider.authKind === OAUTH_KIND;
  const vendor = provider.vendorKey;
  const host = hostOf(provider.baseUrl);
  const access = async () => (await deps.resolveAuth(provider.id)).apiKey;
  const key = () => deps.secret(provider.id);

  if (oauth && (vendor === "openai-codex" || vendor === "openai-chatgpt")) {
    return {
      source: "codex", ttlMs: 2 * MINUTE, parse: parseCodexUsage,
      request: async () => {
        const token = await access();
        if (!token) return null;
        const account = codexAccountId(token);
        return {
          url: "https://chatgpt.com/backend-api/wham/usage",
          headers: { Authorization: `Bearer ${token}`, ...(account ? { "chatgpt-account-id": account } : {}) },
        };
      },
    };
  }
  if (oauth && vendor === "anthropic") {
    // This endpoint throttles hard; ask rarely.
    return {
      source: "claude", ttlMs: 5 * MINUTE, parse: parseClaudeUsage,
      request: async () => {
        const headers = bearer(await access());
        return headers
          ? { url: "https://api.anthropic.com/api/oauth/usage", headers: { ...headers, "anthropic-beta": "oauth-2025-04-20" } }
          : null;
      },
    };
  }
  if (oauth && vendor === "github-copilot") {
    return {
      source: "copilot", ttlMs: 5 * MINUTE, parse: parseCopilotUsage,
      request: async () => {
        const token = await deps.copilotGithubToken(provider.id);
        return token
          ? { url: "https://api.github.com/copilot_internal/user", headers: { Authorization: `token ${token}` } }
          : null;
      },
    };
  }
  if ((oauth && vendor === "kimi-coding") || (!oauth && host === "api.kimi.com")) {
    return {
      source: "kimi", ttlMs: 2 * MINUTE, parse: parseKimiUsage,
      request: async () => {
        if (oauth) {
          const auth = await deps.resolveAuth(provider.id);
          return auth.apiKey
            ? { url: "https://api.kimi.com/coding/v1/usages", headers: { ...present(auth.headers), Authorization: `Bearer ${auth.apiKey}` } }
            : null;
        }
        const headers = bearer((await key()) ?? undefined);
        return headers ? { url: "https://api.kimi.com/coding/v1/usages", headers } : null;
      },
    };
  }
  if (!oauth && (host === "api.z.ai" || host === "open.bigmodel.cn")) {
    return {
      source: "glm", ttlMs: 2 * MINUTE, parse: parseGlmUsage,
      // Z.ai's own tools send the bare key, without "Bearer".
      request: async () => {
        const secret = await key();
        return secret ? { url: `https://${host}/api/monitor/usage/quota/limit`, headers: { Authorization: secret } } : null;
      },
    };
  }
  if (!oauth && (host === "api.minimaxi.com" || host === "api.minimax.io")) {
    return {
      source: "minimax", ttlMs: 2 * MINUTE, parse: parseMinimaxUsage,
      request: async () => {
        const headers = bearer((await key()) ?? undefined);
        return headers ? { url: `https://${host}/v1/token_plan/remains`, headers } : null;
      },
    };
  }
  return null;
}

export class SubscriptionQuotaService {
  private readonly cache = new Map<string, { at: number; ttl: number; value: SubscriptionQuota | null }>();
  private readonly inflight = new Map<string, Promise<SubscriptionQuota | null>>();

  private readonly deps: SubscriptionQuotaDeps;

  constructor(deps: SubscriptionQuotaDeps) {
    this.deps = deps;
  }

  private now() {
    return this.deps.now?.() ?? Date.now();
  }

  /** The provider's quota, or null when it has none to show. Never throws. */
  async read(providerId: string): Promise<SubscriptionQuota | null> {
    const cached = this.cache.get(providerId);
    if (cached && this.now() - cached.at < cached.ttl) return cached.value;
    const running = this.inflight.get(providerId);
    if (running) return running;
    const next = this.fetch(providerId).finally(() => this.inflight.delete(providerId));
    this.inflight.set(providerId, next);
    return next;
  }

  /** Forget a provider's answer, e.g. after its credential changed. */
  invalidate(providerId: string): void {
    this.cache.delete(providerId);
  }

  private async fetch(providerId: string): Promise<SubscriptionQuota | null> {
    let ttl = 10 * MINUTE;
    let value: SubscriptionQuota | null = null;
    try {
      const provider = await this.deps.provider(providerId);
      const reader = provider ? quotaReaderFor(provider, this.deps) : null;
      if (reader) {
        ttl = reader.ttlMs;
        const request = await reader.request();
        if (request) {
          const response = await this.deps.fetch(request.url, {
            method: "GET",
            headers: { Accept: "application/json", ...request.headers },
            redirect: "error",
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
          });
          if (response.ok) {
            const windows = reader.parse(await response.json());
            if (windows.length > 0) value = { source: reader.source, windows, fetchedAt: this.now() };
          }
        }
      }
    } catch {
      value = null;
    }
    this.cache.set(providerId, { at: this.now(), ttl, value });
    return value;
  }
}
