import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { ExternalSessionSummary, ImportedUiMessage, SessionImporter } from "./types";
import { importedSessionId, toIso, truncateTitle } from "./types";

/*
 * Hermes Agent (Nous Research) keeps every conversation in one SQLite file,
 * `<HERMES_HOME>/state.db` (tables `sessions` and `messages`, OpenAI-style rows).
 * HERMES_HOME defaults to `~/.hermes` (`%LOCALAPPDATA%\hermes` on Windows);
 * named profiles live in `<HERMES_HOME>/profiles/<name>/state.db`.
 *
 * One importable conversation is what Hermes' own session picker shows: a root
 * (or /branch, /reset child) session plus the compression continuations that
 * Hermes rotates into new session rows. The file is opened read-only.
 */

type Row = Record<string, unknown>;
type Db = {
  prepare(sql: string): { all(...params: unknown[]): unknown[] };
  close(): void;
};

/** Rows Hermes keeps for the model or its own UI, not as conversation turns. */
const SKIPPED_DISPLAY_KINDS = new Set([
  "hidden",
  "internal_notification",
  "auto_continue",
  "model_switch",
  "async_delegation_complete",
  "process_complete",
]);
const RESET_END_REASONS = new Set([
  "session_reset", "session_switch", "idle", "daily", "suspended", "resume_pending_expired",
]);
const CONTENT_JSON_PREFIX = "\u0000json:";
const MAX_DB_BYTES = 16 * 1024 * 1024 * 1024;
const MAX_CHAIN = 100;
const SESSION_REQUIRED = ["id", "started_at"];
const SESSION_OPTIONAL = [
  "source", "model", "model_config", "parent_session_id", "ended_at", "end_reason", "cwd",
  "title", "last_activity_at", "hidden", "session_key",
];
const MESSAGE_REQUIRED = ["id", "session_id", "role", "content", "timestamp"];
const MESSAGE_OPTIONAL = [
  "tool_call_id", "tool_calls", "tool_name", "active", "compacted", "_compressed_summary",
  "display_kind", "display_metadata",
];

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
function parseJson(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try { return JSON.parse(value); } catch { return undefined; }
}
/** Hermes stores seconds since the epoch as REAL. */
function secondsIso(value: unknown, fallback?: string): string {
  const seconds = num(value);
  return toIso(seconds === null ? undefined : Math.round(seconds * 1000), fallback);
}

/** Reverse Hermes' `_encode_content`: structured parts carry a `\0json:` prefix. */
function decodeContent(raw: unknown): unknown {
  if (typeof raw === "string" && raw.startsWith(CONTENT_JSON_PREFIX)) {
    const parsed = parseJson(raw.slice(CONTENT_JSON_PREFIX.length));
    return parsed === undefined ? raw : parsed;
  }
  return raw;
}
function contentText(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "";
  if (!Array.isArray(value)) return typeof value === "object" ? JSON.stringify(value) : String(value);
  return value.map((part) => {
    if (typeof part === "string") return part;
    const entry = obj(part);
    if (entry.type === "text" || entry.type === "input_text" || entry.type === "output_text") {
      return str(entry.text) ?? "";
    }
    if (typeof entry.type === "string" && /image/.test(entry.type)) return "[image]";
    return "";
  }).filter(Boolean).join("\n");
}

export function defaultHermesHome(env: NodeJS.ProcessEnv = process.env, platform = process.platform): string {
  const suffix = env.HERMES_DATA_DIR_SUFFIX ?? "";
  if (platform === "win32") {
    const base = env.LOCALAPPDATA?.trim() || path.join(os.homedir(), "AppData", "Local");
    return path.join(base, `hermes${suffix}`);
  }
  return path.join(os.homedir(), `.hermes${suffix}`);
}

function expandHome(value: string): string {
  return value === "~" || value.startsWith("~/") || value.startsWith("~\\")
    ? path.join(os.homedir(), value.slice(1)) : value;
}

type Store = { dbPath: string; profile: string | null };

