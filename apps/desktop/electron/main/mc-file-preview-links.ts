import type { WebContents } from "electron";

// The file manager's Markdown preview only shows a "not opened" toast for a
// link. Injected by the host so newer marketplace copies are covered too; if a
// release changes this markup, the script stops matching and the plugin's own
// behavior remains. Opening goes through `window.open`, which plugin-view-host
// checks against the external URL allowlist, so this grants the view nothing
// it could not already do. Anything but http(s) and mailto keeps the toast.
export const FILE_PREVIEW_LINKS_SCRIPT = `(() => {
  const NOT_OPENED = "（点击复制/提示，不跳转）";
  const OPENABLE = /^(?:https?:\\/\\/|mailto:)/i;
  const linkOf = (target) =>
    target instanceof Element ? target.closest("a.md-link:not(.md-link-unsafe)") : null;
  const urlOf = (link) => {
    const title = link.title;
    const url = title.endsWith(NOT_OPENED) ? title.slice(0, -NOT_OPENED.length) : title;
    return OPENABLE.test(url) ? url : null;
  };
  const open = (event) => {
    const link = linkOf(event.target);
    const url = link && urlOf(link);
    if (!url) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    window.open(url, "_blank");
  };
  // Capture: runs before the plugin's handler, which would show the toast.
  window.addEventListener("click", open, true);
  window.addEventListener(
    "keydown",
    (event) => {
      if (event.key === "Enter" || event.key === " ") open(event);
    },
    true,
  );
  // The tooltip says links do not open; show just the address instead.
  window.addEventListener(
    "pointerover",
    (event) => {
      const link = linkOf(event.target);
      if (link && link.title.endsWith(NOT_OPENED)) link.title = urlOf(link) ?? link.title;
    },
    true,
  );
})();`;

export function installFilePreviewLinks(
  contents: Pick<WebContents, "on" | "executeJavaScript" | "isDestroyed">,
  pluginId: string,
): void {
  if (pluginId !== "pi.file-manager") return;
  contents.on("dom-ready", () => {
    void contents.executeJavaScript(FILE_PREVIEW_LINKS_SCRIPT).catch((error) => {
      if (!contents.isDestroyed()) console.warn("File preview links could not be enabled", error);
    });
  });
}
