import assert from "node:assert/strict";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import i18n from "i18next";
import { loadTsModule } from "./load-ts-module.mjs";
import { ErrorCodes } from "../../../../packages/shared/src/errors.ts";
import { normalizeMode } from "../../../../packages/shared/src/types/common.ts";
import { IPC, IPC_WHITELIST } from "../../../../packages/shared/src/protocol.ts";

const testRoot = new URL("../", import.meta.url);
const load = (path, ...options) => loadTsModule(new URL(path, testRoot), ...options);

const shared = { ErrorCodes, IPC, IPC_WHITELIST, normalizeMode };
const collaboration = load("../electron/main/services/session-collaboration.ts", {
  "node:crypto": crypto,
  "../agent-host-bridge": {},
  "../plugin-agent-complete": {},
});
export const { registerSessionIpc } = load("../electron/main/ipc/session-ipc.ts", {
  electron: { shell: {} },
  "node:fs": fs,
  "node:path": path,
  "@pi-desktop/shared": shared,
  "./session-import-ipc": { registerSessionImportIpc() {} },
  "../services/session-collaboration": collaboration,
  "../bootstrap/remote-hosts.js": { getActiveRemoteHostsBoot: () => null },
  "../services/session-search": { searchSessionsAcrossSources: async () => ({ hits: [], nextOffset: null }) },
});

export function rendererApi(invoke) {
  let bridge;
  load("../electron/preload/index.ts", {
    electron: {
      contextBridge: { exposeInMainWorld: (name, value) => {
        assert.equal(name, "piDesktop");
        bridge = value;
      } },
      ipcRenderer: { invoke },
      webUtils: {},
    },
    "@pi-desktop/shared": shared,
    "@pi-desktop/shared/protocol": shared,
  });
  const { api } = load("../src/lib/api.ts", {
    "@pi-desktop/shared": shared,
    "./plan-history": load("../src/lib/plan-history.ts", {}),
    "./remote-ipc-safety": load("../src/lib/remote-ipc-safety.ts", {
      "@pi-desktop/shared": shared,
      i18next: { default: i18n },
    }),
    "./remote-session-safety": load("../src/lib/remote-session-safety.ts", {}),
  }, {
    window: { piDesktop: bridge },
  });
  return { api, bridge };
}
