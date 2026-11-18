import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createCodexVersionReader } from "../electron/main/codex-client-version.ts";

async function codexHome(t) {
  const path = await mkdtemp(join(tmpdir(), "codex-version-"));
  t.after(() => rm(path, { recursive: true, force: true }));
  return path;
}

test("concurrent accounts share the public latest lookup even without a local CLI", async (t) => {
  const fetchPublic = t.mock.fn(async () => Response.json({ version: "1.10.0" }));
  const read = createCodexVersionReader(fetchPublic, await codexHome(t));
  assert.deepEqual(await Promise.all([read(), read()]), ["1.10.0", "1.10.0"]);
  assert.equal(await read(), "1.10.0");
  assert.equal(fetchPublic.mock.callCount(), 1);
  const [url, init] = fetchPublic.mock.calls[0].arguments;
  assert.equal(url, "https://registry.npmjs.org/@openai%2fcodex/latest");
  assert.equal(init.credentials, "omit");
  assert.equal(init.headers, undefined);
  assert.equal(init.redirect, "error");
});

test("the newer local version wins numerically and survives an offline refresh", async (t) => {
  t.mock.timers.enable({ apis: ["Date"] });
  const path = await codexHome(t);
  await writeFile(join(path, "models_cache.json"), JSON.stringify({ client_version: "1.10.2" }));
  await writeFile(join(path, "version.json"), JSON.stringify({ latest_version: "1.9.3" }));
  const fetchPublic = t.mock.fn(async () => Response.json({ version: "1.9.8" }));
  const read = createCodexVersionReader(fetchPublic, path);
  assert.equal(await read(), "1.10.2");
  await rm(join(path, "models_cache.json"));
  fetchPublic.mock.mockImplementation(async () => { throw new Error("offline"); });
  t.mock.timers.tick(24 * 60 * 60_000);
  assert.equal(await read(), "1.10.2");
  assert.equal(fetchPublic.mock.callCount(), 2);
  const offlineRead = createCodexVersionReader(fetchPublic, path);
  assert.equal(await offlineRead(), "1.9.3");
});

test("missing or invalid versions fall back and a later lookup recovers", async (t) => {
  t.mock.timers.enable({ apis: ["Date"] });
  const path = await codexHome(t);
  await writeFile(join(path, "models_cache.json"), "{");
  await writeFile(join(path, "version.json"), JSON.stringify({ latest_version: "1.9.0-alpha" }));
  const fetchPublic = t.mock.fn(async () => new Response(null, { status: 503 }));
  const read = createCodexVersionReader(fetchPublic, path);
  assert.equal(await read(), undefined);
  fetchPublic.mock.mockImplementation(async () => Response.json({ version: "2.0.0" }));
  t.mock.timers.tick(5 * 60_000 - 1);
  assert.equal(await read(), undefined);
  t.mock.timers.tick(1);
  assert.equal(await read(), "2.0.0");
});
