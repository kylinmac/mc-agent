import { ErrorCodes, IPC } from "@pi-desktop/shared";
import type { HostProcess } from "../host-process";
import type { IpcRegistrar } from "./types";

/**
 * mc-agent resource directories (MC-ADR-0003). host-core owns the directory
 * layout, the templates and the group record; Main only validates the request
 * shape and refreshes its project-group snapshot after a change.
 */
export type ProjectResourcesIpcDependencies = {
  registrar: IpcRegistrar;
  getHost: () => HostProcess | null;
  /** Re-reads the group snapshot Main answers plugin workspace queries from. */
  refreshProjectGroups: (host: HostProcess) => Promise<unknown>;
  /** `shell.openPath`; resolves to an error message, empty on success. */
  openPath: (path: string) => Promise<string>;
  /** Opens an http(s) URL in the user's browser. */
  openExternal: (url: string) => Promise<void>;
  /** Native single-file picker; `null` when the user cancels. */
  pickFile: (defaultPath?: string) => Promise<string | null>;
};

const MAX_GROUP_ID_LENGTH = 256;
const MAX_TEMPLATE_NAME_LENGTH = 128;
const MAX_PATH_LENGTH = 4096;
// host-core bounds descriptions by characters; this only stops oversized payloads.
const MAX_DESCRIPTION_LENGTH = 8192;

function groupIdOf(input: { groupId?: unknown } | undefined): string {
  const groupId = typeof input?.groupId === "string" ? input.groupId.trim() : "";
  if (!groupId || groupId.length > MAX_GROUP_ID_LENGTH) {
    throw invalid("project group id required");
  }
  return groupId;
}

function invalid(message: string): Error {
  return Object.assign(new Error(message), { errorCode: ErrorCodes.INVALID_ARGUMENT });
}

