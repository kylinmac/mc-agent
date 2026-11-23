/**
 * mc-agent (R43): allowlisted 19-method RPC handler suite for Mobile Remote Access.
 *
 * Keeps all argument validation, image attachment materialization, diff collection,
 * and whiteboard/canvas operations modular and below architecture LOC caps.
 */
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { hostname as osHostname } from "node:os";
import { join, resolve } from "node:path";
import {
  IPC,
  MC_MOBILE_MAX_IMAGE_BYTES,
  MC_MOBILE_PROTOCOL_VERSION,
  isAllowedMobileMethod,
  sessionCanvasGroupId,
  type AgentPromptAttachment,
  type Canvas,
  type CanvasChange,
  type CanvasSummary,
  type CanvasWhiteboardScene,
  type MobileAttentionItem,
  type PendingInteractiveRequests,
  type SessionDetail,
  type SessionSummary,
} from "@pi-desktop/shared";
import { alchemyProposalDecisionOf, alchemyProposals } from "../mc-alchemy.ts";
import { projectProposalDecisionOf, projectProposals } from "../mc-project-create.ts";
import { asNonEmptyString, asRecord, rpcError, type HostLike, type RpcHandlerContext } from "./rpc-context.ts";
import { configureMobileSession, createMobileSession, effectiveSessionSettings, readSessionDefaults } from "./session-settings.ts";

type RawImageInput = {
  name?: unknown;
  mimeType?: unknown;
  dataBase64?: unknown;
};

const ALLOWED_IMAGE_MIMES: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
};

function requireHost(ctx: RpcHandlerContext): HostLike {
  const host = ctx.getHost();
  if (!host) throw rpcError("HOST_UNAVAILABLE", "Desktop host is unavailable.");
  return host;
}

async function projectGroupOf(
  host: HostLike,
  projectPath: string | null | undefined,
): Promise<{ id: string; roots: Array<{ path: string }> } | null> {
  if (!projectPath) return null;
  const { groups } = await host.call<{ groups: Array<{ id: string; roots: Array<{ path: string }> }> }>(
    "project.groups.list",
    {},
  );
  const wanted = resolve(projectPath);
  return (groups ?? []).find((g) => g.roots.some((r) => resolve(r.path) === wanted)) ?? null;
}

async function safePendingInteractive(
  ctx: RpcHandlerContext,
  sessionId: string,
): Promise<PendingInteractiveRequests> {
  try {
    const res = (await ctx.invoke(IPC.invoke.pendingInteractive, [{ sessionId }])) as
      | PendingInteractiveRequests
      | undefined;
    return {
      asks: Array.isArray(res?.asks) ? res.asks : [],
      permissions: Array.isArray(res?.permissions) ? res.permissions : [],
    };
  } catch {
    return { asks: [], permissions: [] };
  }
}

async function safePlansPending(ctx: RpcHandlerContext, sessionId?: string): Promise<unknown[]> {
  try {
    const res = (await ctx.invoke(IPC.invoke.plansPending, [
      sessionId ? { sessionId } : {},
    ])) as { plans?: unknown[]; proposals?: unknown[] } | unknown[];
    if (Array.isArray(res)) return res;
    if (Array.isArray(res?.plans)) return res.plans;
    if (Array.isArray(res?.proposals)) return res.proposals;
    return [];
  } catch {
    return [];
  }
}

async function resolveSessionCwd(
  ctx: RpcHandlerContext,
  sessionId?: string | null,
): Promise<string | null> {
  const host = requireHost(ctx);
  if (sessionId) {
    const detail = await host.call<{ session?: { projectPath?: string } | null }>("session.get", {
      id: sessionId,
      messageLimit: 1,
    });
    if (detail?.session?.projectPath) return detail.session.projectPath;
  }
  const res = await host.call<{ workspace: { path: string } | null }>("workspace.get", {});
  return res.workspace?.path ?? null;
}

async function resolveCanvasGroupId(
  ctx: RpcHandlerContext,
  input: Record<string, unknown>,
): Promise<string> {
  const explicit = asNonEmptyString(input.groupId, 200);
  if (explicit) return explicit;
  const sessionId = asNonEmptyString(input.sessionId, 128);
  if (!sessionId) throw rpcError("INVALID_ARGUMENT", "groupId or sessionId is required");
  const host = requireHost(ctx);
  const { session } = await host.call<{ session?: { projectPath?: string } | null }>("session.get", {
    id: sessionId,
    messageLimit: 1,
  });
  if (!session) throw rpcError("NOT_FOUND", `Session not found: ${sessionId}`);
  const group = await projectGroupOf(host, session.projectPath);
  return group ? group.id : sessionCanvasGroupId(sessionId);
}