/** `state.db` of HERMES_HOME (if set), the platform default home and each named profile. */
async function discoverStores(homes: string[]): Promise<Store[]> {
  const stores: Store[] = [];
  const seen = new Set<string>();
  const add = async (dir: string, profile: string | null) => {
    const dbPath = path.join(dir, "state.db");
    let key = dbPath;
    try { key = await fs.realpath(dbPath); } catch { return; }
    if (seen.has(key)) return;
    seen.add(key);
    stores.push({ dbPath, profile });
  };
  for (const home of homes) {
    await add(home, null);
    let profiles;
    try { profiles = await fs.readdir(path.join(home, "profiles"), { withFileTypes: true }); }
    catch { continue; }
    for (const entry of profiles) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
      await add(path.join(home, "profiles", entry.name), entry.name);
    }
  }
  return stores;
}

async function checkedDb(dbPath: string): Promise<void> {
  const stat = await fs.lstat(dbPath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_DB_BYTES) {
    throw new Error("HERMES_IMPORT_INVALID_FILE");
  }
}

async function openDb(dbPath: string): Promise<Db> {
  await checkedDb(dbPath);
  const { DatabaseSync } = await import("node:sqlite");
  return new DatabaseSync(dbPath, { readOnly: true }) as unknown as Db;
}

function columns(db: Db, table: string): Set<string> {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Row[];
  return new Set(rows.map((row) => String(row.name)));
}

/** Project the columns this importer reads; columns an older Hermes lacks read as NULL. */
function selectList(db: Db, table: string, required: string[], optional: string[]): string {
  const present = columns(db, table);
  for (const column of required) {
    if (!present.has(column)) throw new Error("HERMES_IMPORT_UNSUPPORTED_FORMAT");
  }
  return [...required, ...optional]
    .map((column) => (present.has(column) ? `"${column}"` : `NULL AS "${column}"`))
    .join(", ");
}

function markers(session: Row): Row {
  return obj(parseJson(session.model_config));
}

/** Mirrors Hermes' `_is_compression_child_row`: the parent ended in compression and no fork marker names it. */
function isContinuation(session: Row, byId: Map<string, Row>): boolean {
  const parentId = str(session.parent_session_id);
  if (!parentId || session.source === "tool") return false;
  const parent = byId.get(parentId);
  if (!parent || parent.end_reason !== "compression") return false;
  const marks = markers(session);
  return !["_branched_from", "_delegate_from", "_reset_from"].some((key) => marks[key] === parentId);
}

/** Picker-visible conversations: roots and /branch or /reset children, never sub-agent or tool runs. */
function isHead(session: Row, byId: Map<string, Row>): boolean {
  if (num(session.hidden) === 1 || session.source === "tool") return false;
  const marks = markers(session);
  if (marks._delegate_from !== undefined && marks._delegate_from !== null) return false;
  const parentId = str(session.parent_session_id);
  if (!parentId) return true;
  if (isContinuation(session, byId)) return false;
  if (marks._branched_from === parentId) return true;
  if (marks._reset_from !== undefined && marks._reset_from !== null) return true;
  const parent = byId.get(parentId);
  if (!parent) return true; // Orphaned by a pruned parent: still the user's conversation.
  if (parent.end_reason === "branched") return true;
  // Pre-marker /reset: same routing key, parent ended at a reset boundary.
  const key = str(session.session_key);
  return Boolean(key && key === str(parent.session_key) && RESET_END_REASONS.has(String(parent.end_reason)));
}

/** Head → tip through compression continuations (newest child wins when several exist). */
function chainFrom(head: Row, children: Map<string, Row[]>, byId: Map<string, Row>): Row[] {
  const chain = [head];
  const seen = new Set([String(head.id)]);
  let current = head;
  while (chain.length < MAX_CHAIN && current.end_reason === "compression") {
    const next = (children.get(String(current.id)) ?? [])
      .filter((child) => isContinuation(child, byId) && !seen.has(String(child.id)))
      .sort((a, b) => (num(b.started_at) ?? 0) - (num(a.started_at) ?? 0))[0];
    if (!next) break;
    seen.add(String(next.id));
    chain.push(next);
    current = next;
  }
  return chain;
}

