import { fileURLToPath } from "node:url";
import { createServer } from "vite";

export function createDesktopSsrServer(options = {}) {
  return createServer({
    root: fileURLToPath(new URL("../..", import.meta.url)),
    configFile: false,
    // Tests load fixed modules. Watching the workspace adds native file watchers to every test.
    server: { middlewareMode: true, hmr: false, ws: false, watch: null },
    appType: "custom",
    optimizeDeps: { noDiscovery: true, include: [] },
    ...options,
  });
}
