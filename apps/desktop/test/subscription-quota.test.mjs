import assert from "node:assert/strict";
import test from "node:test";
import { subscriptionQuotaWindowKind } from "@pi-desktop/shared";
import {
  codexAccountId,
  parseClaudeUsage,
  parseCodexUsage,
  parseCopilotUsage,
  parseGlmUsage,
  parseKimiUsage,
  parseMinimaxUsage,
  parseXaiUsage,
} from "../electron/main/subscription-quota/parse.ts";
import { SubscriptionQuotaService, quotaReaderFor } from "../electron/main/subscription-quota/service.ts";

const H = 3600;
const WEEK = 7 * 24 * H;

test("Codex windows are told apart by length, not slot", () => {
  // A plan with a 5h and a weekly window.
  assert.deepEqual(parseCodexUsage({ rate_limit: {
    primary_window: { used_percent: 34, limit_window_seconds: 18000, reset_at: 1778091218 },
    secondary_window: { used_percent: 37, limit_window_seconds: 604800, reset_at: 1778605571 },
  } }), [
    { remainingPercent: 66, seconds: 18000, resetsAt: 1778091218000 },
    { remainingPercent: 63, seconds: 604800, resetsAt: 1778605571000 },
  ]);
  // A plan whose only window is weekly, reported in the primary slot.
  assert.deepEqual(parseCodexUsage({ rate_limit: {
    primary_window: { used_percent: 10, limit_window_seconds: 604800, reset_at: 1778605571 },
    secondary_window: null,
  } }), [{ remainingPercent: 90, seconds: 604800, resetsAt: 1778605571000 }]);
  assert.deepEqual(parseCodexUsage({}), []);
});

test("Claude reports a 5h and a weekly window", () => {
  assert.deepEqual(parseClaudeUsage({
    five_hour: { utilization: 6.0, resets_at: "2025-11-04T04:59:59.943648+00:00" },
    seven_day: { utilization: 35.0, resets_at: "2025-11-06T03:59:59.943679+00:00" },
    seven_day_opus: { utilization: 0, resets_at: null },
  }).map(({ remainingPercent, seconds }) => [remainingPercent, seconds]), [[94, 5 * H], [65, WEEK]]);
  assert.deepEqual(parseClaudeUsage({ five_hour: null, seven_day: { utilization: 20 } }), [{ remainingPercent: 80, seconds: WEEK }]);
});

test("Copilot has only a monthly window, and none when unlimited or absent", () => {
  const [month] = parseCopilotUsage({
    quota_reset_date: "2026-11-01",
    quota_snapshots: { premium_interactions: { entitlement: 300, remaining: 94, percent_remaining: 31.2 } },
  });
  assert.equal(month.remainingPercent, 31.2);
  assert.equal(subscriptionQuotaWindowKind(month.seconds).kind, "month");
  assert.equal(month.resetsAt, Date.parse("2026-11-01"));
  assert.deepEqual(parseCopilotUsage({ quota_snapshots: { premium_interactions: { unlimited: true } } }), []);
  assert.deepEqual(parseCopilotUsage({ quota_snapshots: { premium_interactions: { has_quota: false } } }), []);
});

test("Kimi reads its window rows and the weekly bucket, deriving a missing used", () => {
  assert.deepEqual(parseKimiUsage({
    usage: { limit: "100", remaining: "40", resetTime: "2026-09-26T12:32:15.376980Z" },
    limits: [{ window: { duration: 300, timeUnit: "TIME_UNIT_MINUTE" }, detail: { limit: "100", remaining: "100", resetTime: "2026-09-22T04:32:15Z" } }],
  }).map(({ remainingPercent, seconds }) => [remainingPercent, seconds]), [[100, 5 * H], [40, WEEK]]);
});

