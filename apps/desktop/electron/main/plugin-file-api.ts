import { type LoadedPlugin } from "./plugin-process-calls";
import {
  readFileSync,
  existsSync,
  mkdirSync,
  writeFileSync,
  readdirSync,
  statSync,
  rmSync,
} from "node:fs";
import { open as openFile } from "node:fs/promises";
import {
  basename,
  dirname,
  extname,
  join,
  resolve,
} from "node:path";
import {
  isDeniedFsPath,
  isFsPathInScope,
  matchFsGlob,
  normalizeFsPath,
} from "@pi-desktop/plugin-sdk";
import { previewFile } from "@pi-desktop/host-runtime";
import { apiError } from "./plugin-host-errors";
import { realpathOrSelf } from "./plugin-theme-paths";
import type { PluginFileAccess } from "./plugin-file-access";


/** Kept from the pre-scope implementation: a listing is not a search index. */
const MAX_GLOB_MATCHES = 500;

/** Entries returned for one directory. A tree is walked lazily, not dumped. */
const MAX_LIST_ENTRIES = 1000;

/** Maximum bytes one plugin range call may cross the broker with. */
const MAX_FS_READ_RANGE_BYTES = 8 * 1024 * 1024;

/** Directories `pi.fs.glob` never walks into; they are noise and are denied anyway. */
const GLOB_SKIP_DIRS = new Set([".git", "node_modules", ".venv", "__pycache__"]);

