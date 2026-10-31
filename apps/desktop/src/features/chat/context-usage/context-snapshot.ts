import type { SessionContextBreakdown } from "@pi-desktop/shared";

/** Share a request between indicators, without retaining session data forever. */
export function createContextSnapshotCache() {
  const entries = new Map<string, { keys: readonly unknown[]; result: Promise<SessionContextBreakdown | null> }>();
  return (sessionId: string, keys: readonly unknown[], load: () => Promise<SessionContextBreakdown | null>) => {
    const previous = entries.get(sessionId);
    if (previous && keys.length === previous.keys.length && keys.every((key, i) => Object.is(key, previous.keys[i]))) {
      return previous.result;
    }
    const result = load();
    entries.delete(sessionId);
    entries.set(sessionId, { keys, result });
    if (entries.size > 32) entries.delete(entries.keys().next().value!);
    return result;
  };
}
