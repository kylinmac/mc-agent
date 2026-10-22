/** mc-agent (bugs.md B-008): authors read as names, never as JSON text. */
import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

register("./helpers/ts-import-hooks.mjs", import.meta.url);
const { authorParts } = await import("../src/features/plugins/model.ts");

test("author text and objects become a name and a page", () => {
  assert.deepEqual(authorParts("PI-Desktop"), { name: "PI-Desktop" });
  assert.deepEqual(authorParts('{"name":"归星 (GzxingR)","url":"https://github.com/GzxingR"}'), {
    name: "归星 (GzxingR)",
    url: "https://github.com/GzxingR",
  });
  assert.deepEqual(authorParts('{"name":"x","url":"file:///etc"}'), { name: "x" });
  assert.deepEqual(authorParts("{broken"), { name: "{broken" });
  assert.deepEqual(authorParts(undefined), { name: "" });
});
