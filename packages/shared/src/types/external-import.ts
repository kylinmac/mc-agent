import type { McpServerRecord, UserSkillRecord } from "./capabilities.js";

export interface ImportRunResult {
  imported: number;
  skipped: number;
  failed: number;
}

export interface ExternalImportSourceReport<Kind extends string> {
  kind: Kind;
  path: string;
  exists: boolean;
  error?: string;
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

export interface ExternalSkillCandidate extends ExternalSkillImportItem {
  description: string;
  bytes: number;
  warnings: string[];
}

export type ExternalSkillSourceReport = ExternalImportSourceReport<ExternalSkillSourceKind | "error">;
export type ExternalSkillScanResult = ExternalImportScanResult<ExternalSkillCandidate, ExternalSkillSourceKind | "error">;

export interface ExternalSkillImportItem {
  source: ExternalSkillSourceKind;
  sourcePath: string;
  shape: "file" | "dir";
  rootDir?: string;
  id: string;
  name: string;
  description?: string;
}

export interface ExternalSkillImportPayload {
  level: "global" | "project";
  projectPath?: string;
  mode?: "copy" | "link";
  items: ExternalSkillImportItem[];
}

export interface ExternalSkillImportRunResult {
  imported: Array<{ item: ExternalSkillImportItem; skill: UserSkillRecord }>;
  skipped: Array<{ item: ExternalSkillImportItem; reason: string }>;
  failed: Array<{ item: ExternalSkillImportItem; error: string }>;
}

export type ExternalMcpSourceKind =
  | "claude-desktop"
  | "claude-code"
  | "cursor-global"
  | "cursor-project"
  | "codex"
  | "opencode"
  | "chatgpt-desktop";

export interface ExternalMcpCandidate {
  source: ExternalMcpSourceKind;
  sourcePath: string;
  id: string;
  rawKey: string;
  label?: string;
  description?: string;
  transport: "stdio" | "http";
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  disabled?: boolean;
  warnings: string[];
}

export type ExternalMcpSourceReport = ExternalImportSourceReport<ExternalMcpSourceKind | "error">;
export type ExternalMcpScanResult = ExternalImportScanResult<ExternalMcpCandidate, ExternalMcpSourceKind | "error">;

export type ExternalMcpImportItem = Omit<ExternalMcpCandidate, "warnings">;

export interface ExternalMcpImportPayload {
  /** Defaults to global for existing callers. */
  level?: "global" | "project";
  projectPath?: string;
  items: ExternalMcpImportItem[];
}

export interface ExternalMcpImportRunResult {
  imported: Array<{ item: ExternalMcpImportItem; server: McpServerRecord }>;
  skipped: Array<{ item: ExternalMcpImportItem; reason: string }>;
  failed: Array<{ item: ExternalMcpImportItem; error: string }>;
}
