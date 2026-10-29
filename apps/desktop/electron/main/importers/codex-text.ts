/** Delimiter Codex places between injected IDE context and the user's request. */
const CODEX_REQUEST_MARKER = "## My request for Codex:";

/** The request a Codex user message carries, without the context Codex wraps around it. */
export function userRequestText(text: string): string {
  // The desktop app and IDE extension serialize IDE context (active file,
  // open tabs, selections, in-app browser, ...) into the same user message,
  // ending with this marker and then the real request. Codex itself replays
  // the text after the LAST marker, so do the same; otherwise the whole turn
  // looked synthetic and a session whose every turn carried IDE context
  // vanished from the scan.
  const marker = text.lastIndexOf(CODEX_REQUEST_MARKER);
  if (marker !== -1) return text.slice(marker + CODEX_REQUEST_MARKER.length).trim();
  // Attachment wrappers also contain the user's actual request; don't discard that turn.
  if (text.startsWith("# Files mentioned by the user:")) {
    const request = text.match(/(?:^|\n)## My request:\s*([\s\S]*)$/);
    if (request) return request[1].trim();
  }
  return text;
}

// Codex prepends synthetic user messages carrying repo instructions, IDE
// context, and tooling state, so the first real user message (the scan title)
// must skip them. The list is evidence-driven from real archives (#265):
// newer Codex builds inject an IDE-context family alongside the original
// AGENTS.md block. Real user messages can legitimately start with "# "
// (pasted markdown such as "# Role: …"), so matching stays on the exact
// evidenced prefixes instead of a blanket "#" rule — extend the list when a
// new injection shows up, one archive sample at a time.
const SYNTHETIC_USER_PREFIXES = [
  "<",
  "# AGENTS.md",
  "# Context from my IDE setup",
  "# In app browser:",
  "# Browser comments:",
  "# Files mentioned by the user:",
  "# Diff comments:",
  "# Selected text:",
  "# Review findings:",
  "You are Codex",
];

export function isSyntheticUserText(text: string): boolean {
  return SYNTHETIC_USER_PREFIXES.some((prefix) => text.startsWith(prefix));
}
