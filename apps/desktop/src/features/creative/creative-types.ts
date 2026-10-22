/*
  mc-agent creative studio records. The transport shapes live in
  @pi-desktop/shared (types/creative.ts) so host-core, Main and the renderer
  read the same ones; this module keeps the names the studio imports.
*/
import type { CreativeJobStatus } from "@pi-desktop/shared";

export type {
  CreativeAsset,
  CreativeAssetFilter,
  CreativeCategory,
  CreativeComparison,
  CreativeJob,
  CreativeJobResult,
  CreativeJobStatus,
  CreativeLinks,
  CreativeOrigin,
  CreativeReferenceUse,
  CreativeRole,
  CreativeSnapshot,
  CreativeStorage,
} from "@pi-desktop/shared";

export const FINAL_JOB_STATUSES: readonly CreativeJobStatus[] = [
  "done",
  "partial",
  "failed",
  "cancelled",
  "interrupted",
];
