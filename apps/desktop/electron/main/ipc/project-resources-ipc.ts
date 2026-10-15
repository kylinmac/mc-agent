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
};

const MAX_GROUP_ID_LENGTH = 256;
const MAX_TEMPLATE_NAME_LENGTH = 128;

function invalid(message: string): Error {
  return Object.assign(new Error(message), { errorCode: ErrorCodes.INVALID_ARGUMENT });
}

export function registerProjectResourcesIpc({
  registrar,
  getHost,
  refreshProjectGroups,
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
      const groupId = typeof input?.groupId === "string" ? input.groupId.trim() : "";
      if (!groupId || groupId.length > MAX_GROUP_ID_LENGTH) {
        throw invalid("project group id required");
      }
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
}
