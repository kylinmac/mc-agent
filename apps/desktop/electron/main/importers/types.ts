import { redactValue } from "../logger";

import type { SessionImportCandidate, SessionImportSource } from "@pi-desktop/shared";

export type ExternalSource = SessionImportSource;
export { importedSessionId } from "@pi-desktop/shared";

export interface ExternalSessionSummary extends SessionImportCandidate {
  filePath: string;
  /** Main-process-only ordered segments; never supplied by the renderer. */
  filePaths?: string[];
  /** Main-process-only: Codex thread history database holding this thread's turns. */
  historyDb?: string;
}

export interface ImportedUiMessage {
  id: string;
  role: string;
  content: string;
  createdAt: string;
  status?: string;
  toolName?: string;
  toolCallId?: string;
  toolStatus?: string;
  toolArgs?: unknown;
  toolResult?: unknown;
  isError?: boolean;
}

export interface ImportedSession {
  session: {
    id: string;
    title: string;
    projectPath: string | null;
    modelId: string | null;
    providerId: string | null;
    mode: string;
    createdAt: string;
    updatedAt: string;
  };
  messages: ImportedUiMessage[];
}

export interface SessionImporter {
  source: ExternalSource;
  scan(): Promise<ExternalSessionSummary[]>;
  convert(summary: ExternalSessionSummary): Promise<ImportedSession>;
}

export function toIso(value: string | number | undefined | null, fallback?: string): string {
  if (value !== undefined && value !== null) {
    const d = new Date(value);
    if (!Number.isNaN(d.getTime())) return d.toISOString();
    // A provided-but-invalid timestamp is data corruption (truncated jsonl,
    // out-of-range numbers): surface it instead of silently rewriting the
    // session's history to the import moment (#265). Absent values stay
    // silent — those are normal in optional fields.
    console.warn(
      `[app/persistence] ${JSON.stringify({
        ts: new Date().toISOString(),
        level: "warn",
        channel: "app",
        category: "persistence",
        event: "session.import.invalid_timestamp",
        message: "session import timestamp invalid",
        data: redactValue({
          fallback: fallback ? "provided" : "import-time",
          value: String(value),
        }),
      })}`,
    );
  }
  return fallback ?? new Date().toISOString();
}

export function truncateTitle(text: string, max = 48): string {
  const t = text.replace(/\s+/g, " ").trim();
  if (!t) return "";
  return t.length > max ? `${t.slice(0, max)}…` : t;
}
