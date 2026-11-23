import { type LoadedPlugin } from "./plugin-process-calls";
import {
  readFileSync,
  existsSync,
  mkdirSync,
  writeFileSync,
  realpathSync,
  statSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import {
  isDeniedFsPath,
  isFsPathInScope,
  normalizeFsPath,
  type PluginFsMode,
  type PluginFsRule,
} from "@pi-desktop/plugin-sdk";
import { resolveRealPathForCreateWithinRoot, resolveRealPathWithinRoot, resolveWithinRoot } from "@pi-desktop/host-runtime";
import { pluginWorkspaceForCall, pluginWorkspacePath } from "./plugin-workspace-context";
import { type PluginHostServices } from "./plugin-host-contracts";
import { apiError } from "./plugin-host-errors";
import { realpathOrSelf } from "./plugin-theme-paths";

/**
 * Delete budget per plugin per window. `recursive: false` does not bound the
 * blast radius on its own -- a glob followed by a loop of single-file removes
 * empties a workspace just as well as `rm -rf` does. Past the budget the user
 * is asked, which is what tells a cleanup routine apart from a wipe.
 */
export const MAX_DELETES_PER_WINDOW = 50;

const DELETE_RATE_WINDOW_MS = 60_000;

/** Entries in one plugin's write ledger; oldest are dropped past this. */
const MAX_WRITE_LEDGER_ENTRIES = 2000;

/** Host-owned file inside the plugin's data dir; the plugin API cannot reach it. */
const WRITE_LEDGER_FILE = "fs-write-ledger.json";
type FileAccessHost = {
  services: () => PluginHostServices;
  sessionForCall: (pluginId: string) => string | undefined;
  pluginDataDir: (pluginId: string) => string;
  assertPermission: (loaded: LoadedPlugin, permission: string) => void;
};

export class PluginFileAccess {
  private readonly fsConsent = new Map<string, Set<string>>();
  private readonly writeLedgers = new Map<string, Record<string, number>>();

  private readonly host: FileAccessHost;

  constructor(host: FileAccessHost) {
    this.host = host;
  }

  assertPermission(loaded: LoadedPlugin, permission: string): void {
    this.host.assertPermission(loaded, permission);
  }

  get services(): PluginHostServices {
    return this.host.services();
  }

  /**
   * Turn a real panel drop into a one-file, read-only grant. The panel host
   * proves the gesture; this method still re-resolves and rechecks the path so
   * a symlink or a protected file cannot turn that gesture into broader reach.
   */
  registerDroppedFile(
    loaded: LoadedPlugin,
    requestPath: string,
    droppedPath?: string,
  ): { grantId: string } {
    this.host.assertPermission(loaded, "fs.read");
    if (!droppedPath || !isAbsolute(requestPath) || resolve(requestPath) !== resolve(droppedPath)) {
      this.auditFs(loaded, "read", requestPath, "PERMISSION_DENIED");
      throw apiError("PERMISSION_DENIED", "file was not dropped into this plugin panel");
    }
    let full: string;
    try {
      full = realpathSync(requestPath);
      if (!statSync(full).isFile()) throw new Error("not a file");
    } catch {
      this.auditFs(loaded, "read", requestPath, "NOT_FOUND");
      throw apiError("NOT_FOUND", `cannot register dropped file: ${requestPath}`);
    }
    if (this.isProtectedPath(full) || isDeniedFsPath(normalizeFsPath(full))) {
      this.auditFs(loaded, "read", requestPath, "PERMISSION_DENIED");
      throw apiError("PERMISSION_DENIED", "dropped path is reserved by the app");
    }
    const grantId = randomUUID();
    loaded.dropGrants.set(grantId, { fullPath: full, requestPath: resolve(requestPath) });
    this.services.audit?.({
      pluginId: loaded.manifest.id,
      api: "fs.registerDropped",
      ok: true,
      ts: Date.now(),
      path: `<dropped>/${basename(full)}`,
    });
    return { grantId };
  }

  /**
   * The directory one fs call resolves against.
   *
   * A `userSelected` mode keeps the directory the user picked. Every other mode
   * resolves the project of the session that invoked the tool: two sessions can
   * sit on two projects at once, so the visible workspace is a fallback only --
   * for a panel call, which has no tool session, and for a session the host has
   * not launched yet.
   */
  fsRoot(loaded: LoadedPlugin, rule: PluginFsRule): string | null {
    if (rule.root === "userSelected") return loaded.userRoot ?? null;
    const sessionId = this.host.sessionForCall(loaded.manifest.id);
    return pluginWorkspacePath(this.services, sessionId);
  }

  /**
   * Resolve one file request and decide whether it may proceed.
   *
   * Four gates in a fixed order, because each one is only sound behind the
   * previous: the permission says the plugin may touch files at all;
   * containment says the path is really inside its root (through links, not
   * just lexically); the deny-list refuses credentials under every grant; and
   * only then does the declared scope -- or the user -- decide.
   */
  async resolveFsRequest(
    loaded: LoadedPlugin,
    mode: PluginFsMode,
    requestPath: string,
    options: { create?: boolean; dropGrantId?: string } = {},
  ): Promise<{ full: string; rel: string; root: string }> {
    this.host.assertPermission(loaded, `fs.${mode}`);
    if (typeof options.dropGrantId === "string") {
      if (mode !== "read") {
        throw apiError("PERMISSION_DENIED", "dropped-file grants are read-only");
      }
      const grant = loaded.dropGrants.get(options.dropGrantId);
      if (!grant) {
        this.auditFs(loaded, mode, requestPath, "PERMISSION_DENIED");
        throw apiError("PERMISSION_DENIED", "dropped-file grant is missing or expired");
      }
      if (!isAbsolute(requestPath) || resolve(requestPath) !== grant.requestPath) {
        this.auditFs(loaded, mode, requestPath, "PERMISSION_DENIED");
        throw apiError("PERMISSION_DENIED", "path does not match the dropped-file grant");
      }
      let full = grant.fullPath;
      try {
        full = realpathSync(full);
      } catch {
        this.auditFs(loaded, mode, requestPath, "NOT_FOUND");
        throw apiError("NOT_FOUND", `path not found: ${requestPath}`);
      }
      let requestedFull: string;
      try {
        requestedFull = realpathSync(requestPath);
      } catch {
        this.auditFs(loaded, mode, requestPath, "NOT_FOUND");
        throw apiError("NOT_FOUND", `path not found: ${requestPath}`);
      }
      if (full !== grant.fullPath || requestedFull !== grant.fullPath || !statSync(full).isFile()) {
        this.auditFs(loaded, mode, requestPath, "PERMISSION_DENIED");
        throw apiError("PERMISSION_DENIED", "dropped file was replaced");
      }
      if (this.isProtectedPath(full) || isDeniedFsPath(normalizeFsPath(full))) {
        this.auditFs(loaded, mode, requestPath, "PERMISSION_DENIED");
        throw apiError("PERMISSION_DENIED", "dropped path is reserved by the app");
      }
      return { full, rel: `<dropped>/${basename(full)}`, root: dirname(full) };
    }
    const rule: PluginFsRule = loaded.fsPolicy[mode] ?? { root: "workspace", scope: [] };
    const root = this.fsRoot(loaded, rule);
    if (!root) {
      throw apiError(
        "NOT_FOUND",
        rule.root === "userSelected"
          ? "no directory has been chosen; call fs.requestDirectory first"
          : "No workspace is open",
      );
    }

    const full = options.create
      ? await resolveRealPathForCreateWithinRoot(root, requestPath)
      : await resolveRealPathWithinRoot(root, requestPath);
    if (!full) {
      // A path that simply is not there gets said so. Only a path that exists
      // and resolves outside the root is an escape, and telling a plugin author
      // with a typo that they tried to escape the workspace is a lie that costs
      // them an afternoon.
      const lexical = !options.create && resolveWithinRoot(root, requestPath);
      const missing = Boolean(lexical) && !existsSync(lexical as string);
      const code = missing ? "NOT_FOUND" : "INVALID_ARGUMENT";
      this.auditFs(loaded, mode, requestPath, code);
      throw apiError(
        code,
        missing
          ? `path not found: ${requestPath}`
          : `path escapes the plugin's root: ${requestPath}`,
      );
    }
    // Both sides have to be resolved through links or the relative path comes
    // out as an escape whenever the root itself sits behind one, which is the
    // normal shape of a temp directory on macOS.
    const rootReal = realpathOrSelf(root);
    const rel = normalizeFsPath(relative(rootReal, full));

    if (this.isProtectedPath(full)) {
      this.auditFs(loaded, mode, requestPath, "PERMISSION_DENIED");
      throw apiError("PERMISSION_DENIED", "path is reserved by the app");
    }
    if (isDeniedFsPath(rel)) {
      this.auditFs(loaded, mode, requestPath, "PERMISSION_DENIED");
      throw apiError(
        "PERMISSION_DENIED",
        `credentials and repository internals are never readable by plugins: ${rel}`,
      );
    }

    // A directory the user pointed at is the grant; there is nothing narrower
    // to declare, so no scope is required inside it.
    if (rule.root === "userSelected") return { full, rel, root: rootReal };
    if (isFsPathInScope(rel, rule.scope)) return { full, rel, root: rootReal };
    if (mode === "delete" && rule.own && this.ownsWrite(loaded, full)) {
      return { full, rel, root: rootReal };
    }

    await this.requestFsConsent(loaded, mode, rel, full, "scope");
    return { full, rel, root: rootReal };
  }

  /**
   * Resolve a request that names a file in another folder of the open project
   * (ADR 0249, ADR 0263, ADR 0264). A view browsing a sibling folder can only
   * address that folder's entries absolutely, and the two host-mediated actions
   * it offers for them (fs.openDefault, fs.openInBrowser, fs.reveal) are the only requests that
   * arrive that way. The widening is narrow: only for a plugin whose declared
   * root is the workspace, only for an absolute path already inside one of the
   * project's registered folder roots (resolved through links, so a symlink
   * cannot carry it out of the folder that contains it), with the declared scope
   * matched against the path relative to the folder that answered, and with the
   * same protected-path and credential guards every other request passes. No
   * file content travels back through this route: it asks the OS to show a file
   * the user right-clicked. Null means it is not such a request, and the caller
   * falls back to the ordinary rooted resolution and its refusal.
   */
  async resolveRegisteredFolderRequest(
    loaded: LoadedPlugin,
    requestPath: string,
  ): Promise<{ full: string; rel: string; root: string } | null> {
    if (!isAbsolute(String(requestPath ?? ""))) return null;
    const rule: PluginFsRule = loaded.fsPolicy.read ?? { root: "workspace", scope: [] };
    if (rule.root !== "workspace") return null;
    const roots = (pluginWorkspaceForCall(this.services, this.host.sessionForCall(loaded.manifest.id))?.roots ?? [])
      .map((entry) => entry?.path)
      .filter((path): path is string => Boolean(path));
    if (roots.length === 0) return null;
    this.host.assertPermission(loaded, "fs.read");

    const wanted = resolve(String(requestPath));
    const matches: Array<{ full: string; rel: string; root: string }> = [];
    for (const candidate of roots) {
      const base = resolve(candidate);
      const lexical = relative(base, wanted);
      if (!lexical || lexical.startsWith("..") || isAbsolute(lexical)) continue;
      const resolved = await resolveRealPathWithinRoot(base, lexical);
      if (!resolved) continue;
      const rootReal = realpathOrSelf(base);
      matches.push({
        full: resolved,
        rel: normalizeFsPath(relative(rootReal, resolved)),
        root: rootReal,
      });
    }
    if (matches.length === 0) return null;
    // Folders may be nested in one another; the innermost is the one the user is
    // actually looking at.
    const hit = matches.reduce((best, current) => (current.rel.length < best.rel.length ? current : best));
    if (this.isProtectedPath(hit.full) || isDeniedFsPath(hit.rel)) {
      this.auditFs(loaded, "read", requestPath, "PERMISSION_DENIED");
      throw apiError(
        "PERMISSION_DENIED",
        `credentials and repository internals are never readable by plugins: ${hit.rel}`,
      );
    }
    if (!isFsPathInScope(hit.rel, rule.scope)) {
      this.auditFs(loaded, "read", requestPath, "PERMISSION_DENIED");
      throw apiError("PERMISSION_DENIED", `outside manifest.fs.read.scope: ${hit.rel}`);
    }
    return hit;
  }

  /**
   * Whether the path lies under something the host keeps for itself. Both
   * sides are resolved through links, or a barrier reached the other way
   * around simply would not match.
   */
  isProtectedPath(full: string): boolean {
    for (const guarded of this.services.protectedPaths?.() ?? []) {
      const barrier = realpathOrSelf(guarded);
      if (full === barrier || full.startsWith(barrier + sep)) return true;
    }
    return false;
  }

  /**
   * Ask the user, and remember the answer for the containing directory when
   * they say so. Without a consent service the access is simply refused: a
   * host that cannot ask must not assume yes.
   */
  async requestFsConsent(
    loaded: LoadedPlugin,
    mode: PluginFsMode,
    rel: string,
    full: string,
    reason: "scope" | "rate",
  ): Promise<void> {
    const pluginId = loaded.manifest.id;
    const key = `${mode}:${reason === "rate" ? "*" : dirname(full)}`;
    if (this.fsConsent.get(pluginId)?.has(key)) return;
    const ask = this.services.confirmFsAccess;
    if (!ask) {
      this.auditFs(loaded, mode, rel, "PERMISSION_DENIED");
      throw apiError("PERMISSION_DENIED", `outside manifest.fs.${mode}.scope: ${rel}`);
    }
    const answer = await ask({
      pluginId,
      pluginName: loaded.manifest.name,
      mode,
      path: rel,
      fullPath: full,
      reason,
    });
    if (answer === "deny") {
      this.auditFs(loaded, mode, rel, "PERMISSION_DENIED");
      throw apiError("PERMISSION_DENIED", `the user refused ${mode} on ${rel}`);
    }
    if (answer === "session") {
      const grants = this.fsConsent.get(pluginId) ?? new Set<string>();
      grants.add(key);
      this.fsConsent.set(pluginId, grants);
    }
    this.services.audit?.({
      pluginId,
      api: `fs.${mode}`,
      ok: true,
      ts: Date.now(),
      path: rel,
      data: { consent: answer, reason },
    });
  }

  auditFs(
    loaded: LoadedPlugin,
    mode: PluginFsMode,
    path: string,
    errorCode: string,
  ): void {
    this.services.audit?.({
      pluginId: loaded.manifest.id,
      api: `fs.${mode}`,
      ok: false,
      errorCode,
      ts: Date.now(),
      path,
    });
  }

  /** Absolute path of one plugin's write ledger. */
  private ledgerPath(loaded: LoadedPlugin): string {
    return join(this.host.pluginDataDir(loaded.manifest.id), WRITE_LEDGER_FILE);
  }

  /**
   * Paths this plugin wrote, mapped to the mtime it left behind. Kept on disk
   * so `fs.delete.own` survives a restart, and host-owned so the plugin API
   * cannot reach it. (A plugin process can still touch the file directly --
   * that is the same advisory limit every permission has until the plugin
   * runtime itself is sandboxed, and it grants nothing `node:fs` would not.)
   */
  private readLedger(loaded: LoadedPlugin): Record<string, number> {
    const cached = this.writeLedgers.get(loaded.manifest.id);
    if (cached) return cached;
    let ledger: Record<string, number> = {};
    try {
      const raw = JSON.parse(readFileSync(this.ledgerPath(loaded), "utf8")) as unknown;
      if (raw && typeof raw === "object" && !Array.isArray(raw)) {
        for (const [path, mtime] of Object.entries(raw as Record<string, unknown>)) {
          if (typeof mtime === "number") ledger[path] = mtime;
        }
      }
    } catch {
      ledger = {};
    }
    this.writeLedgers.set(loaded.manifest.id, ledger);
    return ledger;
  }

  /** Record a write so the plugin can clean up after itself later. */
  recordWrite(loaded: LoadedPlugin, full: string): void {
    const ledger = this.readLedger(loaded);
    let mtime = Date.now();
    try {
      mtime = statSync(full).mtimeMs;
    } catch {
      // Keep the wall clock; the ownership check tolerates a coarse value.
    }
    ledger[full] = mtime;
    const keys = Object.keys(ledger);
    if (keys.length > MAX_WRITE_LEDGER_ENTRIES) {
      for (const stale of keys.slice(0, keys.length - MAX_WRITE_LEDGER_ENTRIES)) {
        delete ledger[stale];
      }
    }
    try {
      const dir = this.host.pluginDataDir(loaded.manifest.id);
      mkdirSync(dir, { recursive: true });
      writeFileSync(this.ledgerPath(loaded), JSON.stringify(ledger), "utf8");
    } catch {
      // A ledger we cannot persist only costs the plugin its own-delete
      // shortcut on the next run; it never widens anything.
    }
  }

  /**
   * Whether the plugin wrote this exact file and nobody has touched it since.
   * A newer mtime means the user edited it, which makes it the user's file
   * again and sends the delete to a prompt.
   */
  private ownsWrite(loaded: LoadedPlugin, full: string): boolean {
    const recorded = this.readLedger(loaded)[full];
    if (recorded === undefined) return false;
    try {
      // One second of slack: some filesystems round mtime down.
      return statSync(full).mtimeMs <= recorded + 1000;
    } catch {
      return false;
    }
  }

  /** Rolling delete window per plugin, mirroring the bus publish brake. */
  deleteRateExceeded(loaded: LoadedPlugin): boolean {
    const now = Date.now();
    loaded.deletes = loaded.deletes.filter((at) => now - at < DELETE_RATE_WINDOW_MS);
    loaded.deletes.push(now);
    return loaded.deletes.length > MAX_DELETES_PER_WINDOW;
  }
}
