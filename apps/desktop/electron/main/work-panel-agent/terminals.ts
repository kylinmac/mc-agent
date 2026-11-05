import type { TerminalManager } from "../mc-terminal";
let manager: TerminalManager | undefined;
export function setPanelTerminalManager(value: TerminalManager) { manager = value; }
export function panelTerminals(): TerminalManager {
  if (!manager) throw new Error("Terminal manager unavailable");
  return manager;
}
