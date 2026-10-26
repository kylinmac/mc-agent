/*
  mc-agent: hold-to-talk for voice input (the `dictationHold` shortcut).

  Holding the shortcut records and releasing it transcribes into the
  draft, like push-to-talk in a game. Each visible voice-input button
  registers a target here; a press goes to the composer that has focus,
  otherwise to the one registered last. Releasing any key or leaving the
  window ends the hold. The shortcut is handled only while the app window is
  focused: a system-wide hold would need key-up events that Electron's global
  shortcuts do not report.
*/

import {
  KEYBOARD_SHORTCUTS,
  keybindingDisplayParts,
  resolveKeybinding,
  type KeybindingOverrides,
  type ShortcutPlatform,
} from "@pi-desktop/shared";

/** The hold shortcut as the user sees it, e.g. "⌘⇧Space"; empty when unbound. */
export function dictationHoldKeys(keybindings: KeybindingOverrides | undefined): string {
  const platform = ((typeof window === "undefined" ? undefined : window.piDesktop?.platform) ?? "darwin") as ShortcutPlatform;
  const shortcut = KEYBOARD_SHORTCUTS.find((candidate) => candidate.id === "dictationHold");
  if (!shortcut) return "";
  return keybindingDisplayParts(resolveKeybinding(shortcut, keybindings, platform), platform)
    .join(platform === "darwin" ? "" : "+");
}

export type DictationHoldTarget = {
  /** The element whose composer decides which target has focus. */
  element: () => HTMLElement | null;
  begin: () => void;
  end: () => void;
};

const targets: DictationHoldTarget[] = [];
let held: DictationHoldTarget | null = null;

export function registerDictationHoldTarget(target: DictationHoldTarget): () => void {
  targets.push(target);
  return () => {
    const index = targets.indexOf(target);
    if (index >= 0) targets.splice(index, 1);
    if (held === target) held = null;
  };
}

function focusedTarget(): DictationHoldTarget | null {
  const active = typeof document === "undefined" ? null : document.activeElement;
  const focused = targets.find((target) => {
    const dock = target.element()?.closest("[data-composer-dock]");
    return Boolean(dock && active && dock.contains(active));
  });
  return focused ?? targets.at(-1) ?? null;
}

function release() {
  window.removeEventListener("keyup", release, true);
  window.removeEventListener("blur", release);
  const target = held;
  held = null;
  target?.end();
}

/** Start a hold from the shortcut's key-down; false when no composer can take it. */
export function beginDictationHold(): boolean {
  if (held) return true;
  const target = focusedTarget();
  if (!target) return false;
  held = target;
  window.addEventListener("keyup", release, true);
  window.addEventListener("blur", release);
  target.begin();
  return true;
}
