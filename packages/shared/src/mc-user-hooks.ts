/**
 * mc-agent (MC-ADR-0021): shell commands the user configures to run at fixed
 * points of a turn. Stored by Electron main, passed to each session runtime.
 */
export const MC_USER_HOOK_EVENTS = ["PreToolUse", "PostToolUse", "Stop"] as const;
export type McUserHookEvent = (typeof MC_USER_HOOK_EVENTS)[number];

export type McUserHook = {
  id: string;
  event: McUserHookEvent;
  /** Regular expression over the whole tool name; empty or `*` matches every tool. Ignored for `Stop`. */
  matcher?: string;
  command: string;
  timeoutSeconds?: number;
  enabled?: boolean;
};

export const MC_USER_HOOKS_MAX = 50;
const COMMAND_MAX = 4_000;
const MATCHER_MAX = 200;

/** A valid hook list from untrusted input; invalid entries are dropped. */
export function normalizeMcUserHooks(value: unknown): McUserHook[] {
  if (!Array.isArray(value)) return [];
  const hooks: McUserHook[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== "object") continue;
    const item = raw as Record<string, unknown>;
    const event = MC_USER_HOOK_EVENTS.find((name) => name === item.event);
    const command = typeof item.command === "string" ? item.command.trim() : "";
    const id = typeof item.id === "string" && item.id.trim() ? item.id.trim() : "";
    if (!event || !command || !id || command.length > COMMAND_MAX) continue;
    const matcher = typeof item.matcher === "string" ? item.matcher.trim() : "";
    if (matcher.length > MATCHER_MAX) continue;
    const timeout = typeof item.timeoutSeconds === "number" && Number.isFinite(item.timeoutSeconds)
      ? Math.min(600, Math.max(1, Math.round(item.timeoutSeconds)))
      : undefined;
    hooks.push({
      id,
      event,
      ...(matcher ? { matcher } : {}),
      command,
      ...(timeout ? { timeoutSeconds: timeout } : {}),
      ...(item.enabled === false ? { enabled: false } : {}),
    });
    if (hooks.length >= MC_USER_HOOKS_MAX) break;
  }
  return hooks;
}

/** Whether a matcher compiles; the settings page refuses one that does not. */
export function isValidHookMatcher(matcher: string): boolean {
  if (!matcher.trim() || matcher.trim() === "*") return true;
  try {
    new RegExp(`^(?:${matcher.trim()})$`);
    return true;
  } catch {
    return false;
  }
}