export function pluginFileApi(access: PluginFileAccess, loaded: LoadedPlugin) {
  const pluginId = loaded.manifest.id;
  return {
    readText: async (pathFromRoot: string) => {
      const { full, rel } = await access.resolveFsRequest(
        loaded,
        "read",
        pathFromRoot,
      );
      const content = readFileSync(full, "utf8");
      access.services.audit?.({
        pluginId,
        api: "fs.readText",
        ok: true,
        ts: Date.now(),
        path: rel,
      });
      return content;
    },
    stat: async (pathFromRoot: string, grantId?: string) => {
      const { full, rel } = await access.resolveFsRequest(loaded, "read", pathFromRoot, {
        dropGrantId: grantId,
      });
      let info: ReturnType<typeof statSync>;
      try {
        info = statSync(full);
      } catch (error) {
        access.auditFs(loaded, "read", rel, "NOT_FOUND");
        throw apiError("NOT_FOUND", error instanceof Error ? error.message : String(error));
      }
      if (!info.isFile()) {
        access.auditFs(loaded, "read", rel, "INVALID_ARGUMENT");
        throw apiError("INVALID_ARGUMENT", "only files can be stated");
      }
      access.services.audit?.({
        pluginId,
        api: "fs.stat",
        ok: true,
        ts: Date.now(),
        path: rel,
      });
      return { size: info.size, mtimeMs: info.mtimeMs };
    },
    readRange: async (
      pathFromRoot: string,
      byteOffset: number,
      length: number,
      grantId?: string,
    ) => {
      const { full, rel } = await access.resolveFsRequest(loaded, "read", pathFromRoot, {
        dropGrantId: grantId,
      });
      if (
        !Number.isSafeInteger(byteOffset) ||
        byteOffset < 0 ||
        !Number.isSafeInteger(length) ||
        length < 0 ||
        length > MAX_FS_READ_RANGE_BYTES
      ) {
        access.auditFs(loaded, "read", rel, "INVALID_ARGUMENT");
        throw apiError(
          "INVALID_ARGUMENT",
          `byte range must be a non-negative offset and a length up to ${MAX_FS_READ_RANGE_BYTES} bytes`,
        );
      }
      const info = statSync(full);
      if (!info.isFile()) {
        access.auditFs(loaded, "read", rel, "INVALID_ARGUMENT");
        throw apiError("INVALID_ARGUMENT", "only files can be read by range");
      }
      const handle = await openFile(full, "r");
      try {
        const buffer = Buffer.alloc(length);
        const { bytesRead } = await handle.read(buffer, 0, length, byteOffset);
        access.services.audit?.({
          pluginId,
          api: "fs.readRange",
          ok: true,
          ts: Date.now(),
          path: rel,
          data: { byteOffset, length: bytesRead, totalSize: info.size },
        });
        return {
          bytes: Uint8Array.from(buffer.subarray(0, bytesRead)),
          totalSize: info.size,
        };
      } finally {
        await handle.close().catch(() => {});
      }
    },
    readPreview: async (pathFromRoot: string) => {
      const { full, rel } = await access.resolveFsRequest(
        loaded,
        "read",
        pathFromRoot,
      );
      if (!statSync(full).isFile()) {
        access.services.audit?.({
          pluginId,
          api: "fs.readPreview",
          ok: false,
          errorCode: "INVALID_ARGUMENT",
          ts: Date.now(),
          path: rel,
        });
        throw apiError("INVALID_ARGUMENT", "only files can be previewed");
      }
      const preview = await previewFile(full, rel);
      access.services.audit?.({
        pluginId,
        api: "fs.readPreview",
        ok: true,
        ts: Date.now(),
        path: rel,
        data: { kind: preview.kind, size: preview.size },
      });
      return preview;
    },
    openDefault: async (pathFromRoot: string) => {
      const { full, rel } =
        (await access.resolveRegisteredFolderRequest(loaded, pathFromRoot)) ??
        (await access.resolveFsRequest(loaded, "read", pathFromRoot));
      if (!statSync(full).isFile()) {
        access.services.audit?.({
          pluginId,
          api: "fs.openDefault",
          ok: false,
          errorCode: "INVALID_ARGUMENT",
          ts: Date.now(),
          path: rel,
        });
        throw apiError("INVALID_ARGUMENT", "only files can be opened with the default app");
      }
      try {
        await access.services.openPath(full);
      } catch (error) {
        access.services.audit?.({
          pluginId,
          api: "fs.openDefault",
          ok: false,
          errorCode: "OPEN_FAILED",
          ts: Date.now(),
          path: rel,
        });
        throw apiError("OPEN_FAILED", error instanceof Error ? error.message : String(error));
      }
      access.services.audit?.({
        pluginId,
        api: "fs.openDefault",
        ok: true,
        ts: Date.now(),
        path: rel,
      });
    },
    openInBrowser: async (pathFromRoot: string) => {
      const { full, rel } =
        (await access.resolveRegisteredFolderRequest(loaded, pathFromRoot)) ??
        (await access.resolveFsRequest(loaded, "read", pathFromRoot));
      if (!statSync(full).isFile()) {
        access.services.audit?.({
          pluginId,
          api: "fs.openInBrowser",
          ok: false,
          errorCode: "INVALID_ARGUMENT",
          ts: Date.now(),
          path: rel,
        });
        throw apiError("INVALID_ARGUMENT", "only files can be opened in the Browser");
      }
      if (![".html", ".htm", ".xhtml"].includes(extname(full).toLowerCase())) {
        access.services.audit?.({
          pluginId,
          api: "fs.openInBrowser",
          ok: false,
          errorCode: "INVALID_ARGUMENT",
          ts: Date.now(),
          path: rel,
        });
        throw apiError("INVALID_ARGUMENT", "only HTML files can be opened in the Browser");
      }
      try {
        await access.services.openInBrowser?.(full);
      } catch (error) {
        const code = typeof error === "object" && error !== null && "code" in error
          ? String(error.code)
          : "OPEN_FAILED";
        access.services.audit?.({
          pluginId,
          api: "fs.openInBrowser",
          ok: false,
          errorCode: code,
          ts: Date.now(),
          path: rel,
        });
        throw apiError(code, error instanceof Error ? error.message : String(error));
      }
      access.services.audit?.({
        pluginId,
        api: "fs.openInBrowser",
        ok: true,
        ts: Date.now(),
        path: rel,
      });
    },
    reveal: async (pathFromRoot: string) => {
      const { full, rel } =
        (await access.resolveRegisteredFolderRequest(loaded, pathFromRoot)) ??
        (await access.resolveFsRequest(loaded, "read", pathFromRoot));
      if (!statSync(full).isFile()) {
        access.services.audit?.({
          pluginId,
          api: "fs.reveal",
          ok: false,
          errorCode: "INVALID_ARGUMENT",
          ts: Date.now(),
          path: rel,
        });
        throw apiError("INVALID_ARGUMENT", "only files can be revealed in the file manager");
      }
      if (!access.services.revealPath) {
        access.services.audit?.({
          pluginId,
          api: "fs.reveal",
          ok: false,
          errorCode: "UNSUPPORTED",
          ts: Date.now(),
          path: rel,
        });
        throw apiError("UNSUPPORTED", "revealPath service missing");
      }
      try {
        await access.services.revealPath(full);
      } catch (error) {
        access.services.audit?.({
          pluginId,
          api: "fs.reveal",
          ok: false,
          errorCode: "REVEAL_FAILED",
          ts: Date.now(),
          path: rel,
        });
        throw apiError("REVEAL_FAILED", error instanceof Error ? error.message : String(error));
      }
      access.services.audit?.({
        pluginId,
        api: "fs.reveal",
        ok: true,
        ts: Date.now(),
        path: rel,
      });
    },
    /**
     * One directory's entries, so a plugin can walk a tree lazily instead
     * of pulling a whole-repo glob it then has to reassemble.
     *
     * The guards match `fs.glob` exactly — declared read scope, protected
     * paths, denied names, skipped heavy directories — because a listing is
     * a read: what a plugin may not open, it may not learn the name of.
     */
    list: async (pathFromRoot: string) => {
      access.assertPermission(loaded, "fs.read");
      const rule = loaded.fsPolicy.read ?? { root: "workspace", scope: [] };
      const root = access.fsRoot(loaded, rule);
      if (!root) throw apiError("NOT_FOUND", "No workspace is open");
      const rel = normalizeFsPath(String(pathFromRoot ?? ""));
      if (rel.split("/").includes("..")) {
        throw apiError("INVALID_ARGUMENT", "path must stay inside the root");
      }
      const base = realpathOrSelf(root);
      const dir = rel ? join(base, rel) : base;
      if (access.isProtectedPath(dir)) {
        throw apiError("PERMISSION_DENIED", "path is protected");
      }
      let names: string[] = [];
      try {
        names = readdirSync(dir);
      } catch {
        throw apiError("NOT_FOUND", `cannot list ${rel || "."}`);
      }
      const entries: Array<{
        name: string;
        path: string;
        isDirectory: boolean;
        size?: number;
        mtimeMs?: number;
      }> = [];
      for (const name of names.sort()) {
        if (entries.length >= MAX_LIST_ENTRIES) break;
        const childRel = rel ? `${rel}/${name}` : name;
        const full = join(dir, name);
        if (isDeniedFsPath(childRel)) continue;
        if (access.isProtectedPath(full)) continue;
        let st: ReturnType<typeof statSync>;
        try {
          st = statSync(full);
        } catch {
          continue;
        }
        if (st.isDirectory()) {
          if (GLOB_SKIP_DIRS.has(name)) continue;
          // A directory is offered whenever anything under it could be in
          // scope, so a narrow scope still yields a navigable tree.
          entries.push({ name, path: childRel, isDirectory: true });
          continue;
        }
        if (rule.root !== "userSelected" && !isFsPathInScope(childRel, rule.scope)) {
          continue;
        }
        entries.push({
          name,
          path: childRel,
          isDirectory: false,
          size: st.size,
          mtimeMs: st.mtimeMs,
        });
      }
      access.services.audit?.({
        pluginId,
        api: "fs.list",
        ok: true,
        ts: Date.now(),
        path: rel,
        data: { entries: entries.length },
      });
      return entries;
    },
    writeText: async (pathFromRoot: string, content: string) => {
      const { full, rel } = await access.resolveFsRequest(
        loaded,
        "write",
        pathFromRoot,
        { create: true },
      );
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, content, "utf8");
      // Recorded so `fs.delete` with `own` can clean up this file later
      // without asking: removing your own output surprises nobody.
      access.recordWrite(loaded, full);
      access.services.audit?.({
        pluginId,
        api: "fs.writeText",
        ok: true,
        ts: Date.now(),
        path: rel,
      });
    },
    glob: async (pattern: string) => {
      access.assertPermission(loaded, "fs.read");
      const rule = loaded.fsPolicy.read ?? { root: "workspace", scope: [] };
      const root = access.fsRoot(loaded, rule);
      if (!root) throw apiError("NOT_FOUND", "No workspace is open");
      const matches: string[] = [];
      const visit = (dir: string, rel = "") => {
        if (matches.length >= MAX_GLOB_MATCHES) return;
        let entries: string[] = [];
        try {
          entries = readdirSync(dir);
        } catch {
          return;
        }
        for (const entry of entries) {
          if (matches.length >= MAX_GLOB_MATCHES) return;
          const full = join(dir, entry);
          const nextRel = rel ? `${rel}/${entry}` : entry;
          let st: ReturnType<typeof statSync>;
          try {
            st = statSync(full);
          } catch {
            continue;
          }
          if (st.isDirectory()) {
            // Skipped rather than filtered: walking a node_modules tree to
            // discard every hit is the slow way to return nothing.
            if (GLOB_SKIP_DIRS.has(entry)) continue;
            if (access.isProtectedPath(full)) continue;
            visit(full, nextRel);
            continue;
          }
          if (!matchFsGlob(nextRel, pattern)) continue;
          if (isDeniedFsPath(nextRel)) continue;
          // A name is a read too: what the plugin may not open, it may not
          // learn the existence of.
          if (access.isProtectedPath(full)) continue;
          // A listing is a read: what the plugin may not open, it may not
          // learn the name of either.
          if (rule.root !== "userSelected" && !isFsPathInScope(nextRel, rule.scope)) {
            continue;
          }
          matches.push(nextRel);
        }
      };
      visit(realpathOrSelf(root));
      access.services.audit?.({
        pluginId,
        api: "fs.glob",
        ok: true,
        ts: Date.now(),
        data: { pattern, matches: matches.length },
      });
      return matches;
    },
    remove: async (pathFromRoot: string) => {
      const { full, rel, root } = await access.resolveFsRequest(
        loaded,
        "delete",
        pathFromRoot,
      );
      if (full === resolve(root)) {
        throw apiError("INVALID_ARGUMENT", "cannot remove the root itself");
      }
      if (!existsSync(full)) {
        throw apiError("NOT_FOUND", `path not found: ${pathFromRoot}`);
      }
      // Scope answers "may this file go"; the brake answers "this many, this
      // fast?", which is the only thing that separates a cleanup from a wipe.
      if (access.deleteRateExceeded(loaded)) {
        await access.requestFsConsent(loaded, "delete", rel, full, "rate");
        loaded.deletes = [];
      }
      // Never recurse: removing a file or an empty directory is in scope,
      // but a non-empty directory has to fail closed.
      if (access.services.trashItem) {
        // The OS trash is the undo. Nothing of the user's is copied
        // anywhere, and a delete this gate got wrong stays recoverable.
        if (statSync(full).isDirectory() && readdirSync(full).length) {
          throw apiError("INVALID_ARGUMENT", "refusing to remove a non-empty directory");
        }
        await access.services.trashItem(full);
      } else {
        rmSync(full, { recursive: false, force: false });
      }
      access.services.audit?.({
        pluginId,
        api: "fs.remove",
        ok: true,
        ts: Date.now(),
        path: rel,
      });
    },
    requestDirectory: async () => {
      access.assertPermission(loaded, "fs.read");
      const picker = access.services.pickDirectory;
      if (!picker) throw apiError("UNSUPPORTED", "no directory picker is available");
      const picked = await picker({ pluginId, pluginName: loaded.manifest.name });
      if (!picked) {
        access.services.audit?.({
          pluginId,
          api: "fs.requestDirectory",
          ok: false,
          errorCode: "CANCELLED",
          ts: Date.now(),
        });
        return null;
      }
      // Replaces any earlier pick: one root at a time keeps what the plugin
      // can reach the same thing the user last pointed at.
      loaded.userRoot = resolve(picked);
      access.services.audit?.({
        pluginId,
        api: "fs.requestDirectory",
        ok: true,
        ts: Date.now(),
        path: loaded.userRoot,
      });
      return { path: loaded.userRoot, name: basename(loaded.userRoot) };
    },
  };
}