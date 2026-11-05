import { app, BrowserWindow, ipcMain } from "electron";
import assert from "node:assert/strict";
import { join } from "node:path";
import { pluginPanelOperation, setPluginPanelResolver } from "../../apps/desktop/electron/main/work-panel-agent/plugin-surface";

app.setPath("userData", join(process.env.MC_PANEL_TEST_DIR!, "profile"));
app.whenReady().then(async () => {
  const window = new BrowserWindow({ show: false, width: 800, height: 600, webPreferences: { backgroundThrottling: false } });
  try {
    await window.loadFile(join(process.env.MC_PANEL_TEST_DIR!, "test.html"));
    const wc = window.webContents;
    let owner = "s1";
    let epoch = 1;
    setPluginPanelResolver((_resource, sessionId) => {
      if (owner !== sessionId) throw new Error("Wrong owner");
      const version = epoch;
      return { wc, current: () => owner === sessionId && epoch === version };
    });
    const signal = new AbortController().signal;
    const read = () => pluginPanelOperation("fixture/editor", "s1", { action: "read" }, signal);
    const first = await read() as { tree: string; snapshot: string };
    assert.match(first.tree, /Draft editor/);
    const uid = first.tree.match(/- (e\d+) textbox "Draft editor"/)?.[1];
    assert.ok(uid, first.tree);
    await pluginPanelOperation("fixture/editor", "s1", { action: "type", uid, snapshot: first.snapshot, text: "new draft" }, signal);
    assert.equal(await wc.executeJavaScript("document.querySelector('textarea').value"), "new draft");
    await assert.rejects(pluginPanelOperation("fixture/editor", "s1", { action: "type", uid, snapshot: first.snapshot, text: "duplicate" }, signal), /Stale/);
    const second = await read() as { tree: string; snapshot: string };
    assert.match(second.tree, /new draft/, "unsaved editor text must reach the agent");
    const button = second.tree.match(/- (e\d+) button "Save"/)?.[1];
    assert.ok(button, second.tree);
    await pluginPanelOperation("fixture/editor", "s1", { action: "click", uid: button, snapshot: second.snapshot }, signal);
    assert.equal(await wc.executeJavaScript("window.saved"), "new draft");
    const third = await read() as { tree: string; snapshot: string };
    epoch++;
    await assert.rejects(pluginPanelOperation("fixture/editor", "s1", { action: "key", key: "Save", snapshot: third.snapshot }, signal), /Stale/);
    owner = "s2";
    await assert.rejects(read(), /Wrong owner/);
    const shortcuts = await wc.executeJavaScript("window.testTerminalShortcuts()");
    assert.deepEqual(shortcuts.copied.map((text: string) => text.trimEnd()), ["error 中文", "error 中文"]);
    assert.ok(shortcuts.input.includes("\u0003"), JSON.stringify(shortcuts));
    assert.equal(shortcuts.input.filter((value: string) => value.includes("paste fixture")).length, 1);
    // Real bundled CodeMirror editor: edits stay in its buffer and save via its normal bridge.
    let saved = "";
    ipcMain.handle("fixture:save", (_event, payload: { text?: string; content?: string }) => {
      saved = payload.text ?? payload.content ?? "";
      return { ok: true, path: "test.ts", mtimeMs: 2, size: saved.length };
    });
    const editor = new BrowserWindow({ show: false, width: 1000, height: 700,
      webPreferences: { sandbox: false, preload: join(process.env.MC_PANEL_TEST_DIR!, "preload.cjs"), backgroundThrottling: false } });
    await editor.loadFile(join(process.env.MC_PANEL_REPO!, "apps/desktop/resources/plugins/pi.file-manager/views/index.html"), { query: { piViewOpen: "test.ts" } });
    await editor.webContents.executeJavaScript(`new Promise((resolve, reject) => {
      const deadline = Date.now() + 5000;
      const poll = () => document.querySelector('.cm-content')?.textContent.includes('visible') ? resolve(true)
        : Date.now() > deadline ? reject(new Error('editor did not load')) : setTimeout(poll, 25);
      poll();
    })`);
    setPluginPanelResolver(() => ({ wc: editor.webContents, current: () => true }));
    const draft = await read() as { tree: string; snapshot: string };
    const editorUid = draft.tree.match(/- (e\d+) textbox[^\n]*visible/)?.[1];
    assert.ok(editorUid, draft.tree);
    await pluginPanelOperation("fixture/editor", "s1", { action: "type", uid: editorUid, snapshot: draft.snapshot, text: "// agent edit\n" }, signal);
    assert.equal(saved, "", "typing must not save behind the editor's back");
    const changed = await read() as { tree: string; snapshot: string };
    assert.match(changed.tree, /agent edit/);
    await pluginPanelOperation("fixture/editor", "s1", { action: "key", key: "Save", snapshot: changed.snapshot }, signal);
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.match(saved, /agent edit/);
    editor.destroy();
    console.log("WORK_PANEL_AGENT_OK");
    window.destroy(); app.exit(0);
  } catch (error) {
    console.error(error); window.destroy(); app.exit(1);
  }
});
