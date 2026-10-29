import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { ExternalSessionSummary, ImportedUiMessage } from "./types";
import { toIso, truncateTitle } from "./types";
import { isSyntheticUserText, userRequestText } from "./codex-text";

/*
 * Newer Codex builds (CLI, IDE extension, the ChatGPT desktop app's Codex)
 * keep their thread list in `$CODEX_HOME/state_<n>.sqlite` (table `threads`)
 * and the turns in `$CODEX_HOME/thread_history_<n>.sqlite` (table
 * `thread_items`). A one-time "legacy_to_paginated" migration copies old
 * rollout `.jsonl` files into that history and then deletes them, so most of
 * a long-time user's threads only exist here. Both files are opened read-only.
 */

type Row = Record<string, unknown>;
type Db = {
  prepare(sql: string): { all(...params: unknown[]): unknown[] };
  close(): void;
};

const MAX_DB_BYTES = 16 * 1024 * 1024 * 1024;
/** Threads the user started; `exec`, guardian reviews and sub-agents are not conversations. */
const USER_SOURCES = ["cli", "vscode"];
const THREAD_REQUIRED = ["id", "rollout_path", "cwd", "created_at", "updated_at", "source"];
const THREAD_OPTIONAL = [
  "name", "title", "first_user_message", "preview", "created_at_ms", "updated_at_ms", "model",
  "attached_thread_parent_id",
];
const ITEM_REQUIRED = ["thread_id", "rollout_ordinal", "created_at_ms", "item_json", "item_type"];

function str(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}
function num(value: unknown): number | null {
  if (typeof value === "bigint") return Number(value);
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
function obj(value: unknown): Row {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Row : {};
}

/** The highest-versioned `<prefix>_<n>.sqlite` in the Codex home, or null. */
export async function codexStoreFile(home: string, prefix: string): Promise<string | null> {
  let entries: string[];
  try {
    entries = await fs.readdir(home);
  } catch {
    return null;
  }
  const pattern = new RegExp(`^${prefix}_(\\d+)\\.sqlite$`);
  let best: { file: string; version: number } | null = null;
  for (const entry of entries) {
    const match = pattern.exec(entry);
    if (match && (!best || Number(match[1]) > best.version)) best = { file: entry, version: Number(match[1]) };
  }
  return best ? path.join(home, best.file) : null;
}

async function openDb(dbPath: string): Promise<Db> {
  const stat = await fs.lstat(dbPath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_DB_BYTES) {
    throw new Error("CODEX_IMPORT_INVALID_FILE");
  }
  const { DatabaseSync } = await import("node:sqlite");
  return new DatabaseSync(dbPath, { readOnly: true }) as unknown as Db;
}

function selectList(db: Db, table: string, required: string[], optional: string[]): string | null {
  const present = new Set((db.prepare(`PRAGMA table_info(${table})`).all() as Row[]).map((row) => String(row.name)));
  if (required.some((column) => !present.has(column))) return null;
  return [...required, ...optional]
    .map((column) => (present.has(column) ? `"${column}"` : `NULL AS "${column}"`))
    .join(", ");
}

function msTime(ms: unknown, seconds: unknown): number | null {
  return num(ms) ?? (num(seconds) === null ? null : num(seconds)! * 1000);
}

function userText(item: Row): string {
  const parts = Array.isArray(item.content) ? item.content : [];
  const text = parts
    .map((part) => obj(part))
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text as string)
    .join("\n")
    .trim();
  return userRequestText(text);
}

/**
 * Threads the user started that only the history database still holds.
 * `skip` names the ids already listed from rollout files, which stay the
 * source for those threads.
 */
export async function scanCodexHistory(
  home: string,
  skip: ReadonlySet<string>,
): Promise<ExternalSessionSummary[]> {
  const statePath = await codexStoreFile(home, "state");
  const historyPath = await codexStoreFile(home, "thread_history");
  if (!statePath || !historyPath) return [];

  const state = await openDb(statePath);
  let threads: Row[];
  try {
    const columns = selectList(state, "threads", THREAD_REQUIRED, THREAD_OPTIONAL);
    if (!columns) return [];
    threads = state
      .prepare(`SELECT ${columns} FROM threads WHERE source IN (${USER_SOURCES.map(() => "?").join(", ")})`)
      .all(...USER_SOURCES) as Row[];
  } finally {
    state.close();
  }

  const history = await openDb(historyPath);
  const counts = new Map<string, number>();
  try {
    if (!selectList(history, "thread_items", ITEM_REQUIRED, [])) return [];
    const rows = history
      .prepare(
        `SELECT thread_id, count(*) AS n FROM thread_items
         WHERE item_type IN ('userMessage', 'agentMessage') GROUP BY thread_id`,
      )
      .all() as Row[];
    for (const row of rows) counts.set(String(row.thread_id), num(row.n) ?? 0);
  } finally {
    history.close();
  }

  const sessions: ExternalSessionSummary[] = [];
  for (const thread of threads) {
    const id = String(thread.id);
    // Threads attached to another one are its side panes, never listed on their own.
    if (skip.has(id) || str(thread.attached_thread_parent_id)) continue;
    const messageCount = counts.get(id) ?? 0;
    if (messageCount === 0) continue;
    const firstUser = str(thread.first_user_message);
    const request = firstUser ? userRequestText(firstUser.trim()) : "";
    const title = str(thread.name)?.trim()
      ?? (request && !isSyntheticUserText(request) ? request : "");
    const createdAt = toIso(msTime(thread.created_at_ms, thread.created_at));
    sessions.push({
      source: "codex",
      externalId: id,
      title: truncateTitle(title),
      projectPath: str(thread.cwd),
      model: str(thread.model),
      createdAt,
      updatedAt: toIso(msTime(thread.updated_at_ms, thread.updated_at), createdAt),
      messageCount,
      filePath: String(thread.rollout_path),
      historyDb: historyPath,
    });
  }
  return sessions;
}

