import type { WebContents } from "electron";
import { catalogs } from "@pi-desktop/i18n";

// Work on rendered text without rewriting React's DOM or the editor buffer.
// The host override also covers marketplace copies of the file manager.
export const FILE_PREVIEW_SEARCH_SCRIPT = `(() => {
  const labels = ${JSON.stringify({ en: catalogs.en.fileManager, zh: catalogs["zh-CN"].fileManager })};
  let closeSearch = null;
  window.addEventListener('keydown', (event) => {
    if (!(event.ctrlKey || event.metaKey) || event.altKey || event.key.toLowerCase() !== 'f') return;
    const body = document.querySelector('.md-body');
    if (!body) return;
    const editor = document.activeElement?.closest('.cm-editor');
    if (editor && editor.getBoundingClientRect().width > 0) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    const existing = document.querySelector('[data-mc-preview-search] input');
    if (existing) { existing.focus(); existing.select(); return; }
    const scroll = body.closest('.md-scroll');
    const content = scroll?.parentElement;
    if (!scroll || !content?.parentElement) return;
    const copy = document.documentElement.lang.startsWith('zh') ? labels.zh : labels.en;
    const previousFocus = document.activeElement;
    const bar = document.createElement('div');
    bar.dataset.mcPreviewSearch = '';
    bar.setAttribute('role', 'search');
    bar.setAttribute('aria-label', copy.findPreview);
    bar.style.cssText = 'display:flex;flex:none;flex-wrap:wrap;align-items:center;gap:6px;padding:6px 8px;background:var(--surface);color:var(--fg);border-bottom:1px solid var(--border);font-size:12px';
    const input = document.createElement('input');
    input.type = 'search';
    input.placeholder = copy.findPreview;
    input.setAttribute('aria-label', copy.findPreview);
    input.style.cssText = 'min-width:60px;flex:1;width:120px;padding:4px 6px;background:var(--bg);color:var(--fg);border:1px solid var(--border);border-radius:4px';
    const count = document.createElement('output');
    count.setAttribute('aria-live', 'polite');
    bar.append(input, count);
    const button = (label, text, action) => {
      const element = document.createElement('button');
      element.type = 'button';
      element.title = label;
      element.setAttribute('aria-label', label);
      element.textContent = text;
      element.style.cssText = 'background:var(--bg);color:var(--fg);border:1px solid var(--border);border-radius:4px;padding:3px 7px';
      element.addEventListener('click', action);
      bar.append(element);
      return element;
    };
    let ranges = [];
    let active = -1;
    let truncated = false;
    let timer;
    const display = (reveal) => {
      count.textContent = (active + 1) + ' / ' + ranges.length + (truncated ? '+' : '');
      previous.disabled = next.disabled = ranges.length === 0;
      CSS.highlights.set('mc-preview-matches', new Highlight(...ranges));
      CSS.highlights.set('mc-preview-active', new Highlight(...(active < 0 ? [] : [ranges[active]])));
      if (reveal && active >= 0) {
        const rect = ranges[active].getBoundingClientRect();
        const viewport = scroll.getBoundingClientRect();
        scroll.scrollTop += rect.top - viewport.top - viewport.height / 2;
      }
    };
    const navigate = (step) => {
      if (timer) { clearTimeout(timer); timer = undefined; search(); }
      if (!ranges.length) return;
      active = (active + step + ranges.length) % ranges.length;
      display(true);
    };
    const previous = button(copy.previousMatch, '↑', () => navigate(-1));
    const next = button(copy.nextMatch, '↓', () => navigate(1));
    const close = () => {
      clearTimeout(timer);
      observer.disconnect();
      bar.remove();
      style.remove();
      CSS.highlights.delete('mc-preview-matches');
      CSS.highlights.delete('mc-preview-active');
      closeSearch = null;
      if (bar.contains(document.activeElement) || document.activeElement === document.body) {
        if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus();
      }
    };
    button(copy.closeSearch, '×', close);
    const style = document.createElement('style');
    style.textContent = '::highlight(mc-preview-matches){background:#ffe38a;color:#111}::highlight(mc-preview-active){background:#ff9633;color:#111}';
    document.head.append(style);
    content.parentElement.insertBefore(bar, content);
    const search = () => {
      ranges = [];
      active = -1;
      truncated = false;
      const query = input.value;
      if (query) {
        const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT);
        const nodes = [];
        let text = '';
        let lastBlock = null;
        while (walker.nextNode()) {
          const node = walker.currentNode;
          const block = node.parentElement.closest('p,li,h1,h2,h3,h4,h5,h6,td,th,pre,blockquote');
          if (block !== lastBlock && text) text += '\\n';
          lastBlock = block;
          nodes.push({ node, start: text.length, end: text.length + node.length });
          text += node.data;
        }
        const pattern = new RegExp(RegExp.escape(query), 'giu');
        let match;
        let startIndex = 0;
        let endIndex = 0;
        while ((match = pattern.exec(text))) {
          // shortcut: cap highlights at 2000; add paging if large previews need more.
          if (ranges.length === 2000) { truncated = true; break; }
          const start = match.index;
          const end = start + match[0].length;
          while (startIndex < nodes.length && nodes[startIndex].end <= start) startIndex++;
          endIndex = Math.max(endIndex, startIndex);
          while (endIndex < nodes.length && nodes[endIndex].end < end) endIndex++;
          if (!nodes[startIndex] || !nodes[endIndex] || nodes[startIndex].start > start) continue;
          const range = document.createRange();
          range.setStart(nodes[startIndex].node, start - nodes[startIndex].start);
          range.setEnd(nodes[endIndex].node, end - nodes[endIndex].start);
          ranges.push(range);
        }
        if (ranges.length) active = 0;
      }
      display(true);
    };
    input.addEventListener('input', () => {
      clearTimeout(timer);
      timer = setTimeout(() => { timer = undefined; search(); }, 100);
    });
    bar.addEventListener('keydown', (key) => {
      if (key.isComposing) return;
      if (key.key === 'Escape' || key.key === 'Enter') {
        key.preventDefault();
        key.stopPropagation();
        if (key.key === 'Escape') close();
        else navigate(key.shiftKey ? -1 : 1);
      }
    });
    const observer = new MutationObserver((records) => {
      if (!body.isConnected) { close(); return; }
      if (!records.some(record => body.contains(record.target))) return;
      clearTimeout(timer);
      timer = setTimeout(() => { timer = undefined; search(); }, 100);
    });
    observer.observe(document.body, { subtree: true, childList: true, characterData: true });
    closeSearch = close;
    display(false);
    input.focus();
  }, true);
  window.addEventListener('pagehide', () => closeSearch?.());
})();`;

export function installFilePreviewSearch(
  contents: Pick<WebContents, "on" | "executeJavaScript" | "isDestroyed">,
  pluginId: string,
): void {
  if (pluginId !== "pi.file-manager") return;
  contents.on("dom-ready", () => {
    void contents.executeJavaScript(FILE_PREVIEW_SEARCH_SCRIPT).catch((error) => {
      if (!contents.isDestroyed()) console.warn("File preview search could not be enabled", error);
    });
  });
}
