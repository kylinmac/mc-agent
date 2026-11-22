import {
  IPC, PERMISSION_MODES, SESSION_MODES, SESSION_THINKING_LEVELS,
  isGlobalPermissionMode, normalizeGlobalPermissionMode,
  type AppSettings, type SessionDetail,
} from "@pi-desktop/shared";
import { asNonEmptyString, rpcError, type HostLike, type RpcHandlerContext } from "./rpc-context.ts";

type Input = Record<string, unknown>;
type Commands = Pick<RpcHandlerContext, "invoke" | "sendToRenderer">;
type SessionDefaults = Pick<AppSettings, "defaultPermissionMode" | "defaultProviderId" | "defaultModelId">;

export async function readSessionDefaults(host: HostLike | null): Promise<SessionDefaults | undefined> {
  return host?.call<SessionDefaults>("settings.get", {}).catch(() => undefined);
}

export function effectiveSessionSettings(session: SessionDetail, defaults: SessionDefaults | undefined) {
  // If settings are unavailable the phone can still show the conversation
  // and its stored "inherit" selection, without displaying a guessed policy.
  const permission = isGlobalPermissionMode(session.permissionMode)
    ? session.permissionMode
    : defaults && normalizeGlobalPermissionMode(defaults.defaultPermissionMode);
  return {
    ...(permission && { effectivePermissionMode: permission }),
    effectiveProviderId: session.providerId || defaults?.defaultProviderId || null,
    effectiveModelId: session.modelId || defaults?.defaultModelId || null,
  };
}

function sessionInput(raw: unknown): Input {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw rpcError("INVALID_ARGUMENT", "Session options must be an object");
  }
  return raw as Input;
}

function optionalText(input: Input, key: string, maxLength: number): string | undefined {
  if (input[key] === undefined) return undefined;
  const value = asNonEmptyString(input[key], maxLength);
  if (!value) throw rpcError("INVALID_ARGUMENT", `Invalid ${key}`);
  return value;
}

function selection<T extends string>(input: Input, key: string, choices: readonly T[]): T | undefined {
  const value = optionalText(input, key, 32);
  if (value === undefined) return undefined;
  const selected = choices.find((choice) => choice === value);
  if (selected === undefined) throw rpcError("INVALID_ARGUMENT", `Invalid ${key}: ${value}`);
  return selected;
}

export function createMobileSession(ctx: Pick<Commands, "invoke">, raw: unknown): Promise<unknown> {
  const input = sessionInput(raw);
  const mode = asNonEmptyString(input.mode, 32) === "chat" ? "plan" : selection(input, "mode", SESSION_MODES);
  const permissionMode = selection(input, "permissionMode", PERMISSION_MODES);
  const projectPath = optionalText(input, "projectPath", 1024);
  const title = optionalText(input, "title", 200);
  // Only the mobile create fields cross this boundary. A phone cannot select
  // a worker's permission parent, an isolated worktree or a model at creation.
  return ctx.invoke(permissionMode ? IPC.invoke.sessionCreateConfigured : IPC.invoke.sessionCreate, [{
    ...(projectPath && { projectPath }),
    ...(title && { title }),
    ...(mode && { mode }),
    ...(permissionMode && { permissionMode }),
  }]);
}

export async function configureMobileSession(ctx: Commands, raw: unknown): Promise<unknown> {
  const input = sessionInput(raw);
  const sessionId = asNonEmptyString(input.sessionId, 128);
  if (!sessionId) throw rpcError("INVALID_ARGUMENT", "sessionId is required");
  const mode = selection(input, "mode", SESSION_MODES);
  const permissionMode = selection(input, "permissionMode", PERMISSION_MODES);
  const thinkingLevel = selection(input, "thinkingLevel", SESSION_THINKING_LEVELS);
  const providerId = optionalText(input, "providerId", 128);
  const modelId = optionalText(input, "modelId", 256);
  if (Boolean(providerId) !== Boolean(modelId)) {
    throw rpcError("INVALID_ARGUMENT", "providerId and modelId must be provided together");
  }
  if (!permissionMode && !mode && !modelId && !thinkingLevel) {
    throw rpcError("INVALID_ARGUMENT", "At least one session configuration field is required");
  }
  const existing = await ctx.invoke(IPC.invoke.sessionGet, [
    { id: sessionId, messageLimit: 1 },
  ]) as { session?: SessionDetail | null };
  if (!existing?.session) throw rpcError("NOT_FOUND", `Session not found: ${sessionId}`);
  const result = await ctx.invoke(IPC.invoke.sessionConfigure, [sessionId, {
    mode: mode ?? existing.session.mode ?? "agent",
    ...(permissionMode && { permissionMode }),
    ...(providerId && modelId && { providerId, modelId }),
    ...(thinkingLevel && { thinkingLevel }),
  }]);
  ctx.sendToRenderer(IPC.event.sessionsChanged, { reason: "mobile-configure" });
  return result;
}
