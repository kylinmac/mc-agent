import fs from "node:fs/promises";
import path from "node:path";
import type { ExternalSessionSummary } from "./types";

/** session_index is an append-only title index; the last entry for an id wins. */
export async function readCodexTitles(sessionsDir: string): Promise<Map<string, string>> {
  const titles = new Map<string, string>();
  const file = path.join(sessionsDir, "..", "session_index.jsonl");
  try {
    if ((await fs.stat(file)).size > 16 * 1024 * 1024) {
      console.warn("[codex-import] Title index exceeds the read limit");
      return titles;
    }
    for (const line of (await fs.readFile(file, "utf8")).split("\n")) {
      if (!line.trim()) continue;
      try {
        const row: unknown = JSON.parse(line);
        if (!row || typeof row !== "object") continue;
        const id = Reflect.get(row, "id");
        const title = Reflect.get(row, "thread_name");
        if (typeof id === "string" && typeof title === "string" && title.trim()) titles.set(id, title.trim());
      } catch { /* A partially written final index row must not hide earlier titles. */ }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") console.warn("[codex-import] Could not read title index");
  }
  return titles;
}

export function groupCodexSegments(segments: ExternalSessionSummary[], titles: ReadonlyMap<string, string>) {
  const groups = new Map<string, ExternalSessionSummary>();
  for (const segment of [...segments].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.filePath.localeCompare(b.filePath))) {
    const previous = groups.get(segment.externalId);
    if (!previous) {
      groups.set(segment.externalId, { ...segment, filePaths: [segment.filePath] });
      continue;
    }
    previous.filePaths!.push(segment.filePath);
    if (!previous.title) previous.title = segment.title;
    if (segment.updatedAt > previous.updatedAt) {
      previous.updatedAt = segment.updatedAt;
      previous.projectPath = segment.projectPath ?? previous.projectPath;
    }
    // Segments may replay earlier records, so adding their item counts is misleading.
    previous.messageCount = null;
  }
  return [...groups.values()].filter((session) => session.title || titles.has(session.externalId)).map((session) => ({
    ...session, title: titles.get(session.externalId) ?? session.title,
  })).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

/** Remove replayed timestamped records between segments, never repetitions within one file. */
export function mergeCodexRecords<T extends { timestamp: string | null }>(segments: T[][]): T[] {
  const previousCounts = new Map<string, number>();
  const result: T[] = [];
  for (const segment of segments) {
    const counts = new Map<string, number>();
    for (const record of segment) {
      if (!record.timestamp) { result.push(record); continue; }
      const key = JSON.stringify(record);
      const count = (counts.get(key) ?? 0) + 1;
      counts.set(key, count);
      if (count > (previousCounts.get(key) ?? 0)) result.push(record);
    }
    for (const [key, count] of counts) previousCounts.set(key, Math.max(count, previousCounts.get(key) ?? 0));
  }
  return result;
}
