import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

register("./helpers/ts-import-hooks.mjs", import.meta.url);
const { conciseUpdateError, updateUserAgent, withUpdateUserAgent } = await import("../electron/main/update-request.ts");

// Shape of the 2026-11-08 failure: electron-updater embeds headers, cookies and the feed XML.
const GITHUB_504 = 'Cannot parse releases feed: Error: Unable to find latest version on GitHub (https://github.com/kylinmac/mc-agent/releases/latest), please ensure a production release exists: HttpError: 504 "method: GET url: https://github.com/kylinmac/mc-agent/releases/latest\\n\\n Data:\\n <html><body><h1>504 Gateway Time-out</h1>" Headers: { "set-cookie": [ "_gh_sess=secret; path=/" ] } at createHttpError (httpExecutor.js:53:12), XML: <?xml version="1.0"?><feed></feed>';

test("GitHub HTTP failures become one short line without headers or cookies", () => {
  const text = conciseUpdateError(GITHUB_504);
  assert.equal(text, "GitHub did not answer the update request (HTTP 504); try again later");
  assert.doesNotMatch(text, /_gh_sess|set-cookie|<feed/);
});

test("other failures keep their first line, capped", () => {
  assert.equal(conciseUpdateError("net::ERR_INTERNET_DISCONNECTED\n    at foo"), "net::ERR_INTERNET_DISCONNECTED");
  assert.equal(conciseUpdateError("x".repeat(500)).length, 300);
  assert.equal(conciseUpdateError("update check timed out"), "update check timed out");
});

test("update requests use a browser user agent", () => {
  const electron = "Mozilla/5.0 (Macintosh) AppleWebKit/537.36 (KHTML, like Gecko) mc-agent/1.0.63 Chrome/140.0.0.0 Electron/43.0.0 Safari/537.36";
  assert.equal(updateUserAgent(electron), electron);
  for (const odd of [undefined, "", "electron-builder", "node"]) assert.match(updateUserAgent(odd), /^Mozilla\/5\.0 .*Chrome\//);
  const init = withUpdateUserAgent({ signal: undefined, headers: { Accept: "text/yaml" } }, "Mozilla/5.0 test");
  assert.equal(init.headers.get("User-Agent"), "Mozilla/5.0 test");
  assert.equal(init.headers.get("Accept"), "text/yaml");
  assert.equal(withUpdateUserAgent(undefined, "Mozilla/5.0 test").headers.get("user-agent"), "Mozilla/5.0 test");
});
