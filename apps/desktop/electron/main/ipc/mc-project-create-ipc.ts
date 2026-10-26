import {
  ErrorCodes,
  IPC,
  isValidProjectFolderName,
  PROJECT_PROPOSAL_PATH_MAX,
} from "@pi-desktop/shared";
import { isAbsolute } from "node:path";
import type { HostProcess } from "../host-process";
import {
  checkProjectLocation,
  loadProjectLocations,
  makeProjectFolder,
  saveProjectLocations,
  projectProposalDecisionOf,
  projectProposals,
  removeCreatedProjectFolder,
  textOf,
} from "../mc-project-create";
import type { IpcRegistrar } from "./types";

/**
 * mc-agent (MC-ADR-0023): the renderer side of `CreateProject`. The card
 * reads pending proposals, checks the location, and creates the project with
 * the existing project IPC plus a folder and a one-off-template call; then it
 * resolves the proposal with what happened.
 */
export type McProjectCreateIpcDependencies = {
  registrar: IpcRegistrar;
  getHost: () => HostProcess | null;
  /** Holds the default location for new projects. */
  dataDir: string;
  refreshProjectGroups: (host: HostProcess) => Promise<unknown>;
  sendToRenderer: (channel: string, payload: unknown) => void;
  /** Native folder picker; `null` when the user cancels. */
  pickFolder: (defaultPath?: string) => Promise<string | null>;
};

function invalid(message: string): Error {
  return Object.assign(new Error(message), { errorCode: ErrorCodes.INVALID_ARGUMENT });
}

function pathOf(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim() || value.length > PROJECT_PROPOSAL_PATH_MAX) {
    throw invalid(`${label} is invalid`);
  }
  if (!isAbsolute(value)) throw invalid(`${label} must be absolute`);
  return value;
}

export function registerMcProjectCreateIpc({
  registrar,
  getHost,
  dataDir,
  refreshProjectGroups,
  sendToRenderer,
  pickFolder,
}: McProjectCreateIpcDependencies): () => void {
  const unsubscribe = projectProposals.subscribe((proposals) =>
    sendToRenderer(IPC.event.mcProjectProposalsChanged, { proposals }),
  );
  const host = () => {
    const current = getHost();
    if (!current) throw new Error("host unavailable");
    return current;
  };

  registrar.handle(IPC.invoke.mcProjectLocationsGet, async () => ({
    locations: await loadProjectLocations(dataDir),
  }));
  registrar.handle(IPC.invoke.mcProjectLocationsSet, async (input: { locations?: unknown } = {}) => {
    try {
      return { locations: await saveProjectLocations(dataDir, input?.locations) };
    } catch (error) {
      throw invalid(error instanceof Error ? error.message : String(error));
    }
  });

  registrar.handle(IPC.invoke.mcProjectProposals, async () => ({ proposals: projectProposals.list() }));

  registrar.handle(
    IPC.invoke.mcProjectProposalResolve,
    async (input: { requestId?: unknown; decision?: unknown } = {}) => {
      if (typeof input?.requestId !== "string" || !input.requestId) throw invalid("requestId required");
      return { ok: projectProposals.resolve(input.requestId, projectProposalDecisionOf(input.decision)) };
    },
  );

  registrar.handle(
    IPC.invoke.mcProjectLocationCheck,
    async (input: { parent?: unknown; folder?: unknown } = {}) => {
      const parent = pathOf(input?.parent, "parent");
      const folder = typeof input?.folder === "string" ? input.folder : "";
      if (!isValidProjectFolderName(folder)) throw invalid("folder name is invalid");
      const { groups } = (await host().call("project.groups.list", {})) as { groups?: [] };
      return { check: await checkProjectLocation(parent, folder, groups ?? []) };
    },
  );

  registrar.handle(IPC.invoke.mcProjectPickParent, async (input: { defaultPath?: unknown } = {}) => {
    const defaultPath = typeof input?.defaultPath === "string" && isAbsolute(input.defaultPath) ? input.defaultPath : undefined;
    return { path: await pickFolder(defaultPath) };
  });

  registrar.handle(IPC.invoke.mcProjectMakeFolder, async (input: { path?: unknown } = {}) =>
    makeProjectFolder(pathOf(input?.path, "path")),
  );

  registrar.handle(IPC.invoke.mcProjectRemoveFolder, async (input: { path?: unknown } = {}) => ({
    removed: await removeCreatedProjectFolder(pathOf(input?.path, "path")),
  }));

  // Shape check only; host-core validates names, folders and descriptions.
  registrar.handle(
    IPC.invoke.mcProjectEnsureDraft,
    async (input: { groupId?: unknown; template?: unknown } = {}) => {
      const groupId = typeof input?.groupId === "string" ? input.groupId.trim() : "";
      if (!groupId || groupId.length > 256) throw invalid("project group id required");
      const template = input?.template as { name?: unknown; description?: unknown; categories?: unknown } | undefined;
      if (!template || typeof template !== "object" || !Array.isArray(template.categories)) {
        throw invalid("template required");
      }
      const categories = template.categories.slice(0, 200).map((entry: unknown) => {
        const category = (entry ?? {}) as { name?: unknown; description?: unknown };
        return { name: textOf(category.name, 500), description: textOf(category.description, 1000) };
      });
      const current = host();
      const result = await current.call("project.resources.ensureDraft", {
        groupId,
        template: { name: textOf(template.name, 200), description: textOf(template.description, 1000), categories },
      });
      void refreshProjectGroups(current);
      return result;
    },
  );

  return unsubscribe;
}