test("GLM keeps 5h and weekly token windows and drops the MCP quota", () => {
  assert.deepEqual(parseGlmUsage({ success: true, data: { limits: [
    { type: "TOKENS_LIMIT", unit: 3, number: 5, percentage: 82, nextResetTime: 1761400000000 },
    { type: "TOKENS_LIMIT", unit: 6, number: 1, percentage: 19 },
    { type: "TIME_LIMIT", currentValue: 12, usage: 1000, percentage: 1 },
    { type: "TOKENS_LIMIT", unit: 9, number: 1, percentage: 50 },
  ] } }), [
    { remainingPercent: 18, seconds: 5 * H, resetsAt: 1761400000000 },
    { remainingPercent: 81, seconds: WEEK },
  ]);
  assert.deepEqual(parseGlmUsage({ success: false, code: 401 }), []);
});

test("MiniMax prefers remaining percentages and reads counts as what is left", () => {
  const start = 1761400000000;
  assert.deepEqual(parseMinimaxUsage({ base_resp: { status_code: 0 }, model_remains: [{
    model_name: "MiniMax-M2",
    current_interval_remaining_percent: 72,
    current_weekly_remaining_percent: 98,
    start_time: start, end_time: start + 5 * H * 1000,
    weekly_start_time: start, weekly_end_time: start + WEEK * 1000,
  }] }), [
    { remainingPercent: 72, seconds: 5 * H, resetsAt: start + 5 * H * 1000 },
    { remainingPercent: 98, seconds: WEEK, resetsAt: start + WEEK * 1000 },
  ]);
  // Legacy coding plan: only interval counts; `usage_count` is what is left.
  assert.deepEqual(parseMinimaxUsage({ model_remains: [{ current_interval_total_count: 1500, current_interval_usage_count: 1459 }] })
    .map(({ remainingPercent }) => remainingPercent), [97.3]);
  assert.deepEqual(parseMinimaxUsage({ base_resp: { status_code: 1004 } }), []);
});

test("xAI reads the credit pool of the billing period, nested or not", () => {
  const start = "2026-10-21T10:00:00Z";
  const end = "2026-10-28T10:00:00Z";
  assert.deepEqual(parseXaiUsage({ config: { creditUsagePercent: 6, billingPeriodStart: start, billingPeriodEnd: end } }), [
    { remainingPercent: 94, seconds: 604800, resetsAt: Date.parse(end) },
  ]);
  assert.deepEqual(parseXaiUsage({ creditUsagePercent: 12.5, currentPeriod: { start, end } })[0].remainingPercent, 87.5);
  // Without a period it still shows what is left, unlabelled.
  assert.deepEqual(parseXaiUsage({ config: { creditUsagePercent: 130 } }), [{ remainingPercent: 0 }]);
  assert.deepEqual(parseXaiUsage({ config: {} }), []);
  // A fresh period leaves out the zero percent: nothing used yet, not no pool.
  assert.deepEqual(
    parseXaiUsage({ config: {
      currentPeriod: { type: "USAGE_PERIOD_TYPE_WEEKLY", start, end },
      onDemandCap: { val: 0 }, billingPeriodStart: start, billingPeriodEnd: end,
    } }),
    [{ remainingPercent: 100, seconds: 604800, resetsAt: Date.parse(end) }],
  );
  // Without a usable period a missing percent still shows nothing.
  assert.deepEqual(parseXaiUsage({ config: { billingPeriodStart: end, billingPeriodEnd: start } }), []);
  assert.deepEqual(parseXaiUsage("<html>"), []);
});

test("window lengths become labels; odd lengths are not forced into one", () => {
  assert.deepEqual(subscriptionQuotaWindowKind(18000), { kind: "hours", count: 5 });
  assert.deepEqual(subscriptionQuotaWindowKind(86400), { kind: "day" });
  assert.deepEqual(subscriptionQuotaWindowKind(604800), { kind: "week" });
  assert.deepEqual(subscriptionQuotaWindowKind(30 * 86400), { kind: "month" });
  assert.deepEqual(subscriptionQuotaWindowKind(3 * 86400), { kind: "days", count: 3 });
  assert.deepEqual(subscriptionQuotaWindowKind(undefined), { kind: "unknown" });
});

test("the Codex account id comes from the access token's claims", () => {
  const payload = Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acct-1" } })).toString("base64url");
  assert.equal(codexAccountId(`x.${payload}.y`), "acct-1");
  assert.equal(codexAccountId("not-a-jwt"), undefined);
});

