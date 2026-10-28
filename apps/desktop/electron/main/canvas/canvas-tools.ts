import { resolve } from "node:path";
import {
  CANVAS_GUIDE,
  type Canvas,
  type CanvasApplied,
  type CanvasChange,
  type CanvasComments,
  type CanvasSummary,
  type CanvasThread,
} from "@pi-desktop/shared";
import type { LocalToolHandler } from "../agent-sidecar";

/**
 * mc-agent prototype canvas: the agent's tools (docs/mc-agent/prototype-canvas.md).
 * Host-local like `SaveCreativeAsset`: host-core authorizes the call, this
 * module performs it through host-core's `canvas.*` methods for the project
 * the conversation works in, acting for the conversation (`agent…` methods),
 * so the agent can only answer comment threads sent to it. The first result
 * a conversation gets in the project also carries the drawing guide.
 */

type Host = { call<T>(method: string, params?: unknown): Promise<T> };
type GroupRecord = { id: string; roots: Array<{ path: string }> };

const listeners = new Set<(change: CanvasChange) => void>();

/** A canvas or its comments changed outside the renderer. */
export function onCanvasChanged(listener: (change: CanvasChange) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function emit(change: CanvasChange): void {
  for (const listener of listeners) listener(change);
}

/** The project a conversation's folder belongs to, a folder-only one included. */
export async function projectGroupOf(host: Host, projectPath: string | null | undefined): Promise<GroupRecord | null> {
  if (!projectPath) return null;
  const { groups } = await host.call<{ groups: GroupRecord[] }>("project.groups.list");
  const wanted = resolve(projectPath);
  return groups.find((candidate) => candidate.roots.some((root) => resolve(root.path) === wanted)) ?? null;
}

type ToolResult = Awaited<ReturnType<LocalToolHandler>>;

function fail(errorCode: string, message: string): ToolResult {
  return { ok: false, isError: true, errorCode, content: { kind: "canvas-error", errorCode, message } };
}

function done(content: Record<string, unknown>): ToolResult {
  return { ok: true, isError: false, content: { kind: "canvas", ...content } };
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function str(value: unknown, max = 200): string | undefined {
  return typeof value === "string" && value.trim() && value.length <= max ? value.trim() : undefined;
}

/** What the agent is shown of a thread: whether it may answer it, and where it is. */
function threadForAgent(thread: CanvasThread, sessionId: string) {
  return {
    id: thread.id,
    status: thread.status,
    sentToYou: thread.agentSession === sessionId,
    anchor: {
      kind: thread.anchor.kind,
      boardId: thread.anchor.boardId,
      mcId: thread.anchor.mcId,
      label: thread.anchor.label,
      address: thread.located.node?.address ?? thread.anchor.address,
      found: thread.located.state,
    },
    messages: thread.messages.map((message) => ({ author: message.author, text: message.text })),
  };
}

export function createCanvasTools(getHost: () => Host | null) {
  type Context = { ok: false; result: ToolResult } | { ok: true; host: Host; group: GroupRecord };
  const context = async (sessionId: string): Promise<Context> => {
    const host = getHost();
    if (!host) return { ok: false, result: fail("HOST_UNAVAILABLE", "Host unavailable.") };
    const { session } = await host.call<{ session?: { projectPath?: string } }>("session.get", { id: sessionId });
    const group = await projectGroupOf(host, session?.projectPath);
    if (!group)
      return {
        ok: false,
        result: fail("NOT_IN_PROJECT", "This conversation is not in a project, so it has no canvas."),
      };
    return { ok: true, host, group };
  };

  /** `CanvasRead`: the canvases, or one canvas with chosen artboard sources and its comments. */
  const read: LocalToolHandler = async ({ sessionId, args }) => {
    const found = await context(sessionId);
    if (!found.ok) return found.result;
    const { host, group } = found;
    const input = (args ?? {}) as { canvasId?: unknown; boards?: unknown; comments?: unknown };
    try {
      const canvasId = str(input.canvasId, 40);
      if (!canvasId) {
        const { canvases } = await host.call<{ canvases: CanvasSummary[] }>("canvas.list", { groupId: group.id });
        return done({ canvases });
      }
      const boards =
        input.boards === "all"
          ? { html: true }
          : Array.isArray(input.boards)
            ? { boards: input.boards.filter((board): board is string => typeof board === "string").slice(0, 50) }
            : {};
      const { canvas, html } = await host.call<{ canvas: Canvas; html: Record<string, string> | null }>(
        "canvas.get",
        { groupId: group.id, canvasId, ...boards },
      );
      const result: Record<string, unknown> = { canvas, html: html ?? undefined };
      if (input.comments !== false) {
        const { comments } = await host.call<{ comments: CanvasComments }>("canvas.comments.list", {
          groupId: group.id,
          canvasId,
        });
        result.comments = comments.threads.map((thread) => threadForAgent(thread, sessionId));
      }
      return done(result);
    } catch (error) {
      return fail("CANVAS_READ_FAILED", errorText(error));
    }
  };

  /** `CanvasWrite`: create a canvas and/or apply a batch of element operations. */
  const write: LocalToolHandler = async ({ sessionId, args }) => {
    const found = await context(sessionId);
    if (!found.ok) return found.result;
    const { host, group } = found;
    const input = (args ?? {}) as { canvasId?: unknown; title?: unknown; baseVersion?: unknown; ops?: unknown };
    const ops = Array.isArray(input.ops) ? input.ops : [];
    try {
      let canvasId = str(input.canvasId, 40);
      let baseVersion = typeof input.baseVersion === "number" ? input.baseVersion : undefined;
      let created = false;
      if (!canvasId) {
        const title = str(input.title);
        if (!title) return fail("INVALID_ARGUMENT", "Give canvasId to change a canvas, or title to create one.");
        const { canvas } = await host.call<{ canvas: Canvas }>("canvas.create", { groupId: group.id, title });
        canvasId = canvas.id;
        baseVersion = canvas.version;
        created = true;
      }
      if (baseVersion === undefined)
        return fail("INVALID_ARGUMENT", "baseVersion is required: read the canvas first and pass its version.");
      if (!ops.length) {
        if (created) emit({ groupId: group.id, canvasId, sessionId });
        const { canvas } = await host.call<{ canvas: Canvas }>("canvas.get", { groupId: group.id, canvasId });
        return done({ canvasId, version: canvas.version, created });
      }
      const applied = await host.call<CanvasApplied>("canvas.agentApply", {
        groupId: group.id,
        canvasId,
        baseVersion,
        ops,
        sessionId,
      });
      emit({ groupId: group.id, canvasId, sessionId });
      return done({
        canvasId,
        created,
        version: applied.canvas.version,
        added: applied.added,
        warnings: applied.warnings,
        elements: applied.canvas.elements.map(({ id, type, x, y, w, h, title }) => ({ id, type, x, y, w, h, title })),
      });
    } catch (error) {
      return fail("CANVAS_WRITE_FAILED", errorText(error));
    }
  };

  /** `CanvasComment`: answer, resolve or reopen a thread sent to this conversation, or start one. */
  const comment: LocalToolHandler = async ({ sessionId, args }) => {
    const found = await context(sessionId);
    if (!found.ok) return found.result;
    const { host, group } = found;
    const input = (args ?? {}) as {
      canvasId?: unknown;
      action?: unknown;
      threadId?: unknown;
      text?: unknown;
      resolve?: unknown;
      boardId?: unknown;
      mcId?: unknown;
      x?: unknown;
      y?: unknown;
    };
    const canvasId = str(input.canvasId, 40);
    if (!canvasId) return fail("INVALID_ARGUMENT", "canvasId is required.");
    const base = { groupId: group.id, canvasId, sessionId };
    const text = typeof input.text === "string" ? input.text : "";
    const threadId = str(input.threadId, 40);
    try {
      let comments: CanvasComments;
      let startedId: string | undefined;
      switch (input.action) {
        case "reply": {
          if (!threadId) return fail("INVALID_ARGUMENT", "threadId is required.");
          ({ comments } = await host.call<{ comments: CanvasComments }>("canvas.comments.agentReply", {
            ...base,
            threadId,
            text,
          }));
          if (input.resolve === true)
            ({ comments } = await host.call<{ comments: CanvasComments }>("canvas.comments.agentSetStatus", {
              ...base,
              threadId,
              status: "resolved",
            }));
          break;
        }
        case "resolve":
        case "reopen": {
          if (!threadId) return fail("INVALID_ARGUMENT", "threadId is required.");
          ({ comments } = await host.call<{ comments: CanvasComments }>("canvas.comments.agentSetStatus", {
            ...base,
            threadId,
            status: input.action === "resolve" ? "resolved" : "open",
          }));
          break;
        }
        case "add": {
          const boardId = str(input.boardId, 40);
          const mcId = str(input.mcId, 40);
          const anchor = {
            kind: mcId ? "element" : boardId ? "board" : "canvas",
            ...(boardId ? { boardId } : {}),
            ...(mcId ? { mcId } : {}),
            x: typeof input.x === "number" ? input.x : 0,
            y: typeof input.y === "number" ? input.y : 0,
          };
          const added = await host.call<{ threadId: string; comments: CanvasComments }>(
            "canvas.comments.agentAdd",
            { ...base, anchor, text },
          );
          comments = added.comments;
          startedId = added.threadId;
          break;
        }
        default:
          return fail("INVALID_ARGUMENT", "action is reply, resolve, reopen or add.");
      }
      emit({ groupId: group.id, canvasId, sessionId });
      const thread = comments.threads.find((candidate) => candidate.id === (startedId ?? threadId));
      return done({ thread: thread ? threadForAgent(thread, sessionId) : undefined });
    } catch (error) {
      return fail("CANVAS_COMMENT_FAILED", errorText(error));
    }
  };

  /** Conversations that were handed the guide since the app started. */
  const guided = new Set<string>();
  const guide =
    (handler: LocalToolHandler): LocalToolHandler =>
    async (call) => {
      const result = await handler(call);
      const content = result.content as { kind?: string; errorCode?: string } | undefined;
      const reached = content?.errorCode !== "NOT_IN_PROJECT" && content?.errorCode !== "HOST_UNAVAILABLE";
      const asked = (call.args as { guide?: unknown } | undefined)?.guide === true;
      if (!content || !reached || (guided.has(call.sessionId) && !asked)) return result;
      guided.add(call.sessionId);
      return { ...result, content: { ...content, guide: CANVAS_GUIDE } };
    };

  return { read: guide(read), write: guide(write), comment: guide(comment) };
}
