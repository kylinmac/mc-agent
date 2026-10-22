import { IPC } from "@pi-desktop/shared";
import type { HostProcess } from "../host-process";
import type { IpcRegistrar } from "./types";

/** mc-agent (MC-ADR-0011): token usage summaries, computed by host-core. */
export function registerMcUsageIpc({
  registrar,
  getHost,
}: {
  registrar: IpcRegistrar;
  getHost: () => HostProcess | null;
}): void {
  // mc-agent (MC-ADR-0011): token usage by model, project, day and conversation.
  registrar.handle(IPC.invoke.mcUsageSummary, async (input: { fromMs?: unknown; toMs?: unknown } = {}) => {
    const host = getHost();
    if (!host) throw new Error("host unavailable");
    const fromMs = typeof input?.fromMs === "number" && Number.isFinite(input.fromMs) ? input.fromMs : 0;
    const toMs = typeof input?.toMs === "number" && Number.isFinite(input.toMs) ? input.toMs : Date.now();
    return host.call("mcUsage.summary", { fromMs, toMs });
  });
}