function readSessions(db: Db): Row[] {
  const list = selectList(db, "sessions", SESSION_REQUIRED, SESSION_OPTIONAL);
  return db.prepare(`SELECT ${list} FROM sessions`).all() as Row[];
}

function readRows(db: Db, sessionIds: string[]): Row[] {
  const list = selectList(db, "messages", MESSAGE_REQUIRED, MESSAGE_OPTIONAL);
  const marks = sessionIds.map(() => "?").join(", ");
  return db.prepare(
    `SELECT ${list} FROM messages WHERE session_id IN (${marks}) ORDER BY id ASC`,
  ).all(...sessionIds) as Row[];
}

function toolCallParts(raw: unknown): Array<{ id: string; name: string; args: unknown }> {
  const calls = parseJson(raw);
  if (!Array.isArray(calls)) return [];
  const out: Array<{ id: string; name: string; args: unknown }> = [];
  for (const entry of calls) {
    const call = obj(entry);
    const fn = obj(call.function);
    const id = str(call.id) ?? str(call.call_id);
    if (!id) continue;
    let args = fn.arguments ?? call.arguments;
    if (typeof args === "string") {
      try { args = JSON.parse(args); } catch { /* Keep non-JSON tool input verbatim. */ }
    }
    out.push({ id, name: str(fn.name) ?? str(call.name) ?? "tool", args });
  }
  return out;
}

/** Visible rows of a chain, in Hermes' display order, as mc-agent UI messages. */
export function convertHermesRows(rows: Row[], fallbackCreatedAt: string): ImportedUiMessage[] {
  const messages: ImportedUiMessage[] = [];
  const calls = new Map<string, ImportedUiMessage>();
  const seen = new Set<string>();
  for (const row of rows) {
    const role = row.role;
    if (role !== "user" && role !== "assistant" && role !== "tool") continue;
    // Undo/rewind removed it; compaction-archived originals (compacted = 1) stay visible.
    if (num(row.active) === 0 && num(row.compacted) !== 1) continue;
    if (num(row._compressed_summary) === 1) continue;
    if (typeof row.display_kind === "string" && SKIPPED_DISPLAY_KINDS.has(row.display_kind)) continue;
    if (obj(parseJson(row.display_metadata)).model_only === true) continue;
    // Compaction and compression rotation copy the protected tail into the next generation.
    const key = JSON.stringify([role, row.content, num(row.timestamp), row.tool_call_id ?? null,
      row.tool_calls ?? null, row.tool_name ?? null]);
    if (seen.has(key)) continue;
    seen.add(key);
    const createdAt = secondsIso(row.timestamp, fallbackCreatedAt);
    const text = contentText(decodeContent(row.content));
    if (role === "user") {
      if (text.trim()) messages.push({ id: randomUUID(), role, content: text, createdAt });
      continue;
    }
    if (role === "assistant") {
      if (text.trim()) messages.push({ id: randomUUID(), role, content: text, createdAt, status: "complete" });
      for (const call of toolCallParts(row.tool_calls)) {
        const message: ImportedUiMessage = { id: randomUUID(), role: "tool", content: "", createdAt,
          toolCallId: call.id, toolName: call.name, toolArgs: call.args, toolStatus: "interrupted",
          status: "complete" };
        calls.set(call.id, message);
        messages.push(message);
      }
      continue;
    }
    const callId = str(row.tool_call_id);
    const call = callId ? calls.get(callId) : undefined;
    if (call) {
      Object.assign(call, { content: text, toolResult: text, toolStatus: "success" });
      calls.delete(callId!);
    } else {
      messages.push({ id: randomUUID(), role: "tool", content: text, createdAt,
        toolCallId: callId ?? undefined, toolName: str(row.tool_name) ?? "tool", toolResult: text,
        toolStatus: "success", status: "complete" });
    }
  }
  return messages;
}

