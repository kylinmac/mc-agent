// While the agent clicks or types in a plugin panel, links that input opens
// (window.open to an external app) are held back: the agent's approval covers
// the panel, not launching the user's browser or mail client. The tail covers
// the open request arriving just after the input itself completes.
const TAIL_MS = 1000;

type Gate = { until: number; blocked: string[] };
const gates = new WeakMap<object, Gate>();

export async function withAgentInput<T>(contents: object, run: () => Promise<T>): Promise<{ result: T; blocked: string[] }> {
  const gate: Gate = { until: Number.POSITIVE_INFINITY, blocked: [] };
  gates.set(contents, gate);
  try {
    return { result: await run(), blocked: gate.blocked };
  } finally {
    gate.until = Date.now() + TAIL_MS;
  }
}

/** True when the open request came from agent input and must not open. */
export function holdAgentOpen(contents: object, url: string): boolean {
  const gate = gates.get(contents);
  if (!gate || Date.now() > gate.until) return false;
  gate.blocked.push(url);
  return true;
}
