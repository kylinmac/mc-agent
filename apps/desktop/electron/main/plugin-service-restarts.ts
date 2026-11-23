const MAX_RESTARTS = 5;
const INITIAL_DELAY_MS = 1_000;
const MAX_DELAY_MS = 30_000;
const HEALTHY_MS = 60_000;

type Restart = {
  attempts: number;
  controller: AbortController;
  timer?: ReturnType<typeof setTimeout>;
};

/** A crashed plugin has no child in the loaded registry while it waits for a restart. */
export class PluginServiceRestarts {
  private records = new Map<string, Restart>();

  attempts(pluginId: string): number {
    return this.records.get(pluginId)?.attempts ?? 0;
  }

  schedule(pluginId: string, resume: (attempt: number, signal: AbortSignal) => void) {
    const record: Restart = this.records.get(pluginId) ?? { attempts: 0, controller: new AbortController() };
    clearTimeout(record.timer);
    this.records.set(pluginId, record);
    if (record.attempts >= MAX_RESTARTS) return undefined;

    const attempt = ++record.attempts;
    const delayMs = Math.min(INITIAL_DELAY_MS * 2 ** (attempt - 1), MAX_DELAY_MS);
    record.timer = setTimeout(() => resume(attempt, record.controller.signal), delayMs);
    record.timer.unref();
    return { attempt, delayMs };
  }

  healthy(pluginId: string): void {
    const record = this.records.get(pluginId);
    if (!record) return;
    clearTimeout(record.timer);
    record.timer = setTimeout(() => this.records.delete(pluginId), HEALTHY_MS);
    record.timer.unref();
  }

  cancel(pluginId: string): void {
    const record = this.records.get(pluginId);
    if (!record) return;
    clearTimeout(record.timer);
    record.controller.abort();
    this.records.delete(pluginId);
  }

  cancelAll(): void {
    for (const pluginId of this.records.keys()) this.cancel(pluginId);
  }
}
