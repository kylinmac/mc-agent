import { randomUUID } from "node:crypto";
import { IPC, type AgentPanelRequest } from "@pi-desktop/shared";

/** One renderer request at a time per nonce, bounded and cancelled with the tool. */
export class PanelBridge {
  private pending = new Map<string, (value: { result?: unknown; error?: string }) => void>();
  private send?: (channel: string, payload: unknown) => void;
  connect(send: (channel: string, payload: unknown) => void) { this.send = send; }
  reply(id: string, value: { result?: unknown; error?: string }) { this.pending.get(id)?.(value); }
  async request(input: Omit<AgentPanelRequest, "requestId">, signal: AbortSignal): Promise<unknown> {
    signal.throwIfAborted();
    if (!this.send) throw new Error("Work panel renderer unavailable");
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      const finish = (value: { result?: unknown; error?: string }) => {
        clearTimeout(timer);
        signal.removeEventListener("abort", aborted);
        this.pending.delete(requestId);
        if (value.error) reject(new Error(value.error)); else resolve(value.result);
      };
      const aborted = () => finish({ error: "Work panel request cancelled" });
      const timer = setTimeout(() => finish({ error: "Work panel renderer did not respond" }), 5000);
      this.pending.set(requestId, finish);
      signal.addEventListener("abort", aborted, { once: true });
      this.send?.(IPC.event.workPanelAgentRequest, { ...input, requestId });
    });
  }
}
export const panelBridge = new PanelBridge();
