import type { WebContents } from "electron";

// A chat `path:line` reference opens in the file manager like any other file
// reference; the view's open request carries only the path, so the host moves
// to the line once the file is showing. Injected per request, it waits for the
// header to name the requested file, then:
//
//   - in the editor (CodeMirror), puts the cursor on the line, scrolls it into
//     the upper third and marks it briefly;
//   - in the Markdown preview, scrolls to the narrowest block whose
//     `data-source-line`/`data-source-end` range holds the line (or the next
//     block, for a blank line) and marks it briefly.
//
// Like the preview-links script it reads the plugin's own markup; if a release
// changes it, nothing matches and the file simply opens at the top.
export const REVEAL_LINE_TIMEOUT_MS = 10_000;
const MARK_MS = 1_600;

export function fileRevealLineScript(path: string, line: number): string {
  return String.raw`(() => {
  const want = ${JSON.stringify(path)}.replace(/\\/g, "/").replace(/^\/\.\//, "/");
  const line = ${JSON.stringify(line)};
  const COPY_PATH = ["复制路径", "Copy path"];
  const shown = () => {
    for (const label of COPY_PATH) {
      const button = document.querySelector('button[title="' + label + '"]');
      if (button) return (button.textContent || "").replace(/\s*✓$/, "").trim().replace(/\\/g, "/");
    }
    return null;
  };
  const same = (a, b) => a === b || a.endsWith("/" + b) || b.endsWith("/" + a);
  const visible = (node) => !!node && node.getClientRects().length > 0;
  const mark = (node) => {
    if (!node) return;
    const previous = node.style.backgroundColor;
    node.style.transition = "background-color 400ms ease-out";
    node.style.backgroundColor = "rgba(127, 127, 127, 0.22)";
    setTimeout(() => { node.style.backgroundColor = previous; }, ${MARK_MS});
  };
  const editor = () => {
    const content = document.querySelector(".cm-content");
    const view = content && content.cmTile && content.cmTile.root && content.cmTile.root.view;
    return view && visible(view.scrollDOM) ? view : null;
  };
  const inEditor = (view) => {
    const target = view.state.doc.line(Math.max(1, Math.min(line, view.state.doc.lines)));
    view.dispatch({ selection: { anchor: target.from }, scrollIntoView: true });
    requestAnimationFrame(() => {
      const coords = view.coordsAtPos(target.from);
      const frame = view.scrollDOM.getBoundingClientRect();
      if (coords) view.scrollDOM.scrollTop += coords.top - frame.top - frame.height / 3;
      requestAnimationFrame(() => {
        const at = view.domAtPos(target.from).node;
        const element = at && (at.nodeType === 1 ? at : at.parentElement);
        mark(element && element.closest(".cm-line"));
      });
    });
  };
  const inPreview = (blocks) => {
    let best = null;
    let next = null;
    for (const block of blocks) {
      const start = Number(block.dataset.sourceLine);
      const end = Math.max(start + 1, Number(block.dataset.sourceEnd) || start + 1);
      if (start <= line && line < end) {
        if (!best || end - start <= best.end - best.start) best = { block, start, end };
      } else if (start > line && (!next || start < next.start)) {
        next = { block, start, end };
      }
    }
    const target = (best || next || { block: blocks[blocks.length - 1] }).block;
    if (!target) return;
    target.scrollIntoView({ block: "center" });
    mark(target);
  };
  const deadline = Date.now() + ${REVEAL_LINE_TIMEOUT_MS};
  const attempt = () => {
    const current = shown();
    if (current && same(current, want)) {
      const view = editor();
      if (view && view.state.doc.length > 0) { inEditor(view); return; }
      const blocks = Array.from(document.querySelectorAll("[data-source-line]")).filter(visible);
      if (blocks.length) { inPreview(blocks); return; }
    }
    if (Date.now() < deadline) setTimeout(attempt, 100);
  };
  attempt();
})();`;
}

/** Move the file manager to `line` of `path` once it shows that file. */
export function revealFileLine(
  contents: Pick<WebContents, "executeJavaScript" | "isDestroyed">,
  path: string,
  line: number,
): void {
  if (contents.isDestroyed()) return;
  void contents.executeJavaScript(fileRevealLineScript(path, line)).catch((error) => {
    if (!contents.isDestroyed()) console.warn("File manager could not move to the line", error);
  });
}
