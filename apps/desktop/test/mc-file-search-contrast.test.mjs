import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { installFileSearchContrast, FILE_SEARCH_CONTRAST_CSS } from "../electron/main/mc-file-search-contrast.ts";

test("file-manager views receive contrast styles on every page load; other plugins do not", () => {
  for (const pluginId of ["pi.file-manager", "pi.browser"]) {
    const contents = new EventEmitter();
    const calls = [];
    contents.insertCSS = async (...args) => { calls.push(args); return "css-key"; };
    contents.isDestroyed = () => false;
    installFileSearchContrast(contents, pluginId);
    contents.emit("dom-ready");
    contents.emit("dom-ready");
    assert.equal(calls.length, pluginId === "pi.file-manager" ? 2 : 0);
    for (const call of calls) assert.deepEqual(call, [FILE_SEARCH_CONTRAST_CSS, { cssOrigin: "user" }]);
  }
});
