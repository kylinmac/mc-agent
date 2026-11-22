import { randomUUID } from "node:crypto";
import type {
  ExternalImportBatchResult,
  ExternalImportScanResult,
  ExternalImportSelection,
} from "@pi-desktop/shared";

// Settings can stay open for the life of the app. Release old projects' private inputs.
const MAX_PROJECT_SCANS = 32;

/** The latest requested scan owns each destination. A running import holds its original map. */
export function externalImportScans<Private, Public, Source extends string>(
  scan: (options: { projectPath?: string }) => Promise<ExternalImportScanResult<Private, Source>>,
  preview: (candidate: Private, selectionId: string) => Public,
) {
  const byProject = new Map<string, Map<string, Private>>();
  return {
    async scan(
      { projectPath }: { projectPath?: string } = {},
    ): Promise<ExternalImportScanResult<Public, Source | "error">> {
      const key = projectPath ?? "";
      const candidates = new Map<string, Private>();
      byProject.delete(key);
      if (byProject.size >= MAX_PROJECT_SCANS) {
        const oldest = byProject.keys().next().value;
        if (oldest !== undefined) byProject.delete(oldest);
      }
      byProject.set(key, candidates);
      try {
        const result = await scan({ projectPath });
        if (byProject.get(key) !== candidates) return { candidates: [], sources: [] };
        return {
          candidates: result.candidates.map((candidate) => {
            const selectionId = randomUUID();
            candidates.set(selectionId, candidate);
            return preview(candidate, selectionId);
          }),
          sources: result.sources.map(({ kind, path, exists, count, error }) => ({
            kind, path, exists, count,
            ...(error ? { error: "Source could not be read" } : {}),
          })),
        };
      } catch {
        return {
          candidates: [],
          sources: [{ kind: "error", path: "", exists: false, count: 0, error: "Scan failed" }],
        };
      }
    },
    forDestination(level: "global" | "project" = "global", projectPath?: string) {
      if (level === "global") return byProject.get("");
      if (level === "project" && projectPath) return byProject.get(projectPath);
      return undefined;
    },
  };
}

export async function importSelections<T>(
  items: readonly ExternalImportSelection[],
  candidates: ReadonlyMap<string, T> | undefined,
  save: (candidate: T) => Promise<unknown>,
): Promise<ExternalImportBatchResult> {
  const result: ExternalImportBatchResult = { imported: [], skipped: [], failed: [] };
  for (const selection of items) {
    const item = { selectionId: typeof selection?.selectionId === "string" ? selection.selectionId : "" };
    const candidate = candidates?.get(item.selectionId);
    if (!candidate) {
      result.failed.push({ item: { selectionId: "" }, error: "stale-selection" });
      continue;
    }
    try {
      await save(candidate);
      result.imported.push({ item });
    } catch (error) {
      if (error instanceof Error && /already exists/i.test(error.message)) {
        result.skipped.push({ item, reason: "exists" });
      } else {
        result.failed.push({ item, error: "import-failed" });
      }
    }
  }
  return result;
}
