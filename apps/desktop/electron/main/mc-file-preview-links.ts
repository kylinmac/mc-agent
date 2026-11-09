import type { WebContents } from "electron";

// The file manager's Markdown preview only shows a "not opened" toast for a
// link. Injected by the host so newer marketplace copies are covered too; if a
// release changes this markup, the script stops matching and the plugin's own
// behavior remains.
//
//   - http(s), mailto and bare `www.` addresses open through `window.open`,
//     which plugin-view-host checks against the external URL allowlist.
//   - File links (relative, absolute, `file:`) open in the file manager itself
//     through `ui.revealView`, the same call and permission a chat file
//     reference uses. Relative paths resolve against the open file's folder,
//     read from the header's copy-path button.
//   - `#heading` links scroll the preview to that heading.
//   - Anything else (javascript:, data:, unknown schemes) keeps the toast.
// So the script grants the view nothing it could not already do itself.
export const FILE_PREVIEW_LINKS_SCRIPT = String.raw`(() => {
  const SUFFIXES = ["（点击复制/提示，不跳转）", "（不支持的链接协议）"];
  const COPY_PATH = ["复制路径", "Copy path"];
  const WEB = /^(?:https?:\/\/|mailto:)/i;
  const BLOCKED = /^(?:javascript|data|vbscript|blob):/i;
  const SCHEME = /^[a-z][a-z0-9+.-]*:/i;
  const DRIVE = /^[A-Za-z]:[\\/]/;
  const isAbsolute = (p) => p.startsWith("/") || p.startsWith("\\\\") || DRIVE.test(p);

  const linkOf = (target) => (target instanceof Element ? target.closest("a.md-link") : null);
  const hrefOf = (link) => {
    // A title this script rewrote; React restores the plugin's own title when
    // the link's address changes, and then that wins again.
    if (link.dataset.mcHref !== undefined && link.title === link.dataset.mcTitle) return link.dataset.mcHref;
    const title = link.title;
    for (const suffix of SUFFIXES) if (title.endsWith(suffix)) return title.slice(0, -suffix.length).trim();
    return null;
  };
  const decode = (value) => {
    try { return decodeURIComponent(value); } catch { return value; }
  };

  const currentFile = () => {
    for (const label of COPY_PATH) {
      const button = document.querySelector('button[title="' + label + '"]');
      if (button) return (button.textContent || "").replace(/\s*✓$/, "").trim() || null;
    }
    return null;
  };
  const normalize = (path) => {
    const sep = path.includes("\\") && !path.includes("/") ? "\\" : "/";
    const parts = path.split(/[\\/]/);
    const head = isAbsolute(path) ? [parts.shift()] : [];
    const out = [];
    for (const part of parts) {
      if (part === "" || part === ".") continue;
      if (part === "..") {
        if (out.length && out[out.length - 1] !== "..") out.pop();
        else if (!head.length) out.push("..");
        continue;
      }
      out.push(part);
    }
    return head.concat(out).join(sep) || (head.length ? sep : "");
  };

  // Where a link points: { web }, { anchor }, { path } or null (leave the toast).
  const targetOf = (raw) => {
    const href = raw.trim();
    if (!href) return null;
    if (WEB.test(href)) return { web: href };
    if (/^www\.[^\s/]+\.[^\s]+/i.test(href)) return { web: "https://" + href };
    if (href.startsWith("#")) return { anchor: decode(href.slice(1)) };
    if (/^file:/i.test(href)) {
      try {
        let path = decode(new URL(href).pathname);
        if (/^\/[A-Za-z]:\//.test(path)) path = path.slice(1);
        return path ? { path: normalize(path) } : null;
      } catch { return null; }
    }
    if (BLOCKED.test(href) || (SCHEME.test(href) && !DRIVE.test(href))) return null;
    if (href.startsWith("~")) return null;
    const path = decode(href.replace(/[?#].*$/, ""));
    if (!path) return null;
    if (isAbsolute(path)) return { path: normalize(path) };
    const file = currentFile();
    if (!file) return null;
    const folder = file.replace(/[\\/][^\\/]*$/, "");
    const joined = folder === file ? path : folder + "/" + path;
    const resolved = normalize(joined);
    return resolved && !resolved.startsWith("..") ? { path: resolved } : null;
  };

  const slug = (text) =>
    text.trim().toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, "").replace(/\s/g, "-");
  const scrollTo = (link, anchor) => {
    const body = link.closest(".md-body") || document;
    const want = anchor.trim().toLowerCase();
    const heading = [...body.querySelectorAll("h1,h2,h3,h4,h5,h6")].find(
      (h) => slug(h.textContent || "") === slug(want) || (h.textContent || "").trim().toLowerCase() === want,
    );
    if (!heading) return false;
    heading.scrollIntoView({ block: "start" });
    return true;
  };

  // The view ignores a repeat of the path it was last handed, so a second
  // click on the same link after browsing away sends the other spelling of it
  // (relative to the primary root vs absolute).
  let lastSent = null;
  let primaryRoot;
  const rootPath = async () => {
    if (primaryRoot !== undefined) return primaryRoot;
    try {
      const ws = await window.pluginBridge.invoke("workspace.get", {});
      const roots = Array.isArray(ws && ws.roots) ? ws.roots : [];
      const primary = roots.find((r) => r && r.primary) || roots[0] || ws;
      primaryRoot = primary && typeof primary.path === "string" ? primary.path.replace(/[\\/]+$/, "") : null;
    } catch { primaryRoot = null; }
    return primaryRoot;
  };
  const openFile = async (path) => {
    let location = path;
    if (location === lastSent) {
      const root = await rootPath();
      if (root && !isAbsolute(location)) location = root + "/" + location;
      else if (root && location.startsWith(root + "/")) location = location.slice(root.length + 1);
    }
    lastSent = location;
    try {
      await window.pluginBridge.invoke("ui.revealView", { viewId: "manager", location });
    } catch {
      const zh = String(navigator.language || "").toLowerCase().startsWith("zh");
      window.pluginBridge
        .invoke("ui.showToast", { message: (zh ? "无法打开：" : "Could not open: ") + path })
        .catch(() => {});
    }
  };

  const open = (event) => {
    const link = linkOf(event.target);
    const href = link && hrefOf(link);
    const target = href === null || href === undefined ? null : targetOf(href);
    if (!target) return;
    if (target.anchor !== undefined && !scrollTo(link, target.anchor)) return;
    if (target.path !== undefined && !(window.pluginBridge && window.pluginBridge.invoke)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (target.web) window.open(target.web, "_blank");
    else if (target.path !== undefined) void openFile(target.path);
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
      const href = link && hrefOf(link);
      if (!href || !targetOf(href)) return;
      link.title = href;
      link.dataset.mcHref = href;
      link.dataset.mcTitle = href;
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
