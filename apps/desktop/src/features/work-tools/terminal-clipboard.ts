/** xterm selection is not a DOM selection; copy it before the shell sees C. */
export function terminalCopyKeyHandler(
  selection: () => string,
  write: (text: string) => Promise<void>,
  failed: (error: unknown) => void,
  actions?: { selectAll: () => void; clear: () => void; scrollPages: (pages: number) => void; scrollToTop: () => void; scrollToBottom: () => void },
): (event: KeyboardEvent) => boolean {
  return (event) => {
    const key = event.key.toLowerCase();
    if (actions && !event.altKey) {
      let action: (() => void) | undefined;
      if (event.ctrlKey && event.shiftKey && key === "a") action = actions.selectAll;
      if (((event.ctrlKey && event.shiftKey) || event.metaKey) && key === "k") action = actions.clear;
      if (event.shiftKey && !event.ctrlKey && !event.metaKey) {
        if (key === "pageup") action = () => actions.scrollPages(-1);
        if (key === "pagedown") action = () => actions.scrollPages(1);
        if (key === "home") action = actions.scrollToTop;
        if (key === "end") action = actions.scrollToBottom;
      }
      if (action) {
        event.preventDefault(); event.stopPropagation();
        if (event.type === "keydown") action();
        return false;
      }
    }
    // Leave native paste to xterm: it handles bracketed paste and multi-line input.
    if (event.key.toLowerCase() !== "c" || event.altKey) return true;
    const explicitCopy = (event.ctrlKey && event.shiftKey) || event.metaKey;
    const text = selection();
    if (!explicitCopy && !(event.ctrlKey && text)) return true;
    event.preventDefault();
    event.stopPropagation();
    if (event.type === "keydown" && text) void write(text).catch(failed);
    return false;
  };
}
