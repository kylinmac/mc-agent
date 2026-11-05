const { contextBridge, ipcRenderer } = require("electron");
const root = { path: "C:/fixture/project", name: "project", projectId: "fixture", roots: [{ path: "C:/fixture/project", name: "project", primary: true }] };
const prefs = { splitRatio: 0.32, treeCollapsed: false, mdPreview: false, projectRoots: {} };
contextBridge.exposeInMainWorld("pluginBridge", {
  async invoke(channel, payload = {}) {
    if (channel === "app.getAppearance") return { base: "dark", locale: "en" };
    if (channel === "workspace.get") return root;
    if (channel === "fm.hello") return { ok: true, root, limits: { maxReadBytes: 2097152, maxWriteBytes: 8388608, maxListEntries: 5000 }, ignoreFiles: [], prefs };
    if (channel === "fm.prefs.set") return { ok: true, prefs: { ...prefs, ...payload.partial } };
    if (channel === "fm.list") return { ok: true, path: "", entries: [{ name: "test.ts", path: "test.ts", isDirectory: false, size: 22, mtimeMs: 1 }], truncated: false };
    if (channel === "fm.read") return { ok: true, kind: "text", path: "test.ts", text: "const visible = true;\n", eol: "lf", bom: false, size: 22, mtimeMs: 1 };
    if (channel === "fm.write") return ipcRenderer.invoke("fixture:save", payload);
    throw new Error("Unexpected fixture channel: " + channel);
  },
  on() { return () => {}; },
});