export function registerProjectResourcesIpc({
  registrar,
  getHost,
  refreshProjectGroups,
  openPath,
  openExternal,
  pickFile,
}: ProjectResourcesIpcDependencies): void {
  registrar.handle(IPC.invoke.projectResourcesTemplates, async () => {
    const host = getHost();
    if (!host) throw new Error("host unavailable");
    return host.call("project.resources.templates", {});
  });

  registrar.handle(
    IPC.invoke.projectResourcesEnsure,
    async (input: { groupId?: unknown; template?: unknown } = {}) => {
      const host = getHost();
      if (!host) throw new Error("host unavailable");
      const groupId = groupIdOf(input);
      let template: string | undefined;
      if (input?.template !== undefined) {
        if (typeof input.template !== "string") throw invalid("template must be a string");
        template = input.template.trim();
        if (!template || template.length > MAX_TEMPLATE_NAME_LENGTH) {
          throw invalid("template name is invalid");
        }
      }
      const result = await host.call("project.resources.ensure", {
        groupId,
        ...(template ? { template } : {}),
      });
      void refreshProjectGroups(host);
      return result;
    },
  );

  // The renderer names a project, never a path: Main opens only the resource
  // folder host-core has on record for that project.
  registrar.handle(
    IPC.invoke.projectResourcesReveal,
    async (input: { groupId?: unknown } = {}) => {
      const host = getHost();
      if (!host) throw new Error("host unavailable");
      const groupId = groupIdOf(input);
      const { groups } = (await host.call("project.groups.list", {})) as {
        groups?: Array<{ id: string; roots?: Array<{ path: string; kind?: string }> }>;
      };
      const folder = groups
        ?.find((group) => group.id === groupId)
        ?.roots?.find((root) => root.kind === "resources")?.path;
      if (!folder) throw invalid("project has no resource folder");
      const failure = await openPath(folder);
      if (failure) throw new Error(failure);
      return { ok: true };
    },
  );

  registrar.handle(
    IPC.invoke.projectWorkspaceNotes,
    async (input: { groupId?: unknown } = {}) => {
      const host = getHost();
      if (!host) throw new Error("host unavailable");
      return host.call("project.workspaces.notes", { groupId: groupIdOf(input) });
    },
  );

  registrar.handle(
    IPC.invoke.projectWorkspaceNoteSet,
    async (input: { groupId?: unknown; path?: unknown; description?: unknown } = {}) => {
      const host = getHost();
      if (!host) throw new Error("host unavailable");
      const groupId = groupIdOf(input);
      const path = typeof input?.path === "string" ? input.path.trim() : "";
      if (!path || path.length > MAX_PATH_LENGTH) throw invalid("workspace path required");
      if (typeof input?.description !== "string" || input.description.length > MAX_DESCRIPTION_LENGTH) {
        throw invalid("workspace description required");
      }
      return host.call("project.workspaces.setNote", {
        groupId,
        path,
        description: input.description,
      });
    },
  );

  // R2/R3/R4 resource catalog. host-core resolves every key against the
  // project's own folders; Main validates shapes and performs the open.
  const catalog = (method: string, params: Record<string, unknown>) => {
    const host = getHost();
    if (!host) throw new Error("host unavailable");
    return host.call(`project.resources.catalog.${method}`, params);
  };
  const keyOf = (input: { key?: unknown } | undefined): string => {
    const key = typeof input?.key === "string" ? input.key.trim() : "";
    if (!key || key.length > MAX_PATH_LENGTH) throw invalid("resource key required");
    return key;
  };
  const categoryOf = (input: { category?: unknown } | undefined): string =>
    typeof input?.category === "string" ? input.category.trim().slice(0, 80) : "";
  const titleOf = (input: { title?: unknown } | undefined): string | undefined =>
    typeof input?.title === "string" && input.title.trim() ? input.title.trim().slice(0, 200) : undefined;

  registrar.handle(IPC.invoke.projectResourcesList, async (input: { groupId?: unknown } = {}) =>
    catalog("list", { groupId: groupIdOf(input) }),
  );

  registrar.handle(
    IPC.invoke.projectResourcesSetStatus,
    async (input: { groupId?: unknown; key?: unknown; status?: unknown } = {}) => {
      if (input?.status !== "draft" && input?.status !== "confirmed" && input?.status !== "deprecated") {
        throw invalid("status must be draft, confirmed or deprecated");
      }
      return catalog("setStatus", { groupId: groupIdOf(input), key: keyOf(input), status: input.status });
    },
  );

  registrar.handle(
    IPC.invoke.projectResourcesRegisterUrl,
    async (input: { groupId?: unknown; url?: unknown; category?: unknown; title?: unknown } = {}) => {
      const url = typeof input?.url === "string" ? input.url.trim() : "";
      if (!/^https?:\/\//i.test(url) || url.length > 2048) throw invalid("an http(s) link is required");
      const title = titleOf(input);
      return catalog("registerUrl", {
        groupId: groupIdOf(input), url, category: categoryOf(input), ...(title ? { title } : {}),
      });
    },
  );

  // The file comes from the native picker, never from the renderer; host-core
  // still refuses anything outside the project's workspaces.
  registrar.handle(
    IPC.invoke.projectResourcesRegisterFile,
    async (input: { groupId?: unknown; category?: unknown; defaultPath?: unknown } = {}) => {
      const groupId = groupIdOf(input);
      const defaultPath =
        typeof input?.defaultPath === "string" && input.defaultPath.length <= MAX_PATH_LENGTH
          ? input.defaultPath
          : undefined;
      const path = await pickFile(defaultPath);
      if (!path) return { canceled: true };
      return catalog("registerFile", { groupId, path, category: categoryOf(input) });
    },
  );

  registrar.handle(
    IPC.invoke.projectResourcesUnregister,
    async (input: { groupId?: unknown; key?: unknown } = {}) =>
      catalog("unregister", { groupId: groupIdOf(input), key: keyOf(input) }),
  );

  registrar.handle(
    IPC.invoke.projectResourcesOpen,
    async (input: { groupId?: unknown; key?: unknown } = {}) => {
      const target = (await catalog("locate", { groupId: groupIdOf(input), key: keyOf(input) })) as {
        path?: string;
        url?: string;
      };
      if (target.url) {
        if (!/^https?:\/\//i.test(target.url)) throw invalid("only http(s) links can be opened");
        await openExternal(target.url);
        return { ok: true };
      }
      if (!target.path) throw invalid("resource not found");
      const failure = await openPath(target.path);
      if (failure) throw new Error(failure);
      return { ok: true };
    },
  );

  registrar.handle(IPC.invoke.projectGoalGet, async (input: { groupId?: unknown } = {}) =>
    catalog("goal", { groupId: groupIdOf(input) }),
  );

  registrar.handle(
    IPC.invoke.projectGoalSet,
    async (input: { groupId?: unknown; goal?: unknown } = {}) => {
      if (typeof input?.goal !== "string" || input.goal.length > MAX_DESCRIPTION_LENGTH) {
        throw invalid("project goal required");
      }
      return catalog("setGoal", { groupId: groupIdOf(input), goal: input.goal });
    },
  );

  // R6–R9 project tasks: one channel, an allowlisted operation, and only the
  // fields host-core reads. host-core owns validation and state.
  registrar.handle(
    IPC.invoke.projectTasksCall,
    async (input: { groupId?: unknown; operation?: unknown; params?: unknown } = {}) => {
      const operation = typeof input?.operation === "string" ? input.operation : "";
      if (!TASK_OPERATIONS.has(operation)) throw invalid("unknown task operation");
      const raw = (input?.params && typeof input.params === "object" ? input.params : {}) as Record<string, unknown>;
      const params: Record<string, unknown> = { groupId: groupIdOf(input) };
      for (const key of TASK_PARAM_KEYS) {
        if (raw[key] !== undefined) params[key] = raw[key];
      }
      const host = getHost();
      if (!host) throw new Error("host unavailable");
      return host.call(`project.tasks.${operation}`, params);
    },
  );
}

const TASK_OPERATIONS = new Set([
  "list",
  "create",
  "update",
  "cancel",
  "reopen",
  "preflight",
  "startRun",
  "review",
]);
const TASK_PARAM_KEYS = ["taskId", "revision", "task", "sessionId", "startFolder", "verdict", "note"] as const;
