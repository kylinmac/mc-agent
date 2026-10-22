/*
  mc-agent: sessions shown live somewhere other than the main chat pane (a
  split-view column, the creative studio's chat). A held session keeps its
  retained pane past the ADR 0137 bound and streams while it is not the active
  session. Each surface declares what it shows and releases it when done:
  explicit holds are counted, so two surfaces showing the same session do not
  release each other; a surface whose list lives in its own store (the split
  view's columns) registers a source instead.
*/

const holds = new Map<string, number>();
const sources = new Set<() => readonly string[]>();

/** Keep `sessionId` live until the returned release is called (once). */
export function holdSession(sessionId: string): () => void {
  if (!sessionId) return () => undefined;
  holds.set(sessionId, (holds.get(sessionId) ?? 0) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const count = (holds.get(sessionId) ?? 1) - 1;
    if (count > 0) holds.set(sessionId, count);
    else holds.delete(sessionId);
  };
}

/** A surface's own list of shown sessions, read on demand. */
export function registerSessionHoldSource(source: () => readonly string[]): () => void {
  sources.add(source);
  return () => {
    sources.delete(source);
  };
}

/** Every held session, explicit holds first, without duplicates or "". */
export function heldSessionIds(): readonly string[] {
  const ids = new Set(holds.keys());
  for (const source of sources) for (const id of source()) if (id) ids.add(id);
  return [...ids];
}

export function isSessionHeld(sessionId: string): boolean {
  if (holds.has(sessionId)) return true;
  for (const source of sources) if (source().includes(sessionId)) return true;
  return false;
}
