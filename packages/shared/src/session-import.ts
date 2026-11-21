export const SESSION_IMPORT_SOURCES = [
  "claude-code", "opencode", "codex", "pi", "pi-desktop", "grok", "hermes",
] as const;

export type SessionImportSource = (typeof SESSION_IMPORT_SOURCES)[number];

export interface SessionImportSelection {
  source: SessionImportSource;
  externalId: string;
}

export interface SessionImportCandidate extends SessionImportSelection {
  title: string;
  projectPath: string | null;
  model: string | null;
  createdAt: string;
  updatedAt: string;
  /** Null for large source files whose message count was sampled. */
  messageCount: number | null;
}

export interface SessionImportScanResult {
  sessions: SessionImportCandidate[];
  truncated?: Partial<Record<SessionImportSource, number>>;
}

export function sessionImportKey({ source, externalId }: SessionImportSelection): string {
  return `${source}:${externalId}`;
}

/** Codex and Claude use v2 IDs so the more complete conversion can coexist with older imports. */
export function importedSessionId(source: SessionImportSource, externalId: string): string {
  if (source === "codex" || source === "claude-code") return `import-${source}-v2-${externalId}`;
  return `import-${source}-${externalId}`;
}
