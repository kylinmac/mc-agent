import { net } from "electron";
import { ErrorCodes, IPC, type ProviderPublic } from "@pi-desktop/shared";
import type { HostProcess } from "../host-process";
import type { VendorOAuth } from "../oauth";
import type { IpcRegistrar } from "./types";
import { SubscriptionQuotaService } from "../subscription-quota/service.ts";

/**
 * mc-agent: the remaining subscription quota of a provider, for the chip
 * beside the composer. Credentials stay in Main; the renderer gets only
 * window lengths, remaining shares and reset times.
 */
export function registerMcQuotaIpc({ registrar, getHost, vendorOAuth }: {
  registrar: IpcRegistrar;
  getHost: () => HostProcess | null;
  vendorOAuth: Pick<VendorOAuth, "resolveAuth" | "copilotGithubToken">;
}): void {
  const host = () => {
    const current = getHost();
    if (!current) throw new Error("host unavailable");
    return current;
  };
  const service = new SubscriptionQuotaService({
    provider: async (id) => (await host().call<{ provider?: ProviderPublic }>("providers.get", { id })).provider ?? null,
    secret: async (id) => (await host().call<{ value?: string | null }>("providers.getSecret", { id })).value ?? null,
    resolveAuth: (id) => vendorOAuth.resolveAuth(id),
    copilotGithubToken: (id) => vendorOAuth.copilotGithubToken(id),
    fetch: (url, init) => net.fetch(url, init),
  });
  registrar.handle(IPC.invoke.mcSubscriptionQuota, async (input: { providerId?: unknown } = {}) => {
    const providerId = typeof input?.providerId === "string" ? input.providerId.trim() : "";
    if (!providerId || providerId.length > 256) {
      throw Object.assign(new Error("provider id required"), { errorCode: ErrorCodes.INVALID_ARGUMENT });
    }
    return { quota: await service.read(providerId) };
  });
}