async function materializeMobileImages(
  dataDir: string,
  sessionId: string,
  rawImages: unknown,
): Promise<AgentPromptAttachment[]> {
  if (!Array.isArray(rawImages) || rawImages.length === 0) return [];
  if (rawImages.length > 6) {
    throw rpcError("INVALID_ARGUMENT", "At most 6 images can be attached per message");
  }
  const scratchDir = join(dataDir, "scratch", sessionId);
  await mkdir(scratchDir, { recursive: true });
  const attachments: AgentPromptAttachment[] = [];

  for (const item of rawImages as RawImageInput[]) {
    const mime = asNonEmptyString(item?.mimeType, 64)?.toLowerCase() ?? "image/png";
    const ext = ALLOWED_IMAGE_MIMES[mime];
    if (!ext) throw rpcError("INVALID_ARGUMENT", `Unsupported image mimeType: ${mime}`);
    const b64 = asNonEmptyString(item?.dataBase64, 15_000_000);
    if (!b64) throw rpcError("INVALID_ARGUMENT", "Image dataBase64 is required");
    const bytes = Buffer.from(b64, "base64");
    if (bytes.length === 0 || bytes.length > MC_MOBILE_MAX_IMAGE_BYTES) {
      throw rpcError(
        "INVALID_ARGUMENT",
        `Image size must be between 1 byte and ${MC_MOBILE_MAX_IMAGE_BYTES} bytes`,
      );
    }
    const fileName = `mobile-${randomUUID()}.${ext}`;
    const fullPath = join(scratchDir, fileName);
    await writeFile(fullPath, bytes);
    const displayName = asNonEmptyString(item?.name, 120) ?? fileName;
    attachments.push({ kind: "image", path: fullPath, name: displayName, mimeType: mime });
  }
  return attachments;
}

async function handleAttentionList(ctx: RpcHandlerContext): Promise<{ items: MobileAttentionItem[] }> {
  const sessionsRes = (await ctx.invoke(IPC.invoke.sessionList, [])) as {
    sessions?: SessionSummary[];
  };
  const sessions = Array.isArray(sessionsRes?.sessions) ? sessionsRes.sessions : [];
  const sessionById = new Map(sessions.map((s) => [s.id, s]));
  const items: MobileAttentionItem[] = [];

  const checkSessionIds = new Set<string>([
    ...ctx.activeTurns.keys(),
    ...sessions.slice(0, 20).map((s) => s.id),
  ]);

  const [interactiveEntries, allPlans] = await Promise.all([
    Promise.all(
      [...checkSessionIds].map(async (sid) => ({
        sid,
        pending: await safePendingInteractive(ctx, sid),
      })),
    ),
    safePlansPending(ctx),
  ]);

  const metaFor = (sessionId: string) => {
    const s = sessionById.get(sessionId);
    const projectName = s?.projectPath
      ? s.projectPath.split(/[\\/]/).filter(Boolean).at(-1)
      : undefined;
    return { sessionTitle: s?.title || "Untitled session", projectName };
  };

  for (const { sid, pending } of interactiveEntries) {
    const meta = metaFor(sid);
    for (const perm of pending.permissions) {
      const rec = perm as unknown as Record<string, unknown>;
      const requestId = String(rec.requestId ?? rec.id ?? randomUUID());
      items.push({
        id: `perm:${requestId}`,
        kind: "permission",
        sessionId: sid,
        ...meta,
        summary: `Approve ${String(rec.toolName ?? rec.tool ?? "Tool")}`,
        createdAt: Date.now(),
        payload: rec,
      });
    }
    for (const ask of pending.asks) {
      const rec = ask as unknown as Record<string, unknown>;
      const requestId = String(rec.requestId ?? rec.id ?? randomUUID());
      const questions = Array.isArray(rec.questions) ? rec.questions : [];
      const firstQ =
        questions[0] && typeof questions[0] === "object"
          ? String((questions[0] as { question?: unknown }).question ?? "Question")
          : "Question awaiting response";
      items.push({
        id: `ask:${requestId}`,
        kind: "ask",
        sessionId: sid,
        ...meta,
        summary: firstQ.slice(0, 140),
        createdAt: Date.now(),
        payload: rec,
      });
    }
  }

  for (const plan of allPlans) {
    const rec = plan as Record<string, unknown>;
    const sid = String(rec.sessionId ?? "");
    if (!sid) continue;
    const proposalId = String(rec.proposalId ?? rec.id ?? randomUUID());
    items.push({
      id: `plan:${proposalId}`,
      kind: "plan",
      sessionId: sid,
      ...metaFor(sid),
      summary: String(rec.title ?? rec.summary ?? "Plan ready for approval").slice(0, 140),
      createdAt: Date.now(),
      payload: rec,
    });
  }

  for (const proposal of projectProposals.list()) {
    items.push({
      id: `project_proposal:${proposal.requestId}`,
      kind: "project_proposal",
      sessionId: proposal.sessionId,
      ...metaFor(proposal.sessionId),
      summary: `Create project: ${proposal.name}`,
      createdAt: Date.now(),
      payload: proposal as unknown as Record<string, unknown>,
    });
  }

  for (const proposal of alchemyProposals.list()) {
    items.push({
      id: `alchemy_proposal:${proposal.requestId}`,
      kind: "alchemy_proposal",
      sessionId: proposal.sessionId,
      ...metaFor(proposal.sessionId),
      summary: `Save ${proposal.kind}: ${proposal.name}`,
      createdAt: Date.now(),
      payload: proposal as unknown as Record<string, unknown>,
    });
  }

  for (const [sid, turnId] of ctx.activeTurns) {
    items.push({
      id: `running:${sid}`,
      kind: "running",
      sessionId: sid,
      ...metaFor(sid),
      summary: "Agent is running",
      createdAt: Date.now(),
      payload: { turnId },
    });
  }

  return { items };
}

