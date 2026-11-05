import { Terminal } from "@xterm/xterm";
import { terminalCopyKeyHandler } from "../../apps/desktop/src/features/work-tools/terminal-clipboard";

Object.assign(window, { testTerminalShortcuts: async () => {
  const term = new Terminal({ cols: 80, rows: 10 });
  term.open(document.getElementById("terminal")!);
  const copied: string[] = [];
  const input: string[] = [];
  term.onData(value => input.push(value));
  term.attachCustomKeyEventHandler(terminalCopyKeyHandler(() => term.getSelection(), async value => { copied.push(value); }, error => { throw error; }));
  await new Promise<void>(resolve => term.write("error 中文", resolve));
  term.selectAll();
  const key = (ctrl: boolean, shift: boolean) => term.textarea!.dispatchEvent(new KeyboardEvent("keydown", { key: "c", keyCode: 67, ctrlKey: ctrl, shiftKey: shift, bubbles: true, cancelable: true }));
  key(true, true); key(true, false);
  term.clearSelection(); key(true, false);
  const data = new DataTransfer(); data.setData("text/plain", "paste fixture");
  term.textarea!.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
  await Promise.resolve();
  term.dispose();
  return { copied, input };
} });