function externalIdFor(store: Store, headId: string): string {
  return store.profile ? `${store.profile}.${headId}` : headId;
}

function headIdFrom(store: Store, externalId: string): string {
  if (!store.profile) return externalId;
  const prefix = `${store.profile}.`;
  if (!externalId.startsWith(prefix)) throw new Error("HERMES_IMPORT_INVALID_ID");
  return externalId.slice(prefix.length);
}

type Conversation = { summary: ExternalSessionSummary; messages: ImportedUiMessage[] };

function conversations(db: Db, store: Store, onlyHead?: string): Conversation[] {
  const sessions = readSessions(db);
  const byId = new Map(sessions.map((session) => [String(session.id), session]));
  const children = new Map<string, Row[]>();
  for (const session of sessions) {
    const parentId = str(session.parent_session_id);
    if (!parentId) continue;
    const list = children.get(parentId) ?? [];
    list.push(session);
    children.set(parentId, list);
  }
  const out: Conversation[] = [];
  for (const head of sessions) {
    const headId = String(head.id);
    if (onlyHead !== undefined && headId !== onlyHead) continue;
    if (!isHead(head, byId)) continue;
    const chain = chainFrom(head, children, byId);
    const tip = chain[chain.length - 1];
    const createdAt = secondsIso(head.started_at);
    const messages = convertHermesRows(readRows(db, chain.map((s) => String(s.id))), createdAt);
    if (!messages.length) continue;
    const activity = chain
      .flatMap((s) => [num(s.last_activity_at), num(s.ended_at), num(s.started_at)])
      .filter((value): value is number => value !== null);
    const latestMessage = messages[messages.length - 1].createdAt;
    const latestSession = activity.length ? secondsIso(Math.max(...activity), createdAt) : createdAt;
    const firstUser = messages.find((message) => message.role === "user")?.content ?? "";
    out.push({
      summary: {
        source: "hermes",
        externalId: externalIdFor(store, headId),
        title: str(tip.title) ?? str(head.title) ?? (truncateTitle(firstUser) || headId),
        projectPath: str(tip.cwd) ?? str(head.cwd),
        model: str(tip.model) ?? str(head.model),
        createdAt,
        updatedAt: latestMessage > latestSession ? latestMessage : latestSession,
        messageCount: messages.length,
        filePath: store.dbPath,
      },
      messages,
    });
  }
  return out;
}

export function createHermesImporter(homes?: string[]): SessionImporter {
  const roots = () => {
    if (homes) return homes;
    const fromEnv = process.env.HERMES_HOME?.trim();
    return [...(fromEnv ? [path.resolve(expandHome(fromEnv))] : []), defaultHermesHome()];
  };
  return {
    source: "hermes",
    async scan() {
      const sessions: ExternalSessionSummary[] = [];
      for (const store of await discoverStores(roots())) {
        let db: Db | undefined;
        try {
          db = await openDb(store.dbPath);
          sessions.push(...conversations(db, store).map((entry) => entry.summary));
        } catch {
          console.warn("[hermes-import] Skipped an unreadable or unsupported Hermes state.db");
        } finally {
          db?.close();
        }
      }
      return sessions.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    },
    async convert(summary) {
      if (summary.source !== "hermes") throw new Error("HERMES_IMPORT_INVALID_ID");
      const store = (await discoverStores(roots())).find((entry) => entry.dbPath === summary.filePath);
      if (!store) throw new Error("HERMES_IMPORT_INVALID_FILE");
      const db = await openDb(store.dbPath);
      try {
        const [found] = conversations(db, store, headIdFrom(store, summary.externalId));
        if (!found) throw new Error("HERMES_IMPORT_EMPTY_HISTORY");
        return { session: { id: importedSessionId("hermes", summary.externalId), title: summary.title,
          projectPath: summary.projectPath, modelId: null, providerId: null, mode: "agent",
          createdAt: summary.createdAt, updatedAt: summary.updatedAt }, messages: found.messages };
      } finally {
        db.close();
      }
    },
  };
}

export const hermesImporter = createHermesImporter();
