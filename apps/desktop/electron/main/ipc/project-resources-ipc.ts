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
}
