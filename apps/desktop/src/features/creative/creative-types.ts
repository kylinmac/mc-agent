/*
  mc-agent creative studio records, as host-core returns them
  (crates/host-core/src/mc_creative.rs).
*/

export type CreativeOrigin = "reference" | "model" | "code" | "import";
export type CreativeRole = "reference" | "edit" | "style";

export type CreativeAsset = {
  id: string;
  groupId: string;
  origin: CreativeOrigin;
  kind: string;
  path: string;
  sha256: string;
  mime?: string | null;
  width?: number | null;
  height?: number | null;
  bytes: number;
  title: string;
  favorite: boolean;
  jobId?: string | null;
  resultIndex?: number | null;
  createdAt: number;
  removedAt?: number | null;
  /** Category folder, e.g. `角色/角色A`; empty for uncategorized. */
  category: string;
  fileExists: boolean;
};

export type CreativeCategory = { path: string; count: number };

export type CreativeJobStatus =
  | "pending"
  | "running"
  | "saving"
  | "done"
  | "partial"
  | "failed"
  | "cancelled"
  | "interrupted";

export type CreativeJobResult = {
  index: number;
  status: string;
  path?: string | null;
  assetId?: string | null;
  error?: string | null;
};

export type CreativeReferenceUse = { assetId: string; role: CreativeRole };

export type CreativeSnapshot = {
  prompt?: string;
  params?: Record<string, unknown>;
  references?: CreativeReferenceUse[];
  providerId?: string;
  modelId?: string;
  /** Code drawings: the command and the kept script. */
  command?: string;
  script?: { source: string; kept: string; sha256: string };
};

export type CreativeJob = {
  id: string;
  groupId: string;
  entry: "chat" | "form" | "code";
  sessionId?: string | null;
  providerId?: string | null;
  modelId?: string | null;
  snapshot: CreativeSnapshot;
  status: CreativeJobStatus;
  error?: string | null;
  createdAt: number;
  updatedAt: number;
  endedAt?: number | null;
  results: CreativeJobResult[];
};

export type CreativeLinks = {
  uses: Array<{ assetId: string; position: number; role: CreativeRole }>;
  usedBy: Array<{ assetId: string; position: number; role: CreativeRole }>;
};

export type CreativeComparison = {
  id: string;
  groupId: string;
  title: string;
  note: string;
  chosen?: string | null;
  assetIds: string[];
  createdAt: number;
  updatedAt: number;
};

export type CreativeAssetFilter = {
  origin?: CreativeOrigin;
  favorite?: boolean;
  includeRemoved?: boolean;
  query?: string;
};

export const FINAL_JOB_STATUSES: readonly CreativeJobStatus[] = [
  "done",
  "partial",
  "failed",
  "cancelled",
  "interrupted",
];
