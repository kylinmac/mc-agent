import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";
import type { ExternalSessionSummary, ImportedUiMessage, SessionImporter } from "./types";
import { importedSessionId, toIso } from "./types";

const MAX_HISTORY_BYTES = 64 * 1024 * 1024;
type RecordValue = Record<string, unknown>;
function object(value: unknown): RecordValue {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as RecordValue : {};
}
function string(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}
function text(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value.map((part) => {
    const entry = object(part);
    if (entry.type === "text") return string(entry.text) ?? "";
    if (entry.type === "image" || entry.type === "image_url") return "[image]";
    return "";
  }).filter(Boolean).join("\n");
}

/** Read only regular files confined to the selected Grok session root. */
async function checkedFile(root: string, file: string, maxBytes: number): Promise<void> {
  const [base, actual, stat] = await Promise.all([fs.realpath(root), fs.realpath(file), fs.lstat(file)]);
  const relative = path.relative(base, actual);
  if (!relative || relative.startsWith(`..${path.sep}`) || relative === ".." || path.isAbsolute(relative)
    || !stat.isFile() || stat.isSymbolicLink() || stat.size > maxBytes) {
    throw new Error("GROK_IMPORT_INVALID_FILE");
  }
}

async function metadata(root: string, file: string): Promise<RecordValue> {
  await checkedFile(root, file, 1024 * 1024);
  const meta = object(JSON.parse(await fs.readFile(file, "utf8")));
  if (meta.chat_format_version !== 1) throw new Error("GROK_IMPORT_UNSUPPORTED_FORMAT");
  return meta;
}

async function readMessages(root: string, summary: ExternalSessionSummary): Promise<ImportedUiMessage[]> {
  await checkedFile(root, summary.filePath, MAX_HISTORY_BYTES);
  const stream = createReadStream(summary.filePath, { encoding: "utf8" });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  const messages: ImportedUiMessage[] = [];
  const calls = new Map<string, ImportedUiMessage>();
  let bytes = 0;
  try {
    for await (const line of lines) {
      bytes += Buffer.byteLength(line, "utf8") + 1;
      if (bytes > MAX_HISTORY_BYTES) throw new Error("GROK_IMPORT_HISTORY_TOO_LARGE");
      if (!line.trim()) continue;
      let row: RecordValue;
      try { row = object(JSON.parse(line)); }
      catch { throw new Error("GROK_IMPORT_INVALID_HISTORY"); }
      if (row.synthetic_reason) continue;
      const createdAt = toIso(string(row.timestamp), summary.createdAt);
      if (row.type === "user" || row.type === "assistant") {
        const content = text(row.content);
        if (content) messages.push({ id: randomUUID(), role: row.type, content, createdAt,
          ...(row.type === "assistant" ? { status: "complete" } : {}) });
        if (row.type === "assistant" && Array.isArray(row.tool_calls)) {
          for (const raw of row.tool_calls) {
            const call = object(raw);
            const id = string(call.id);
            if (!id) continue;
            let args = call.arguments;
            if (typeof args === "string") {
              try { args = JSON.parse(args); } catch { /* Preserve non-JSON tool input. */ }
            }
            const message: ImportedUiMessage = { id: randomUUID(), role: "tool", content: "",
              createdAt, toolCallId: id, toolName: string(call.name) ?? "tool", toolArgs: args,
              toolStatus: "interrupted", status: "complete" };
            calls.set(id, message);
            messages.push(message);
          }
        }
      } else if (row.type === "tool_result") {
        const id = string(row.tool_call_id);
        const content = [text(row.content), Array.isArray(row.images) && row.images.length ? "[image]" : ""]
          .filter(Boolean).join("\n");
        const call = id ? calls.get(id) : undefined;
        const isError = row.is_error === true;
        if (call) {
          Object.assign(call, { content, toolResult: content, toolStatus: isError ? "error" : "success", isError });
          calls.delete(id!);
        } else {
          messages.push({ id: randomUUID(), role: "tool", content, createdAt, toolCallId: id ?? undefined,
            toolName: "tool", toolResult: content, toolStatus: isError ? "error" : "success", isError, status: "complete" });
        }
      }
      // System injections, encrypted reasoning and backend-only events aren't portable messages.
    }
  } finally {
    lines.close();
    stream.destroy();
  }
  return messages;
}

export function createGrokImporter(root = path.join(os.homedir(), ".grok", "sessions")): SessionImporter {
  return {
    source: "grok",
    async scan() {
      let projects;
      try { projects = await fs.readdir(root, { withFileTypes: true }); }
      catch (error) {
        if (object(error).code === "ENOENT") return [];
        throw error;
      }
      const sessions: ExternalSessionSummary[] = [];
      for (const project of projects) {
        if (!project.isDirectory() || project.isSymbolicLink()) continue;
        const projectDir = path.join(root, project.name);
        let entries;
        try { entries = await fs.readdir(projectDir, { withFileTypes: true }); }
        catch { console.warn("[grok-import] Could not read a project directory"); continue; }
        for (const entry of entries) {
          if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
          const directory = path.join(projectDir, entry.name);
          try {
            const meta = await metadata(root, path.join(directory, "summary.json"));
            const info = object(meta.info);
            const externalId = string(info.id);
            if (!externalId || externalId !== entry.name) throw new Error("GROK_IMPORT_INVALID_ID");
            const filePath = path.join(directory, "chat_history.jsonl");
            await checkedFile(root, filePath, MAX_HISTORY_BYTES);
            const stat = await fs.stat(filePath);
            const createdAt = toIso(string(meta.created_at), stat.birthtime.toISOString());
            const summary: ExternalSessionSummary = {
              source: "grok", externalId,
              title: string(meta.generated_title) ?? string(meta.session_summary) ?? externalId,
              projectPath: string(info.cwd), model: string(meta.current_model_id), createdAt,
              updatedAt: toIso(string(meta.updated_at), stat.mtime.toISOString()),
              messageCount: null, filePath,
            };
            const messages = await readMessages(root, summary);
            if (!messages.length) continue;
            summary.messageCount = messages.length;
            sessions.push(summary);
          } catch {
            console.warn("[grok-import] Skipped an unreadable, invalid or unsupported session");
          }
        }
      }
      return sessions.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    },
    async convert(summary) {
      const meta = await metadata(root, path.join(path.dirname(summary.filePath), "summary.json"));
      if (summary.source !== "grok" || object(meta.info).id !== summary.externalId) {
        throw new Error("GROK_IMPORT_INVALID_ID");
      }
      const messages = await readMessages(root, summary);
      if (!messages.length) throw new Error("GROK_IMPORT_EMPTY_HISTORY");
      return { session: { id: importedSessionId("grok", summary.externalId), title: summary.title,
        projectPath: summary.projectPath, modelId: null, providerId: null, mode: "agent",
        createdAt: summary.createdAt, updatedAt: summary.updatedAt }, messages };
    },
  };
}

export const grokImporter = createGrokImporter();
