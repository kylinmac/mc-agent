import type { SubscriptionQuota } from "@pi-desktop/shared";
import { api } from "../../../lib/api";

const POLL_MS = 5 * 60_000;
const MIN_REFRESH_MS = 2 * 60_000;
type Account = {
  quota: SubscriptionQuota | null;
  checkedAt: number;
  loading?: Promise<void>;
  timer?: ReturnType<typeof setInterval>;
  listeners: Set<() => void>;
};
const accounts = new Map<string, Account>();

function account(providerId: string): Account {
  let state = accounts.get(providerId);
  if (!state) {
    state = { quota: null, checkedAt: -Infinity, listeners: new Set() };
    accounts.set(providerId, state);
  }
  return state;
}

export function readSubscriptionQuota(providerId: string | undefined): SubscriptionQuota | null {
  return providerId ? accounts.get(providerId)?.quota ?? null : null;
}

export function refreshSubscriptionQuota(providerId: string): Promise<void> {
  const state = account(providerId);
  if (state.loading) return state.loading;
  if (Date.now() - state.checkedAt < MIN_REFRESH_MS) return Promise.resolve();
  state.loading = api.subscriptionQuota(providerId).then(
    ({ quota }) => { state.quota = quota; },
    () => { if (state.quota) state.quota = { ...state.quota, stale: true }; },
  ).finally(() => {
    state.checkedAt = Date.now();
    state.loading = undefined;
    for (const listener of state.listeners) listener();
  });
  return state.loading;
}

/** One poller per visible account; retain its snapshot across conversation switches. */
export function subscribeSubscriptionQuota(providerId: string, listener: () => void): () => void {
  const state = account(providerId);
  state.listeners.add(listener);
  if (!state.timer) state.timer = setInterval(() => void refreshSubscriptionQuota(providerId), POLL_MS);
  void refreshSubscriptionQuota(providerId);
  return () => {
    state.listeners.delete(listener);
    if (state.listeners.size === 0) {
      clearInterval(state.timer);
      state.timer = undefined;
    }
  };
}
