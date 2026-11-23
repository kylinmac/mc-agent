import type { SessionSummary } from "@pi-desktop/shared";
import type { ProjectMeta } from "../../lib/sidebar-preferences";
export type ProjectEntry = {
  path: string;
  displayPath?: string;
  key: string;
  name: string;
  sessions: SessionSummary[];
  open: boolean;
  active: boolean;
  meta: ProjectMeta;
  /** Best-effort git branch from the project workspace, if known. */
  branch?: string;
  /** mc-agent: every folder of the merged project group, normalized. */
  memberKeys?: string[];
};