const provider = (fields) => ({ id: "p1", name: "p", vendorKey: "", type: "native", protocol: "", enabled: true, authKind: "api_key", hasSecret: true, models: [], supportsReasoning: false, ...fields });

test("only known services get a reader, and credentials go to their fixed host", async () => {
  const deps = {
    resolveAuth: async () => ({ apiKey: "access" }),
    secret: async () => "key",
    copilotGithubToken: async () => "gho_x",
  };
  const requestFor = async (fields) => (await quotaReaderFor(provider(fields), deps)?.request()) ?? null;

  assert.equal((await requestFor({ authKind: "oauth", vendorKey: "openai-codex" })).url, "https://chatgpt.com/backend-api/wham/usage");
  const claude = await requestFor({ authKind: "oauth", vendorKey: "anthropic" });
  assert.equal(claude.headers["anthropic-beta"], "oauth-2025-04-20");
  assert.equal((await requestFor({ authKind: "oauth", vendorKey: "github-copilot" })).headers.Authorization, "token gho_x");
  assert.equal((await requestFor({ baseUrl: "https://open.bigmodel.cn/api/coding/paas/v4" })).url, "https://open.bigmodel.cn/api/monitor/usage/quota/limit");
  assert.equal((await requestFor({ baseUrl: "https://api.z.ai/api/anthropic" })).headers.Authorization, "key");
  assert.equal((await requestFor({ baseUrl: "https://api.minimaxi.com/anthropic" })).url, "https://api.minimaxi.com/v1/token_plan/remains");
  assert.equal((await requestFor({ baseUrl: "https://api.kimi.com/coding/v1" })).url, "https://api.kimi.com/coding/v1/usages");

  // API keys of other services, look-alike hosts and plain logins get nothing.
  assert.equal(quotaReaderFor(provider({ baseUrl: "https://api.openai.com/v1" }), deps), null);
  assert.equal(quotaReaderFor(provider({ baseUrl: "https://api.z.ai.evil.example/v1" }), deps), null);
  const xai = await requestFor({ authKind: "oauth", vendorKey: "xai" });
  assert.equal(xai.url, "https://cli-chat-proxy.grok.com/v1/billing?format=credits");
  assert.equal(xai.headers.Authorization, "Bearer access");
  assert.equal(xai.headers["x-grok-client-mode"], "cli");
  // An xAI API key is billed per token, not from a subscription pool.
  assert.equal(quotaReaderFor(provider({ vendorKey: "xai", baseUrl: "https://api.x.ai/v1" }), deps), null);
  // An API key on the Anthropic vendor is not a subscription.
  assert.equal(quotaReaderFor(provider({ vendorKey: "anthropic", baseUrl: "https://api.anthropic.com" }), deps), null);
});

test("answers are cached per provider, empty ones included, and failures never throw", async () => {
  let now = 0;
  const calls = [];
  let body = { rate_limit: { primary_window: { used_percent: 50, limit_window_seconds: 18000 } } };
  const service = new SubscriptionQuotaService({
    provider: async (id) => (id === "missing" ? null : provider({ id, authKind: "oauth", vendorKey: "openai-codex" })),
    secret: async () => null,
    resolveAuth: async () => ({ apiKey: "access" }),
    copilotGithubToken: async () => undefined,
    fetch: async (url, init) => {
      calls.push({ url, redirect: init.redirect });
      if (body === "fail") throw new Error("offline");
      return { ok: true, json: async () => body };
    },
    now: () => now,
  });
  const first = await service.read("p1");
  assert.deepEqual(first.windows, [{ remainingPercent: 50, seconds: 18000 }]);
  assert.equal(calls[0].redirect, "error");
  await service.read("p1");
  assert.equal(calls.length, 1, "a fresh answer is reused");
  now += 3 * 60_000;
  body = "fail";
  assert.equal(await service.read("p1"), null);
  assert.equal(calls.length, 2);
  assert.equal(await service.read("missing"), null);
  assert.equal(calls.length, 2, "a provider with no reader is never fetched");
});
