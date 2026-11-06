import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { FILE_PREVIEW_LINKS_SCRIPT, installFilePreviewLinks } from "../electron/main/mc-file-preview-links.ts";

test("file-manager views get the link script on every page load; other plugins do not", () => {
  for (const pluginId of ["pi.file-manager", "pi.browser"]) {
    const contents = new EventEmitter();
    const calls = [];
    contents.executeJavaScript = async (script) => { calls.push(script); };
    contents.isDestroyed = () => false;
    installFilePreviewLinks(contents, pluginId);
    contents.emit("dom-ready");
    contents.emit("dom-ready");
    assert.equal(calls.length, pluginId === "pi.file-manager" ? 2 : 0);
    for (const script of calls) assert.equal(script, FILE_PREVIEW_LINKS_SCRIPT);
  }
});
