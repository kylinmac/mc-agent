import { shell } from "electron";
import { isAbsolute, join, relative, resolve } from "node:path";
import { mkdirSync } from "node:fs";
import {
  ErrorCodes,
  IPC,
  type Mode,
  type SessionThinkingLevel,
} from "@pi-desktop/shared";
import { registerSessionImportIpc } from "./session-import-ipc";
import type { AgentSidecar } from "../agent-sidecar";
import type { HostProcess } from "../host-process";
import type { Logger } from "../logger";
import type { PersistenceOutbox } from "../persistence-outbox";
import type { PluginRuntime } from "../plugin-runtime";
import { readSessionCollaboration } from "../services/session-collaboration";
import { localNativeProjectPaths, searchSessionsAcrossSources } from "../services/session-search";
import type { IpcRegistrar } from "./types";
import { getActiveRemoteHostsBoot } from "../bootstrap/remote-hosts.js";

type RuntimeSession = {
  id?: string;
  projectPath?: string | null;
  providerId?: string;
  modelId?: string;
  thinkingLevel?: SessionThinkingLevel;
  [key: string]: unknown;
};

function rejectNativeMutation(sessionId: unknown, action: string): void {
  if (typeof sessionId === "string" && sessionId.startsWith("native-pi:")) {
    throw Object.assign(new Error(`Native Pi session ${action} is not supported`), {
      errorCode: ErrorCodes.INVALID_ARGUMENT,
    });
  }
}

export type SessionIpcDependencies = {
  registrar: IpcRegistrar;
  getHost: () => HostProcess | null;
  getSidecar: () => AgentSidecar | null;
  dataDir: string;
  activeTurns: ReadonlyMap<string, string>;
  sessionProjects: Map<string, string | null>;
  persistenceOutbox: PersistenceOutbox;
  logger: Pick<Logger, "app">;
  plugins: Pick<PluginRuntime, "broadcastEvent">;
  sessionCapabilityContext: () => Promise<{ providers: any; defaults: any }>;
  enrichSession: (session: any, providers: any, defaults: any) => any;
  acquireSessionOperation: (sessionId: string) => Promise<() => void>;
  beginTranscriptRewrite: (sessionId: string) => {
    commit: () => void;
    rollback: () => void;
  };
  forgetTranscriptRewriteHistory: (sessionId: string) => void;
  stripWinLongPrefix: (path: string) => string;
};

