import type { ImportCandidate, ImportSource } from "../../lib/api";

/*
  mc-agent: importing projects and their conversations from other agents
  (MC-ADR-0009). The dialog lists every conversation the scan found, grouped
  by the project folder it belongs to; whole projects or single conversations
  can be picked, or everything at once.
*/

/** Sources this dialog offers, in display order. */
export const IMPORT_SOURCES: readonly ImportSource[] = ["claude-code", "codex", "pi-desktop", "grok"];

export const SOURCE_LABELS: Record<ImportSource, string> = {
  "claude-code": "Claude Code",
  codex: "Codex",
  "pi-desktop": "PI-Desktop",
  grok: "Grok",
  opencode: "OpenCode",
  pi: "Pi",
};

export type ImportGroup = {
  /** The project folder, or "" for conversations outside any project. */
  key: string;
  path: string | null;
  name: string;
  items: ImportCandidate[];
  sources: ImportSource[];
  latest: string;
};

export function candidateKey(candidate: Pick<ImportCandidate, "source" | "externalId">): string {
  return `${candidate.source}:${candidate.externalId}`;
}

/** The session id host-core gives an imported conversation (stable across imports). */
export function importedSessionId(candidate: Pick<ImportCandidate, "source" | "externalId">): string {
  if (candidate.source === "codex") return `import-codex-v2-${candidate.externalId}`;
  return `import-${candidate.source}-${candidate.externalId}`;
}

function folderName(path: string): string {
  const parts = path.replace(/[\\/]+$/, "").split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

function normalizedPath(path: string | null): string {
  return (path ?? "").trim().replace(/[\\/]+$/, "");
}

/** Projects newest first; conversations without a project last. */
export function groupByProject(candidates: readonly ImportCandidate[]): ImportGroup[] {
  const groups = new Map<string, ImportGroup>();
  for (const candidate of candidates) {
    const key = normalizedPath(candidate.projectPath);
    let group = groups.get(key);
    if (!group) {
      group = { key, path: key || null, name: key ? folderName(key) : "", items: [], sources: [], latest: "" };
      groups.set(key, group);
    }
    group.items.push(candidate);
    if (!group.sources.includes(candidate.source)) group.sources.push(candidate.source);
    if (candidate.updatedAt > group.latest) group.latest = candidate.updatedAt;
  }
  for (const group of groups.values()) {
    group.items.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    group.sources.sort((a, b) => IMPORT_SOURCES.indexOf(a) - IMPORT_SOURCES.indexOf(b));
  }
  return [...groups.values()].sort((a, b) => {
    if (Boolean(a.path) !== Boolean(b.path)) return a.path ? -1 : 1;
    return b.latest.localeCompare(a.latest) || a.name.localeCompare(b.name);
  });
}

export type ImportFilter = { source: ImportSource | "all"; query: string };

export function filterCandidates(candidates: readonly ImportCandidate[], filter: ImportFilter): ImportCandidate[] {
  const query = filter.query.trim().toLowerCase();
  return candidates.filter(
    (candidate) =>
      IMPORT_SOURCES.includes(candidate.source) &&
      (filter.source === "all" || candidate.source === filter.source) &&
      (!query ||
        candidate.title.toLowerCase().includes(query) ||
        (candidate.projectPath ?? "").toLowerCase().includes(query)),
  );
}

/** Whether a set of conversations is fully, partly or not picked; imported ones do not count. */
export function selectionState(
  items: readonly ImportCandidate[],
  selected: ReadonlySet<string>,
  imported: ReadonlySet<string>,
): "all" | "some" | "none" {
  const pickable = items.filter((item) => !imported.has(importedSessionId(item)));
  const picked = pickable.filter((item) => selected.has(candidateKey(item))).length;
  if (picked === 0) return "none";
  return picked === pickable.length ? "all" : "some";
}

/** Picks every pickable item, or clears them all when they are all picked already. */
export function toggleItems(
  items: readonly ImportCandidate[],
  selected: ReadonlySet<string>,
  imported: ReadonlySet<string>,
): Set<string> {
  const next = new Set(selected);
  const pickable = items.filter((item) => !imported.has(importedSessionId(item)));
  const allPicked = pickable.length > 0 && pickable.every((item) => next.has(candidateKey(item)));
  for (const item of pickable) {
    if (allPicked) next.delete(candidateKey(item));
    else next.add(candidateKey(item));
  }
  return next;
}

/** How many conversations and distinct projects a selection covers. */
export function selectionSummary(
  candidates: readonly ImportCandidate[],
  selected: ReadonlySet<string>,
): { sessions: number; projects: number } {
  const chosen = candidates.filter((candidate) => selected.has(candidateKey(candidate)));
  const projects = new Set(chosen.map((candidate) => normalizedPath(candidate.projectPath)).filter(Boolean));
  return { sessions: chosen.length, projects: projects.size };
}
