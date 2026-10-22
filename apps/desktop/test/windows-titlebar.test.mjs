import assert from "node:assert/strict";
import test from "node:test";
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createInstance } from "i18next";
import { I18nextProvider } from "react-i18next";
import { catalogs } from "@pi-desktop/i18n";
import { createServer } from "vite";
import { fileURLToPath } from "node:url";

test("Windows has one persistent notification trigger; other platforms keep the tab trigger", async () => {
  const server = await createServer({
    root: fileURLToPath(new URL("..", import.meta.url)), configFile: false,
    server: { middlewareMode: true, hmr: false, ws: false },
    esbuild: { jsx: "automatic" }, appType: "custom", optimizeDeps: { noDiscovery: true, include: [] },
  });
  const previousWindow = globalThis.window;
  try {
    const { ConversationTopbar } = await server.ssrLoadModule("/src/components/ConversationTopbar.tsx");
    const { WindowsTitlebarActions } = await server.ssrLoadModule("/src/features/app-rail/WindowsTitlebarActions.tsx");
    const i18n = createInstance();
    await i18n.init({ lng: "en", resources: { en: { translation: catalogs.en } } });
    for (const platform of ["win32", "darwin", "linux"]) {
      globalThis.window = { piDesktop: { platform } };
      for (const collapsed of [true, false]) {
        const html = renderToStaticMarkup(h(I18nextProvider, { i18n },
          platform === "win32" && h(WindowsTitlebarActions, { collapsed, onToggleSidebar() {}, onOpenSearch() {} }),
          h(ConversationTopbar, { sidebarCollapsed: collapsed, workPanelOpen: false,
            onToggleSidebar() {}, onNewTask() {}, onOpenSearch() {} }),
        ));
        assert.equal((html.match(/class="notification-center"/g) ?? []).length, 1);
        assert.equal(html.includes("mc-windows-titlebar-actions"), platform === "win32");
        if (platform === "win32") {
          assert.ok(html.includes(`aria-expanded="${!collapsed}"`));
          assert.ok(html.indexOf('data-nav="toggle-sidebar"') < html.indexOf('class="notification-center"'));
          assert.ok(html.indexOf('class="notification-center"') < html.indexOf('data-nav="search"'));
        }
      }
    }
  } finally {
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
    await server.close();
  }
});
