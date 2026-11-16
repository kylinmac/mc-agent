import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { api } = await import("../src/lib/api.ts");
const { readSubscriptionQuota, refreshSubscriptionQuota, subscribeSubscriptionQuota } =
  await import("../src/features/chat/composer/subscription-quota-store.ts");
const quota = (remainingPercent) => ({ source: "codex", fetchedAt: 1,
  windows: [{ remainingPercent, seconds: 604800 }] });

test("conversations share requests, snapshots and one poller, which stops after the last reader", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setInterval"], now: 1000 });
  const calls = [];
  t.mock.method(api, "subscriptionQuota", (providerId) => new Promise((resolve, reject) => calls.push({ providerId, resolve, reject })));
  let updates = 0;
  const first = subscribeSubscriptionQuota("shared", () => { updates++; });
  const second = subscribeSubscriptionQuota("shared", () => { updates++; });
  assert.equal(calls.length, 1);
  calls[0].resolve({ quota: quota(99) });
  await refreshSubscriptionQuota("shared");
  assert.equal(updates, 2);
  first(); second();
  const again = subscribeSubscriptionQuota("shared", () => {});
  assert.equal(readSubscriptionQuota("shared").windows[0].remainingPercent, 99);
  assert.equal(calls.length, 1, "switching conversations does not query again");
  t.mock.timers.tick(5 * 60_000);
  assert.equal(calls.length, 2, "one refresh for the whole account");
  calls[1].reject(new Error("offline"));
  await refreshSubscriptionQuota("shared");
  assert.deepEqual(readSubscriptionQuota("shared"), { ...quota(99), stale: true });
  again();
  t.mock.timers.tick(10 * 60_000);
  assert.equal(calls.length, 2, "unmounted accounts stop polling");
});

test("late answers stay with their account, and a successful empty answer clears the old value", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setInterval"], now: 1000 });
  const calls = [];
  t.mock.method(api, "subscriptionQuota", (providerId) => new Promise((resolve) => calls.push({ providerId, resolve })));
  const stopA = subscribeSubscriptionQuota("account-a", () => {});
  stopA();
  const stopB = subscribeSubscriptionQuota("account-b", () => {});
  calls[1].resolve({ quota: quota(40) });
  await refreshSubscriptionQuota("account-b");
  calls[0].resolve({ quota: quota(99) });
  await refreshSubscriptionQuota("account-a");
  assert.equal(readSubscriptionQuota("account-b").windows[0].remainingPercent, 40);
  assert.equal(readSubscriptionQuota(undefined), null);
  t.mock.timers.tick(5 * 60_000);
  calls[2].resolve({ quota: null });
  await refreshSubscriptionQuota("account-b");
  assert.equal(readSubscriptionQuota("account-b"), null);
  stopB();
});