export async function dispatchMobileRpc(
  ctx: RpcHandlerContext,
  connId: string,
  method: string,
  params: unknown,
): Promise<unknown> {
  if (!isAllowedMobileMethod(method)) {
    throw rpcError("FORBIDDEN", `Method not allowed over mobile bridge: ${method}`);
  }
  const input = asRecord(params);

  switch (method) {
    case "host.info": {
      const status = ctx.getGatewayStatus();
      return {
        hostname: status.hostname ?? ctx.hostname ?? osHostname(),
        appVersion: ctx.appVersion,
        platform: process.platform,
        protocolVersion: MC_MOBILE_PROTOCOL_VERSION,
        nodeId: status.nodeId ?? null,
        relay: status.relay ?? null,
        addrs: status.addrs,
      };
    }

    case "attention.list":
      return handleAttentionList(ctx);

    case "projects.list": {
      const host = requireHost(ctx);
      const [{ groups }, { workspace }] = await Promise.all([
        host.call<{ groups: unknown[] }>("project.groups.list", {}),
        host.call<{ workspace: { path: string; name?: string } | null }>("workspace.get", {}),
      ]);
      return { groups: Array.isArray(groups) ? groups : [], activeWorkspace: workspace ?? null };
    }

    case "sessions.list": {
      const raw = (await ctx.invoke(IPC.invoke.sessionList, [])) as { sessions?: SessionSummary[] };
      let sessions = Array.isArray(raw?.sessions) ? raw.sessions : [];
      const projectPath = asNonEmptyString(input.projectPath, 1024);
      if (projectPath) sessions = sessions.filter((s) => s.projectPath === projectPath);
      const limit =
        typeof input.limit === "number" && Number.isFinite(input.limit)
          ? Math.max(1, Math.min(200, Math.floor(input.limit)))
          : 100;
      return {
        sessions: sessions.slice(0, limit).map((s) => ({
          ...s,
          isRunning: ctx.activeTurns.has(s.id),
        })),
      };
    }

    case "session.create":
      return createMobileSession(ctx, params);

    case "models.list": {
      const [provRes, globalSettings] = await Promise.all([
        ctx.invoke(IPC.invoke.providersList, []) as Promise<{
          providers?: Array<{
            id?: string;
            name?: string;
            enabled?: boolean;
            defaultModelId?: string;
            supportsReasoning?: boolean;
            models?: Array<{ id?: string; alias?: string }>;
          }>;
        }>,
        readSessionDefaults(ctx.getHost()),
      ]);
      const rawProviders = Array.isArray(provRes?.providers) ? provRes.providers : [];
      const providers = rawProviders
        .filter((p) => p && typeof p.id === "string" && p.id.trim() && p.enabled !== false)
        .map((p) => {
          const seen = new Set<string>();
          const models: Array<{ id: string; alias?: string }> = [];
          for (const m of p.models ?? []) {
            const id = typeof m?.id === "string" ? m.id.trim() : "";
            if (!id || seen.has(id)) continue;
            seen.add(id);
            const alias = typeof m?.alias === "string" && m.alias.trim() ? m.alias.trim() : undefined;
            models.push(alias ? { id, alias } : { id });
          }
          const legacyId = typeof p.defaultModelId === "string" ? p.defaultModelId.trim() : "";
          if (models.length === 0 && legacyId) {
            models.push({ id: legacyId });
          }
          return {
            id: p.id!.trim(),
            name: (typeof p.name === "string" && p.name.trim()) || p.id!.trim(),
            supportsReasoning: Boolean(p.supportsReasoning),
            models,
          };
        })
        .filter((p) => p.models.length > 0);
      return {
        providers,
        defaultProviderId: globalSettings?.defaultProviderId ?? null,
        defaultModelId: globalSettings?.defaultModelId ?? null,
      };
    }

    case "session.configure":
      return configureMobileSession(ctx, params);

    case "session.history": {
      const sessionId = asNonEmptyString(input.sessionId, 128);
      if (!sessionId) throw rpcError("INVALID_ARGUMENT", "sessionId is required");
      const messageLimit =
        typeof input.messageLimit === "number" && Number.isFinite(input.messageLimit)
          ? Math.max(1, Math.min(500, Math.floor(input.messageLimit)))
          : 120;
      const [detailRes, pendingInteractive, plansRes, globalSettings] = await Promise.all([
        ctx.invoke(IPC.invoke.sessionGet, [{ id: sessionId, messageLimit }]) as Promise<{
          session?: SessionDetail | null;
        }>,
        safePendingInteractive(ctx, sessionId),
        safePlansPending(ctx, sessionId),
        readSessionDefaults(ctx.getHost()),
      ]);
      if (!detailRes?.session) throw rpcError("NOT_FOUND", `Session not found: ${sessionId}`);
      return {
        session: detailRes.session,
        ...effectiveSessionSettings(detailRes.session, globalSettings),
        isRunning: ctx.activeTurns.has(sessionId),
        activeTurnId: ctx.activeTurns.get(sessionId) ?? null,
        cursor: ctx.latestCursorFor(sessionId),
        pending: {
          permissions: pendingInteractive.permissions,
          asks: pendingInteractive.asks,
          plans: plansRes,
          projectProposals: projectProposals.list().filter((p) => p.sessionId === sessionId),
          alchemyProposals: alchemyProposals.list().filter((p) => p.sessionId === sessionId),
        },
      };
    }

    case "session.subscribe": {
      const sessionId = asNonEmptyString(input.sessionId, 128);
      if (!sessionId) throw rpcError("INVALID_ARGUMENT", "sessionId is required");
      const afterCursor =
        typeof input.afterCursor === "number" && Number.isFinite(input.afterCursor)
          ? Math.floor(input.afterCursor)
          : 0;
      return ctx.subscribeSession(connId, sessionId, afterCursor);
    }

    case "session.unsubscribe": {
      const sessionId = asNonEmptyString(input.sessionId, 128);
      if (!sessionId) throw rpcError("INVALID_ARGUMENT", "sessionId is required");
      ctx.unsubscribeSession(connId, sessionId);
      return { ok: true };
    }

    case "turn.send": {
      const sessionId = asNonEmptyString(input.sessionId, 128);
      if (!sessionId) throw rpcError("INVALID_ARGUMENT", "sessionId is required");
      const content = typeof input.content === "string" ? input.content : "";
      const mode = input.mode === "steer" || input.mode === "queue" ? input.mode : "send";
      const attachments = await materializeMobileImages(ctx.dataDir, sessionId, input.images);
      if (!content.trim() && attachments.length === 0) {
        throw rpcError("INVALID_ARGUMENT", "Message content or image attachment is required");
      }
      if (mode === "steer") {
        const expectedTurnId =
          asNonEmptyString(input.expectedTurnId, 128) ?? ctx.activeTurns.get(sessionId);
        if (!expectedTurnId) {
          throw rpcError("TURN_NOT_FOUND", "No active turn to steer in this session");
        }
        return ctx.invoke(IPC.invoke.agentSteer, [
          { sessionId, content, expectedTurnId, ...(attachments.length ? { attachments } : {}) },
        ]);
      }
      if (mode === "queue") {
        return ctx.invoke(IPC.invoke.agentQueuePush, [
          { sessionId, content, ...(attachments.length ? { attachments } : {}) },
        ]);
      }
      return ctx.invoke(IPC.invoke.agentPrompt, [
        { sessionId, content, ...(attachments.length ? { attachments } : {}) },
      ]);
    }

    case "turn.stop": {
      const sessionId = asNonEmptyString(input.sessionId, 128);
      if (!sessionId) throw rpcError("INVALID_ARGUMENT", "sessionId is required");
      const turnId = asNonEmptyString(input.turnId, 128) ?? ctx.activeTurns.get(sessionId);
      if (input.force === true) return ctx.invoke(IPC.invoke.agentAbort, [sessionId]);
      return ctx.invoke(IPC.invoke.agentStop, [{ sessionId, ...(turnId ? { turnId } : {}) }]);
    }

    case "approval.respond": {
      if (input.kind === "plan") {
        const proposalId = asNonEmptyString(input.proposalId, 128);
        const sessionId = asNonEmptyString(input.sessionId, 128);
        const turnId = asNonEmptyString(input.turnId, 128);
        const toolCallId = asNonEmptyString(input.toolCallId, 128);
        const action = input.action === "approve" || input.action === "reject" ? input.action : null;
        if (!proposalId || !sessionId || !turnId || !toolCallId || !action) {
          throw rpcError("INVALID_ARGUMENT", "Invalid plan approval payload");
        }
        return ctx.invoke(IPC.invoke.plansResolve, [
          {
            proposalId,
            sessionId,
            turnId,
            toolCallId,
            action,
            ...(typeof input.version === "number" ? { version: input.version } : {}),
            ...(action === "approve"
              ? {
                  targetPermissionMode:
                    asNonEmptyString(input.targetPermissionMode, 40) ?? "accept-edits",
                }
              : {}),
          },
        ]);
      }
      const requestId = asNonEmptyString(input.requestId, 128);
      const decision = asNonEmptyString(input.decision, 40);
      if (
        !requestId ||
        (decision !== "allow-once" && decision !== "allow-session" && decision !== "deny")
      ) {
        throw rpcError("INVALID_ARGUMENT", "requestId and valid decision are required");
      }
      return ctx.invoke(IPC.invoke.toolResolvePermission, [{ requestId, decision }]);
    }

    case "ask.respond": {
      const sessionId = asNonEmptyString(input.sessionId, 128);
      const requestId = asNonEmptyString(input.requestId, 128);
      if (!sessionId || !requestId) {
        throw rpcError("INVALID_ARGUMENT", "sessionId and requestId are required");
      }
      return ctx.invoke(IPC.invoke.askToolResolve, [
        {
          sessionId,
          requestId,
          ...(input.answers && typeof input.answers === "object" ? { answers: input.answers } : {}),
          ...(input.cancelled === true ? { cancelled: true } : {}),
        },
      ]);
    }

    case "proposal.respond": {
      const kind = input.kind === "project" ? "project" : input.kind === "alchemy" ? "alchemy" : null;
      const requestId = asNonEmptyString(input.requestId, 128);
      if (!kind || !requestId) {
        throw rpcError("INVALID_ARGUMENT", "kind (project|alchemy) and requestId are required");
      }
      if (kind === "project") {
        return { ok: projectProposals.resolve(requestId, projectProposalDecisionOf(input.decision)) };
      }
      return { ok: alchemyProposals.resolve(requestId, alchemyProposalDecisionOf(input.decision)) };
    }

    case "diff.summary": {
      const cwd = await resolveSessionCwd(ctx, asNonEmptyString(input.sessionId, 128));
      if (!cwd) return { repo: false, clean: true, files: [] };
      const diff = await ctx.collectDiff(cwd);
      return {
        repo: diff.repo,
        clean: diff.clean,
        files: diff.files.map((f) => ({
          path: f.path,
          oldPath: f.oldPath,
          status: f.status,
          additions: f.additions,
          deletions: f.deletions,
          binary: f.binary,
        })),
      };
    }

    case "diff.file": {
      const path = asNonEmptyString(input.path, 1024);
      if (!path) throw rpcError("INVALID_ARGUMENT", "path is required");
      const cwd = await resolveSessionCwd(ctx, asNonEmptyString(input.sessionId, 128));
      if (!cwd) throw rpcError("NOT_FOUND", "Workspace has no active folder");
      const diff = await ctx.collectDiff(cwd);
      const file = diff.files.find((f) => f.path === path);
      if (!file) throw rpcError("NOT_FOUND", `Diff entry not found: ${path}`);
      return { file };
    }

    case "canvas.list": {
      const host = requireHost(ctx);
      const groupId = await resolveCanvasGroupId(ctx, input);
      const { canvases } = await host.call<{ canvases: CanvasSummary[] }>("canvas.list", { groupId });
      return { groupId, canvases };
    }

    case "canvas.get": {
      const host = requireHost(ctx);
      const groupId = await resolveCanvasGroupId(ctx, input);
      const canvasId = asNonEmptyString(input.canvasId, 80);
      if (!canvasId) throw rpcError("INVALID_ARGUMENT", "canvasId is required");
      const { canvas } = await host.call<{ canvas: Canvas }>("canvas.get", { groupId, canvasId });
      if (canvas.kind !== "whiteboard") return { groupId, canvas, whiteboard: null };
      const loaded = await host.call<{
        canvas: Canvas;
        scene: CanvasWhiteboardScene;
        files?: Record<string, unknown> | null;
        hasPreview: boolean;
      }>("canvas.whiteboard.get", {
        groupId,
        canvasId,
        includeFiles: input.includeFiles !== false,
      });
      return {
        groupId,
        canvas: loaded.canvas,
        scene: loaded.scene,
        files: loaded.files ?? {},
        hasPreview: loaded.hasPreview,
      };
    }

    case "canvas.createWhiteboard": {
      const host = requireHost(ctx);
      const groupId = await resolveCanvasGroupId(ctx, input);
      const title = asNonEmptyString(input.title, 120) ?? "Mobile Sketch";
      const created = await host.call<{ canvas: Canvas }>("canvas.create", {
        groupId,
        title,
        kind: "whiteboard",
      });
      const change: CanvasChange = { groupId, canvasId: created.canvas.id };
      ctx.sendToRenderer(IPC.event.canvasChanged, change);
      ctx.pushGatewayEvent("canvas.changed", change);
      return { groupId, canvas: created.canvas };
    }

    case "canvas.saveWhiteboard": {
      const host = requireHost(ctx);
      const groupId = await resolveCanvasGroupId(ctx, input);
      const canvasId = asNonEmptyString(input.canvasId, 80);
      if (!canvasId) throw rpcError("INVALID_ARGUMENT", "canvasId is required");
      if (!input.scene || typeof input.scene !== "object") {
        throw rpcError("INVALID_ARGUMENT", "scene is required");
      }
      const rawFiles =
        input.upsertedFiles && typeof input.upsertedFiles === "object"
          ? input.upsertedFiles
          : input.files && typeof input.files === "object"
            ? input.files
            : undefined;
      const rawPreview = asNonEmptyString(
        input.previewPngBase64 ?? input.previewBase64,
        15_000_000,
      );
      let previewPngBase64: string | undefined;
      if (rawPreview) {
        const bytes = Buffer.from(rawPreview, "base64");
        if (bytes.length > 0 && bytes.length <= MC_MOBILE_MAX_IMAGE_BYTES) {
          previewPngBase64 = rawPreview;
        }
      }
      const saved = await host.call<{ canvas: Canvas }>("canvas.whiteboard.save", {
        groupId,
        canvasId,
        scene: input.scene,
        ...(rawFiles ? { upsertedFiles: rawFiles } : {}),
        ...(typeof input.baseVersion === "number" ? { baseVersion: input.baseVersion } : {}),
        ...(previewPngBase64 !== undefined ? { previewPngBase64 } : {}),
      });
      const change: CanvasChange = { groupId, canvasId };
      ctx.sendToRenderer(IPC.event.canvasChanged, change);
      ctx.pushGatewayEvent("canvas.changed", change);
      return { groupId, canvas: saved.canvas };
    }

    case "canvas.delete": {
      const host = requireHost(ctx);
      const groupId = await resolveCanvasGroupId(ctx, input);
      const canvasId = asNonEmptyString(input.canvasId, 80);
      if (!canvasId) throw rpcError("INVALID_ARGUMENT", "canvasId is required");
      await host.call("canvas.delete", { groupId, canvasId });
      const change: CanvasChange = { groupId, canvasId };
      ctx.sendToRenderer(IPC.event.canvasChanged, change);
      ctx.pushGatewayEvent("canvas.changed", change);
      return { ok: true, groupId, canvasId };
    }
  }
}