export function registerSessionIpc({
  registrar,
  getHost,
  getSidecar,
  dataDir,
  activeTurns,
  sessionProjects,
  persistenceOutbox,
  logger,
  plugins,
  sessionCapabilityContext,
  enrichSession,
  acquireSessionOperation,
  beginTranscriptRewrite,
  forgetTranscriptRewriteHistory,
  stripWinLongPrefix,
}: SessionIpcDependencies): void {
  registerSessionImportIpc({ registrar, getHost, logger });
  const { handle } = registrar;

  /**
   * The one gate for the two transcript-rewrite entrances — replacement and
   * revision activation rewrite the same host-side transcript rows, so both
   * go through this boundary instead of each entrance remembering its own
   * (#1612, #1613): refuse while a turn is running (consistent with fork and
   * move), serialize overlapping operations per session, and drain the
   * persistence outbox so writes queued before the rewrite land in the old
   * transcript rather than replaying into the new one. The persistence fence
   * also holds callbacks delivered after that drain: successful rewrites
   * invalidate pre-rewrite turns, while failed rewrites replay their events.
   * The sidecar runtime is dropped after the drain so the next prompt reseeds
   * from the rewritten transcript instead of replaying the discarded branch
   * in memory.
   */
  const runTranscriptRewrite = async <T>(
    sessionId: string,
    purpose: string,
    currentHost: HostProcess,
    sidecar: AgentSidecar | null,
    run: () => Promise<T>,
  ): Promise<T> => {
    rejectNativeMutation(sessionId, purpose);
    const releaseSessionOperation = await acquireSessionOperation(sessionId);
    let rewriteFence: ReturnType<typeof beginTranscriptRewrite> | undefined;
    try {
      if (activeTurns.has(sessionId)) {
        throw Object.assign(
          new Error("Cannot rewrite the transcript of a running session"),
          { errorCode: ErrorCodes.AGENT_BUSY },
        );
      }
      rewriteFence = beginTranscriptRewrite(sessionId);
      await persistenceOutbox.prepareSessionReplacement(sessionId, () => currentHost);
      if (sidecar) {
        sidecar.clearProjectInstructionRoot(sessionId);
        sidecar.clearVendorAuthBindings(sessionId);
        await sidecar
          .call("agent.disposeSession", { sessionId })
          .catch(() => undefined);
      }
      const result = await run();
      rewriteFence.commit();
      return result;
    } catch (error) {
      rewriteFence?.rollback();
      throw error;
    } finally {
      releaseSessionOperation();
    }
  };

  handle(IPC.invoke.sessionSearch, async (input) => {
    const host = getHost();
    const sidecar = getSidecar();
    if (!host) throw new Error("host unavailable");
    return searchSessionsAcrossSources(host, sidecar, input);
  });
  handle(IPC.invoke.sessionSearchContext, async (input) => {
    const host = getHost();
    if (!host) throw new Error("host unavailable");
    return host.call("search.context", input);
  });
  handle(IPC.invoke.todosGet, async (input: { sessionId?: unknown } = {}) => {
    const host = getHost();
    if (!host) throw new Error("host unavailable");
    if (typeof input.sessionId !== "string" || !input.sessionId.trim()) {
      throw Object.assign(new Error("sessionId is required"), {
        errorCode: ErrorCodes.INVALID_ARGUMENT,
      });
    }
    return host.call("todos.get", { sessionId: input.sessionId });
  });
  handle(IPC.invoke.sessionList, async () => {
    const host = getHost();
    const sidecar = getSidecar();
    if (!host) throw new Error("host unavailable");
    const [projectPaths, result, { providers, defaults }] = await Promise.all([
      localNativeProjectPaths(host),
      host.call<{ sessions: RuntimeSession[] }>("session.list"),
      sessionCapabilityContext(),
    ]);
    const native = sidecar
      ? await sidecar
          .call<{ sessions: RuntimeSession[] }>("native.session.list", { projectPaths })
          .catch(() => ({ sessions: [] as RuntimeSession[] }))
      : { sessions: [] as RuntimeSession[] };
    return {
      ...result,
      sessions: [
        ...result.sessions.map((session) => ({
          ...enrichSession(session, providers, defaults),
          source: "desktop",
        })),
        ...native.sessions,
        ...(getActiveRemoteHostsBoot()?.sessionSummaries() ?? []),
      ].sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt))),
    };
  });
  const createSession = async (method: "session.create" | "session.createConfigured", input: unknown) => {
    const host = getHost();
    if (!host) throw new Error("host unavailable");
    // Resolve enrichment before the write so a failed lookup cannot leave a new session behind.
    const { providers, defaults } = await sessionCapabilityContext();
    const res = await host.call<{ session?: (RuntimeSession & { id?: string }) | null }>(
      method,
      input,
    );
    logger.app("session", "info", "session created", { sessionId: res.session?.id });
    if (!res.session) return res;
    return { ...res, session: enrichSession(res.session, providers, defaults) };
  };
  // MCP and plugins share the ordinary create handler. Their separate permission
  // configuration operation requires confirmation; keep the selected-mode channel out of their catalog.
  handle(IPC.invoke.sessionCreate, (input = {}) => createSession("session.create", input));
  handle(IPC.invoke.sessionCreateConfigured, (input) => createSession("session.createConfigured", input));
  handle(
    IPC.invoke.sessionFork,
    async (
      input: { sessionId?: string; title?: string; throughMessageId?: string } = {},
    ) => {
      const host = getHost();
      const sidecar = getSidecar();
      const sessionId = String(input.sessionId ?? "").trim();
      if (sessionId.startsWith("native-pi:")) {
        // Native forks read the canonical JSONL and publish a new child file in
        // the sidecar; the Rust host and the Desktop queue are never involved.
        if (!sidecar) throw new Error("sidecar unavailable");
        const title = typeof input.title === "string" ? input.title.trim().replace(/\s+/g, " ").slice(0, 200) : "";
        const throughMessageId =
          typeof input.throughMessageId === "string" ? input.throughMessageId.trim() : "";
        if (throughMessageId.length > 256) {
          throw Object.assign(new Error("throughMessageId is too long"), {
            errorCode: ErrorCodes.INVALID_ARGUMENT,
          });
        }
        const result = await sidecar.call<{ session?: RuntimeSession | null }>(
          "native.session.fork",
          {
            id: sessionId,
            ...(title ? { title } : {}),
            ...(throughMessageId ? { throughMessageId } : {}),
          },
        );
        logger.app("session", "info", "native session forked", {
          sessionId: (result.session as { id?: string } | null)?.id,
          data: { sourceSessionId: sessionId },
        });
        return result;
      }
      if (!host) throw new Error("host unavailable");
      if (!sessionId) {
        throw Object.assign(new Error("sessionId required"), {
          errorCode: ErrorCodes.INVALID_ARGUMENT,
        });
      }
      if (activeTurns.has(sessionId) && !String(input.throughMessageId ?? "").trim()) {
        throw Object.assign(new Error("Cannot fork a running session"), {
          errorCode: ErrorCodes.AGENT_BUSY,
        });
      }
      // Resolve enrichment before the mutation so a provider-list failure
      // cannot report a failed IPC after the child has already been committed.
      const { providers, defaults } = await sessionCapabilityContext();
      let result: { session?: RuntimeSession | null };
      try {
        result = await host.call("session.fork", {
          sessionId,
          title: String(input.title ?? "").trim() || undefined,
          throughMessageId:
            String(input.throughMessageId ?? "").trim() || undefined,
        });
      } catch (error: any) {
        if (error?.data?.errorCode === ErrorCodes.CONFLICT) {
          throw Object.assign(new Error("Cannot fork a running session"), {
            errorCode: ErrorCodes.AGENT_BUSY,
          });
        }
        throw error;
      }
      if (!result.session) return result;
      logger.app("session", "info", "session forked", {
        sessionId: (result.session as { id?: string }).id,
        data: { sourceSessionId: sessionId },
      });
      return {
        ...result,
        session: enrichSession(result.session, providers, defaults),
      };
    },
  );
  handle(
    IPC.invoke.sessionGet,
    async (
      input:
        | string
        | {
            id?: string;
            messageBefore?: number;
            messageAround?: string;
            messageLimit?: number;
            contentLimit?: number;
          },
    ) => {
      const host = getHost();
      const sidecar = getSidecar();
      if (!host) throw new Error("host unavailable");
      const request = typeof input === "string" ? { id: input } : input ?? {};
      const id = String(request.id ?? "").trim();
      if (!id) throw new Error("session id required");
      if (id.startsWith("native-pi:")) {
        if (!sidecar) throw new Error("sidecar unavailable");
        return sidecar.call("native.session.get", { id, ...request });
      }
      const [result, { providers, defaults }] = await Promise.all([
        host.call<{ session?: RuntimeSession | null }>("session.get", {
          id,
          ...(typeof request.messageAround === "string" && request.messageAround.trim()
            ? { messageAround: request.messageAround }
            : {}),
          ...(Number.isInteger(request.messageBefore) && request.messageBefore! >= 0
            ? { messageBefore: request.messageBefore }
            : {}),
          ...(Number.isInteger(request.messageLimit) && request.messageLimit! > 0
            ? { messageLimit: request.messageLimit }
            : {}),
          ...(Number.isInteger(request.contentLimit) && request.contentLimit! > 0
            ? { contentLimit: request.contentLimit }
            : {}),
        }),
        sessionCapabilityContext(),
      ]);
      return result.session
        ? { ...result, session: enrichSession(result.session, providers, defaults) }
        : result;
    },
  );
  handle(IPC.invoke.sessionCollaboration, async (input?: { sessionId?: unknown }) => {
    const host = getHost();
    const sidecar = getSidecar();
    if (!host) throw new Error("host unavailable");
    const sessionId = typeof input?.sessionId === "string" ? input.sessionId.trim() : "";
    rejectNativeMutation(sessionId, "collaboration");
    if (!sessionId || sessionId.length > 256) {
      throw Object.assign(new Error("sessionId must be a non-empty string of at most 256 characters"), {
        errorCode: ErrorCodes.INVALID_ARGUMENT,
      });
    }
    return readSessionCollaboration(host, sidecar, sessionId);
  });
  handle(IPC.invoke.sessionUsageCost, async (input?: { sessionId?: unknown }) => {
    const host = getHost();
    const sessionId = typeof input?.sessionId === "string" ? input.sessionId.trim() : "";
    if (!sessionId || sessionId.length > 256) {
      throw Object.assign(new Error("sessionId must be a non-empty string of at most 256 characters"), {
        errorCode: ErrorCodes.INVALID_ARGUMENT,
      });
    }
    // Imported native Pi sessions have no Desktop turn ledger to roll up.
    if (sessionId.startsWith("native-pi:")) {
      return { sessionId, turnCount: 0, requestCount: 0, providers: [] };
    }
    if (!host) throw new Error("host unavailable");
    return host.call("session.usageCost", { sessionId });
  });
  handle(IPC.invoke.sessionOpen, async (rawSessionId: string) => {
    const host = getHost();
    const sidecar = getSidecar();
    if (!host) throw new Error("host unavailable");
    const sessionId = String(rawSessionId ?? "").trim();
    if (!sessionId) throw new Error("session id required");
    if (sessionId.startsWith("native-pi:")) {
      if (!sidecar) throw new Error("sidecar unavailable");
      return sidecar.call("native.session.get", { id: sessionId, messageLimit: 1 });
    }
    const [result, { providers, defaults }] = await Promise.all([
      host.call<{ session?: RuntimeSession | null }>("session.get", {
        id: sessionId,
        messageLimit: 1,
      }),
      sessionCapabilityContext(),
    ]);
    if (!result.session) {
      throw Object.assign(new Error("Session not found"), {
        errorCode: ErrorCodes.NOT_FOUND,
      });
    }
    return { ...result, session: enrichSession(result.session, providers, defaults) };
  });
  handle(IPC.invoke.sessionDelete, async (id: string) => {
    const host = getHost();
    const sidecar = getSidecar();
    if (id.startsWith("native-pi:")) {
      // mc-agent: a Pi CLI session is the Pi CLI's own file; it goes to the
      // Trash (recoverable) rather than being erased.
      if (!sidecar) throw new Error("agent runtime unavailable");
      const { path } = await sidecar.call<{ path: string }>("native.session.forget", { id });
      await shell.trashItem(path);
      logger.app("session", "info", "native pi session moved to trash", { sessionId: id });
      return { ok: true };
    }
    if (!host) throw new Error("host unavailable");
    const res = await host.call("session.delete", { id });
    await persistenceOutbox.dropSession(id);
    forgetTranscriptRewriteHistory(id);
    // Drop the session's pi-agent so a later session with the same id (or a
    // stale runtime) can't answer with this session's context.
    if (sidecar) {
      sidecar.clearProjectInstructionRoot(id);
      sidecar.clearVendorAuthBindings(id);
      await sidecar
        .call("agent.disposeSession", { sessionId: id })
        .catch(() => undefined);
    }
    sessionProjects.delete(id);
    logger.app("session", "info", "session deleted", { sessionId: id });
    return res;
  });
  handle(IPC.invoke.sessionRename, async (id: string, title: string) => {
    const host = getHost();
    if (id.startsWith("native-pi:")) {
      throw Object.assign(new Error("Native Pi session rename is not supported"), {
        errorCode: ErrorCodes.INVALID_ARGUMENT,
      });
    }
    if (!host) throw new Error("host unavailable");
    return host.call("session.rename", { id, title });
  });
  handle(IPC.invoke.sessionDeriveTitle, async (id: string, title: string) => {
    const host = getHost();
    if (id.startsWith("native-pi:")) {
      throw Object.assign(new Error("Native Pi session title derivation is not supported"), {
        errorCode: ErrorCodes.INVALID_ARGUMENT,
      });
    }
    if (!host) throw new Error("host unavailable");
    return host.call("session.deriveTitle", { id, title });
  });
  handle(
    IPC.invoke.sessionMoveProject,
    async (input: { sessionId?: string; projectPath?: string } = {}) => {
      const host = getHost();
      const sidecar = getSidecar();
      if (!host) throw new Error("host unavailable");
      const sessionId = String(input.sessionId ?? "").trim();
      rejectNativeMutation(sessionId, "project move");
      const projectPath = String(input.projectPath ?? "").trim();
      if (!sessionId) {
        throw Object.assign(new Error("sessionId required"), {
          errorCode: ErrorCodes.INVALID_ARGUMENT,
        });
      }
      if (!projectPath) {
        throw Object.assign(new Error("projectPath required"), {
          errorCode: ErrorCodes.INVALID_ARGUMENT,
        });
      }
      const releaseSessionOperation = await acquireSessionOperation(sessionId);
      try {
      if (activeTurns.has(sessionId)) {
        throw Object.assign(new Error("Cannot move a running session"), {
          errorCode: ErrorCodes.AGENT_BUSY,
        });
      }
      let result: { session?: (RuntimeSession & { projectPath?: string | null }) | null };
      try {
        result = await host.call("session.moveProject", { sessionId, projectPath });
      } catch (error: any) {
        // The durable running-turn guard can still reject a session whose turn
        // began between the check above and the host call.
        if (error?.data?.errorCode === ErrorCodes.CONFLICT) {
          throw Object.assign(new Error("Cannot move a running session"), {
            errorCode: ErrorCodes.AGENT_BUSY,
          });
        }
        throw error;
      }
      if (!result.session) return result;
      const movedProjectPath = result.session.projectPath?.trim() || null;
      sessionProjects.set(sessionId, movedProjectPath);
      // The live pi-agent caches the project instruction root and vendor auth
      // bindings. Drop it after a successful move so the next turn is rebuilt
      // from the moved session's own project instead of the previous one.
      if (sidecar) {
        sidecar.clearProjectInstructionRoot(sessionId);
        sidecar.clearVendorAuthBindings(sessionId);
        await sidecar
          .call("agent.disposeSession", { sessionId })
          .catch(() => undefined);
        if (movedProjectPath) {
          sidecar.setProjectInstructionRoot(sessionId, movedProjectPath);
        }
      }
      const { providers, defaults } = await sessionCapabilityContext();
      logger.app("session", "info", "session project moved", {
        sessionId,
        data: { projectPath: movedProjectPath },
      });
      return {
        ...result,
        session: enrichSession(result.session, providers, defaults),
      };
      } finally {
        releaseSessionOperation();
      }
    },
  );
  handle(
    IPC.invoke.sessionReplaceMessages,
    async (input: { sessionId: string; messages: unknown[] }) => {
      const currentHost = getHost();
      const sidecar = getSidecar();
      if (!currentHost) throw new Error("host unavailable");
      const sessionId = String(input?.sessionId || "");
      if (!sessionId) throw new Error("sessionId required");
      return runTranscriptRewrite(
        sessionId,
        "transcript replacement",
        currentHost,
        sidecar,
        () =>
          currentHost.call("session.replaceMessages", {
            sessionId,
            messages: input.messages ?? [],
          }),
      );
    },
  );
  handle(
    IPC.invoke.sessionSaveRevision,
    async (input: {
      sessionId: string;
      rootUserId: string;
      messages: unknown[];
      makeActive?: boolean;
    }) => {
      const host = getHost();
      if (!host) throw new Error("host unavailable");
      rejectNativeMutation(input?.sessionId, "revision save");
      return host.call("session.saveRevision", {
        sessionId: String(input?.sessionId || ""),
        rootUserId: String(input?.rootUserId || ""),
        messages: input?.messages ?? [],
        makeActive: input?.makeActive === true,
      });
    },
  );
  handle(
    IPC.invoke.sessionListRevisions,
    async (input: { sessionId: string; rootUserId: string }) => {
      const host = getHost();
      if (!host) throw new Error("host unavailable");
      rejectNativeMutation(input?.sessionId, "revision listing");
      return host.call("session.listRevisions", {
        sessionId: String(input?.sessionId || ""),
        rootUserId: String(input?.rootUserId || ""),
      });
    },
  );
  handle(
    IPC.invoke.sessionActivateRevision,
    async (input: {
      sessionId: string;
      rootUserId: string;
      revisionIndex: number;
      prefix?: unknown[];
    }) => {
      const currentHost = getHost();
      const sidecar = getSidecar();
      if (!currentHost) throw new Error("host unavailable");
      const sessionId = String(input?.sessionId || "");
      if (!sessionId) throw new Error("sessionId required");
      return runTranscriptRewrite(
        sessionId,
        "revision activation",
        currentHost,
        sidecar,
        () =>
          currentHost.call("session.activateRevision", {
            sessionId,
            rootUserId: String(input?.rootUserId || ""),
            revisionIndex: Number(input?.revisionIndex || 0),
            prefix: input?.prefix ?? [],
          }),
      );
    },
  );
  handle(IPC.invoke.sessionGetScratchPath, async (input: { sessionId: string }) => {
    const host = getHost();
    rejectNativeMutation(input?.sessionId, "scratch access");
    if (!host) throw new Error("host unavailable");
    return host.call<{ path: string }>("session.getScratchPath", {
      sessionId: String(input?.sessionId || ""),
    });
  });
  handle(IPC.invoke.sessionOpenScratchPath, async (input: { sessionId: string }) => {
    const host = getHost();
    rejectNativeMutation(input?.sessionId, "scratch access");
    if (!host) throw new Error("host unavailable");
    const sessionId = String(input?.sessionId || "").trim();
    const result = await host.call<{ path: string }>("session.getScratchPath", {
      sessionId,
    });
    const scratchPath = resolve(String(result?.path ?? ""));
    const scratchRoot = resolve(join(dataDir, "scratch"));
    const rel = relative(scratchRoot, scratchPath);
    if (!rel || rel.startsWith("..") || isAbsolute(rel)) {
      throw Object.assign(new Error("invalid session id"), {
        errorCode: ErrorCodes.INVALID_ARGUMENT,
      });
    }
    mkdirSync(scratchPath, { recursive: true });
    const openError = await shell.openPath(stripWinLongPrefix(scratchPath));
    if (openError) throw new Error(openError);
    return { ok: true, path: scratchPath };
  });
  handle(
    IPC.invoke.sessionConfigure,
    async (
      id: string,
      config: {
        mode: Mode;
        providerId?: string;
        modelId?: string;
        thinkingLevel?: SessionThinkingLevel;
        permissionMode?: "inherit" | "ask" | "accept-edits" | "auto";
      },
    ) => {
      const host = getHost();
      rejectNativeMutation(id, "configuration");
      if (!host) throw new Error("host unavailable");
      const result = await host.call<{ session?: RuntimeSession | null }>(
        "session.configure",
        { id, ...config },
      );
      if (!result.session) return result;
      const { providers, defaults } = await sessionCapabilityContext();
      const session = enrichSession(result.session, providers, defaults);
      if (
        config.providerId !== undefined ||
        config.modelId !== undefined ||
        config.thinkingLevel !== undefined
      ) {
        const modelKey =
          session.providerId && session.modelId
            ? `${session.providerId}/${session.modelId}`
            : null;
        plugins.broadcastEvent("session:modelChanged", [
          {
            sessionId: id,
            modelKey,
            thinkingLevel: session.thinkingLevel,
          },
        ]);
      }
      return { ...result, session };
    },
  );
}