function resultText(result: unknown): string {
  const content = obj(result).content;
  if (!Array.isArray(content)) return result === undefined || result === null ? "" : JSON.stringify(result);
  return content
    .map((part) => obj(part))
    .map((part) => (typeof part.text === "string" ? part.text : ""))
    .filter(Boolean)
    .join("\n");
}

function toolMessage(
  item: Row,
  createdAt: string,
  toolName: string,
  toolArgs: unknown,
  output: string,
  isError: boolean,
): ImportedUiMessage {
  return {
    id: randomUUID(),
    role: "tool",
    content: output,
    createdAt,
    toolName,
    toolCallId: str(item.id) ?? randomUUID(),
    toolStatus: isError ? "error" : "success",
    toolArgs,
    toolResult: output,
    isError: isError || undefined,
    status: "complete",
  };
}

/** One history item as chat messages; reasoning, compaction markers and agent bookkeeping are dropped. */
function itemMessages(item: Row, createdAt: string): ImportedUiMessage[] {
  switch (item.type) {
    case "userMessage": {
      const text = userText(item);
      if (!text || isSyntheticUserText(text)) return [];
      return [{ id: randomUUID(), role: "user", content: text, createdAt }];
    }
    case "agentMessage": {
      const text = str(item.text)?.trim();
      return text ? [{ id: randomUUID(), role: "assistant", content: text, createdAt, status: "complete" }] : [];
    }
    case "commandExecution": {
      const exitCode = num(item.exitCode);
      return [toolMessage(
        item, createdAt, "exec_command", { command: item.command, cwd: item.cwd },
        typeof item.aggregatedOutput === "string" ? item.aggregatedOutput : "",
        item.status === "failed" || (exitCode !== null && exitCode !== 0),
      )];
    }
    case "fileChange": {
      const changes = (Array.isArray(item.changes) ? item.changes : []).map((change) => obj(change));
      const output = changes
        .map((change) => [str(change.path), str(change.diff)].filter(Boolean).join("\n"))
        .join("\n\n");
      return [toolMessage(
        item, createdAt, "apply_patch", { paths: changes.map((change) => change.path) }, output,
        item.status === "failed",
      )];
    }
    case "mcpToolCall": {
      const error = item.error === null || item.error === undefined ? null : item.error;
      const output = error === null ? resultText(item.result) : str(obj(error).message) ?? JSON.stringify(error);
      return [toolMessage(
        item, createdAt, `mcp__${String(item.server ?? "mcp")}__${String(item.tool ?? "tool")}`,
        item.arguments, output, error !== null || item.status === "failed",
      )];
    }
    case "webSearch": {
      const results = (Array.isArray(item.results) ? item.results : [])
        .map((result) => obj(result))
        .map((result) => [str(result.title), str(result.url)].filter(Boolean).join(" — "))
        .filter(Boolean);
      return [toolMessage(item, createdAt, "web_search", { query: item.query }, results.join("\n"), false)];
    }
    default:
      return [];
  }
}

export async function convertCodexHistory(summary: ExternalSessionSummary): Promise<ImportedUiMessage[]> {
  if (!summary.historyDb) throw new Error("CODEX_IMPORT_INVALID_SEGMENT");
  const db = await openDb(summary.historyDb);
  let rows: Row[];
  try {
    rows = db
      .prepare("SELECT item_json, created_at_ms FROM thread_items WHERE thread_id = ? ORDER BY rollout_ordinal")
      .all(summary.externalId) as Row[];
  } finally {
    db.close();
  }
  if (rows.length === 0) throw new Error("CODEX_IMPORT_INVALID_SEGMENT");
  const messages: ImportedUiMessage[] = [];
  for (const row of rows) {
    let item: unknown;
    try {
      item = JSON.parse(String(row.item_json));
    } catch {
      continue;
    }
    messages.push(...itemMessages(obj(item), toIso(num(row.created_at_ms), summary.createdAt)));
  }
  return messages;
}
