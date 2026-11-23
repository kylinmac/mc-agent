export interface ImportRunResult {
  imported: number;
  skipped: number;
  failed: number;
}

/** Safe public diagnostics. Parser, filesystem and host messages can contain credentials. */
export const externalImportScanErrors = [
  "invalid-json", "invalid-format", "permission-denied", "source-unreadable", "skill-too-large", "scan-failed",
] as const;
export type ExternalImportScanError = (typeof externalImportScanErrors)[number];
export type ExternalImportWriteError =
  | "stale-selection" | "invalid-mcp" | "invalid-skill" | "invalid-destination"
  | "permission-denied" | "host-unavailable" | "source-missing" | "import-failed";

export interface ExternalImportSourceReport<Kind extends string> {
  kind: Kind;
  path: string;
  exists: boolean;
  error?: ExternalImportScanError;
  count: number;
}

export interface ExternalImportScanResult<Candidate, Kind extends string> {
  candidates: Candidate[];
  sources: ExternalImportSourceReport<Kind>[];
}

export type ExternalSkillSourceKind =
  | "claude-user"
  | "claude-project"
  | "pi-user"
  | "pi-project";

/** Identifies one row in the scan shown to the user. Main owns the execution input. */
export interface ExternalImportSelection {
  selectionId: string;
}

export interface ExternalSkillCandidate extends ExternalImportSelection {
  source: ExternalSkillSourceKind;
  sourcePath: string;
  shape: "file" | "dir";
  id: string;
  name: string;
  description: string;
}

export type ExternalSkillSourceReport = ExternalImportSourceReport<ExternalSkillSourceKind | "error">;
export type ExternalSkillScanResult = ExternalImportScanResult<ExternalSkillCandidate, ExternalSkillSourceKind | "error">;
export type ExternalSkillImportItem = ExternalImportSelection;

export interface ExternalSkillImportPayload {
  level: "global" | "project";
  projectPath?: string;
  mode?: "copy" | "link";
  items: ExternalSkillImportItem[];
}

export interface ExternalImportBatchResult {
  imported: Array<{ item: ExternalImportSelection }>;
  skipped: Array<{ item: ExternalImportSelection; reason: "exists" }>;
  /** requestIndex identifies a submitted row even when Main cannot authenticate its selectionId. */
  failed: Array<{ item: ExternalImportSelection; requestIndex: number; error: ExternalImportWriteError }>;
}

export type ExternalSkillImportRunResult = ExternalImportBatchResult;

export type ExternalMcpSourceKind =
  | "claude-desktop"
  | "claude-code"
  | "cursor-global"
  | "cursor-project"
  | "codex"
  | "opencode"
  | "chatgpt-desktop";

export interface ExternalMcpCandidate extends ExternalImportSelection {
  source: ExternalMcpSourceKind;
  sourcePath: string;
  id: string;
  label?: string;
  displayMeta: string;
  transport: "stdio" | "http";
}

export type ExternalMcpSourceReport = ExternalImportSourceReport<ExternalMcpSourceKind | "error">;
export type ExternalMcpScanResult = ExternalImportScanResult<ExternalMcpCandidate, ExternalMcpSourceKind | "error">;

export type ExternalMcpImportItem = ExternalImportSelection;

export interface ExternalMcpImportPayload {
  /** Defaults to global for existing callers. */
  level?: "global" | "project";
  projectPath?: string;
  items: ExternalMcpImportItem[];
}

export type ExternalMcpImportRunResult = ExternalImportBatchResult;
