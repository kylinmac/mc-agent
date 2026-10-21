import assert from "node:assert/strict";
import test from "node:test";
import { register } from "node:module";

register("./helpers/ts-import-hooks.mjs", import.meta.url);
const { readXaiImageModels } = await import("../electron/main/creative/account-image-models.ts");
const { vendorAccountImageModelIds } = await import("@pi-desktop/shared");

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

test("xAI image models come from the account's image model list", async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push([String(url), new Headers(init.headers).get("authorization")]);
    return json({ models: [{ id: "grok-imagine-image-3" }, { id: "grok-imagine-image" }] });
  };
  assert.deepEqual(await readXaiImageModels("https://api.x.ai/v1/", "tok", fetchImpl), [
    "grok-imagine-image-3",
    "grok-imagine-image",
  ]);
  assert.deepEqual(calls, [["https://api.x.ai/v1/image-generation-models", "Bearer tok"]]);
});

test("without that route, the general list is filtered to image models; nothing usable is null", async () => {
  const fallback = async (url) =>
    String(url).endsWith("/image-generation-models")
      ? json({ error: "not found" }, 404)
      : json({ data: [{ id: "grok-4.7" }, { id: "grok-imagine-image" }, { id: "grok-imagine-video" }] });
  assert.deepEqual(await readXaiImageModels("https://api.x.ai", "tok", fallback), ["grok-imagine-image"]);
  const nothing = async () => json({}, 500);
  assert.equal(await readXaiImageModels("https://api.x.ai/v1", "tok", nothing), null);
});

test("an account's reported list replaces the built-in one, which stays the fallback", () => {
  const account = { vendorKey: "xai", authKind: "oauth", hasOauth: true };
  assert.deepEqual(vendorAccountImageModelIds({ ...account, accountImageModels: ["grok-imagine-image-3"] }), [
    "grok-imagine-image-3",
  ]);
  assert.ok(vendorAccountImageModelIds(account).includes("grok-imagine-image"));
  assert.deepEqual(vendorAccountImageModelIds({ ...account, hasOauth: false, accountImageModels: ["x"] }), []);
});
