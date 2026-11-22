/** Shared public types grouped by the owning application domain. */
export const SESSION_MODES = ["agent", "plan", "goal"] as const;
export type Mode = (typeof SESSION_MODES)[number];

/** Normalize mode values at compatibility boundaries. Older persisted and
 * scheduled data used `chat`; it is now the Plan operating state. */
export function normalizeMode(value: unknown, fallback: Mode = "agent"): Mode {
  if (value === "agent") return "agent";
  if (value === "goal") return "goal";
  if (value === "plan" || value === "chat") return "plan";
  return fallback;
}
