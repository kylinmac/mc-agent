import { randomUUID } from "node:crypto";
import { access, mkdir, readFile, readdir, realpath, rename, rmdir, stat, statfs, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import {
  ErrorCodes,
  joinProjectPath,
  normalizeProjectProposalArgs,
  PROJECT_PROPOSAL_PATH_MAX,
  type ProjectCreateStep,
  type ProjectLocationCheck,
  type ProjectLocationPreference,
  type ProjectProposal,
  type ProjectProposalDecision,
} from "@pi-desktop/shared";
import type { LocalToolHandler } from "./agent-sidecar";

/**
 * mc-agent (MC-ADR-0023): create a project from the conversation.
 *
 * `ProjectTemplates` tells the agent what a project can start from;
 * `CreateProject` parks the agent's proposal here until the user answers the
 * card the renderer shows for it. The renderer creates the project through the
 * existing project IPC and resolves the proposal with what happened, which is
 * the tool's result. Nothing is written while a proposal is pending.
 */

type HostCall = { call: (method: string, params?: unknown) => Promise<unknown> };

type Pending = { proposal: ProjectProposal; settle: (decision: ProjectProposalDecision) => void };

export type ProjectProposalBroker = {
  propose: (proposal: ProjectProposal, signal: AbortSignal) => Promise<ProjectProposalDecision | null>;
  resolve: (requestId: string, decision: ProjectProposalDecision) => boolean;
  list: () => ProjectProposal[];
  subscribe: (listener: (proposals: ProjectProposal[]) => void) => () => void;
};

export function createProjectProposalBroker(): ProjectProposalBroker {
  const pending = new Map<string, Pending>();
  const listeners = new Set<(proposals: ProjectProposal[]) => void>();
  const list = () => [...pending.values()].map((entry) => entry.proposal);
  const changed = () => {
    const proposals = list();
    for (const listener of listeners) listener(proposals);
  };
  return {
    list,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    // Resolves null when the turn is stopped before the user answers.
    propose: (proposal, signal) =>
      new Promise((done) => {
        if (signal.aborted) return done(null);
        const onAbort = () => {
          pending.delete(proposal.requestId);
          changed();
          done(null);
        };
        signal.addEventListener("abort", onAbort, { once: true });
        pending.set(proposal.requestId, {
          proposal,
          settle: (decision) => {
            signal.removeEventListener("abort", onAbort);
            done(decision);
          },
        });
        changed();
      }),
    resolve: (requestId, decision) => {
      const entry = pending.get(requestId);
      if (!entry) return false;
      pending.delete(requestId);
      entry.settle(decision);
      changed();
      return true;
    },
  };
}

/** The one broker the tool and the IPC share. */
export const projectProposals = createProjectProposalBroker();

type TemplateSummary = {
  name: string;
  builtin?: boolean;
  description?: string;
  categoryDescriptions?: Record<string, string>;
  folders?: string[];
  target?: string;
};

type GroupSummary = { name?: string; remote?: unknown; roots?: Array<{ path: string; kind?: string }> };

async function resourceTemplates(host: HostCall): Promise<TemplateSummary[]> {
  const result = (await host.call("project.resources.templates", {})) as { templates?: TemplateSummary[] };
  return (result?.templates ?? []).filter((template) => (template.target ?? "resources") === "resources");
}

async function promptTemplates(host: HostCall): Promise<Array<{ id: string; name: string }>> {
  const result = (await host.call("mcPrompts.get", {})) as {
    config?: { templates?: Array<{ id: string; name: string }> };
  };
  return (result?.config?.templates ?? []).map(({ id, name }) => ({ id, name }));
}

async function projectGroups(host: HostCall): Promise<GroupSummary[]> {
  const result = (await host.call("project.groups.list", {})) as { groups?: GroupSummary[] };
  return result?.groups ?? [];
}

/*
  The user's locations for new projects (Settings → Project templates), one
  JSON file in the app's data directory. Each has an optional note saying
  what goes there; the first is the default. None means the suggestions are
  worked out from where existing projects live.
*/
const DEFAULTS_FILE = "mc-project-defaults.json";
const MAX_LOCATIONS = 12;

function locationsOf(value: unknown): ProjectLocationPreference[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const locations: ProjectLocationPreference[] = [];
  for (const entry of value.slice(0, MAX_LOCATIONS)) {
    const raw = (entry ?? {}) as { path?: unknown; note?: unknown };
    const path = typeof raw.path === "string" ? raw.path.trim() : "";
    if (!path || !isAbsolute(path) || path.length > 4096 || seen.has(path)) continue;
    seen.add(path);
    const note = typeof raw.note === "string" ? raw.note.trim().replace(/\s+/g, " ").slice(0, 200) : "";
    locations.push({ path, note });
  }
  return locations;
}

export async function loadProjectLocations(dataDir: string): Promise<ProjectLocationPreference[]> {
  try {
    const parsed = JSON.parse(await readFile(join(dataDir, DEFAULTS_FILE), "utf8")) as {
      parent?: unknown;
      locations?: unknown;
    };
    // Version 1 kept a single `parent`.
    if (parsed?.locations === undefined && typeof parsed?.parent === "string") {
      return locationsOf([{ path: parsed.parent, note: "" }]);
    }
    return locationsOf(parsed?.locations);
  } catch {
    return [];
  }
}

export async function saveProjectLocations(dataDir: string, value: unknown): Promise<ProjectLocationPreference[]> {
  if (!Array.isArray(value)) throw new Error("locations must be a list");
  const locations = locationsOf(value);
  if (locations.length !== Math.min(value.length, MAX_LOCATIONS)) {
    throw new Error("each location must be a distinct absolute folder");
  }
  const path = join(dataDir, DEFAULTS_FILE);
  await mkdir(dataDir, { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify({ version: 2, locations }, null, 2)}\n`, "utf8");
  await rename(temporary, path);
  return locations;
}

/**
 * Where new projects could go: the user's own locations first, in their
 * order, then the folders that hold their local projects (most used first),
 * then home.
 */
export function suggestedParents(groups: GroupSummary[], home: string, preferred: readonly string[] = []): string[] {
  const counts = new Map<string, number>();
  for (const group of groups) {
    if (group.remote) continue;
    for (const root of group.roots ?? []) {
      if (root.kind === "resources") continue;
      const parent = dirname(root.path);
      if (parent === root.path) continue;
      counts.set(parent, (counts.get(parent) ?? 0) + 1);
    }
  }
  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([path]) => path);
  return [...new Set([...preferred, ...ranked.slice(0, 5), home])];
}

function failure(errorCode: string, message: string) {
  return { ok: false, isError: true, errorCode, content: { kind: "create-project-error", errorCode, message } };
}

const TEMPLATE_NOTE = "Folder names in a drafted template are English; notes are in the user's language.";
const LOCATIONS_NOTE =
  "userLocations are the folders the user set up for new projects, each with what goes there. Unless the user names a folder, use the one whose note fits this project, else the first.";

export function createProjectTemplatesTool(
  getHost: () => HostCall | null,
  loadLocations: () => Promise<ProjectLocationPreference[]> = async () => [],
): LocalToolHandler {
  return async () => {
    const host = getHost();
    if (!host) return failure("HOST_UNAVAILABLE", "Host unavailable.");
    const [templates, prompts, groups, locations] = await Promise.all([
      resourceTemplates(host),
      promptTemplates(host).catch(() => []),
      projectGroups(host).catch(() => []),
      loadLocations().catch(() => []),
    ]);
    return {
      ok: true,
      content: {
        kind: "project-templates",
        templates: templates.map((template) => ({
          name: template.name,
          builtin: Boolean(template.builtin),
          description: template.description ?? "",
          folders: (template.folders ?? []).map((path) => ({
            path,
            description: template.categoryDescriptions?.[path] ?? "",
          })),
        })),
        promptTemplates: prompts,
        ...(locations.length ? { userLocations: locations } : {}),
        suggestedParents: suggestedParents(groups, homedir(), locations.map((location) => location.path)),
        note: locations.length ? `${LOCATIONS_NOTE} ${TEMPLATE_NOTE}` : TEMPLATE_NOTE,
      },
    };
  };
}

export function createCreateProjectTool(
  getHost: () => HostCall | null,
  broker: ProjectProposalBroker = projectProposals,
): LocalToolHandler {
  return async ({ sessionId, args, signal }) => {
    const host = getHost();
    if (!host) return failure("HOST_UNAVAILABLE", "Host unavailable.");
    const parsed = normalizeProjectProposalArgs(args, homedir());
    if (!parsed.ok) return failure("INVALID_ARGUMENT", parsed.message);
    const input = parsed.value;
    const known = new Set((await resourceTemplates(host)).map((template) => template.name));
    const unknown = input.templates.filter((name) => !known.has(name));
    if (unknown.length) {
      return failure(
        "UNKNOWN_TEMPLATE",
        `Unknown template: ${unknown.join(", ")}. Use names from ProjectTemplates, or pass a draft.`,
      );
    }
    if (input.promptTemplateId) {
      const prompts = await promptTemplates(host).catch(() => []);
      if (!prompts.some((prompt) => prompt.id === input.promptTemplateId)) {
        return failure("UNKNOWN_PROMPT_TEMPLATE", "Unknown promptTemplateId. Use an id from ProjectTemplates.");
      }
    }
    const decision = await broker.propose({ ...input, requestId: randomUUID(), sessionId }, signal);
    if (!decision) return failure("CANCELLED", "The turn was stopped before the user answered.");
    return { ok: decision.outcome !== "failed", ...(decision.outcome === "failed" ? { isError: true } : {}), content: { kind: "create-project", ...decision } };
  };
}

/** The nearest folder at or above `path` that exists. */
async function existingAncestor(path: string): Promise<string | null> {
  let current = path;
  for (;;) {
    try {
      if ((await stat(current)).isDirectory()) return current;
      return null;
    } catch {
      const parent = dirname(current);
      if (parent === current) return null;
      current = parent;
    }
  }
}

async function samePath(left: string, right: string): Promise<boolean> {
  const real = async (path: string) => realpath(path).catch(() => resolve(path));
  return (await real(left)) === (await real(right));
}

/** Where `parent/folder` stands: exists, empty, owned by a project, writable. */
export async function checkProjectLocation(
  parent: string,
  folder: string,
  groups: GroupSummary[],
): Promise<ProjectLocationCheck> {
  const path = resolve(joinProjectPath(parent, folder));
  const info = await stat(path).catch(() => null);
  const exists = Boolean(info?.isDirectory());
  const blocked = Boolean(info && !info.isDirectory());
  const entries = exists ? (await readdir(path).catch(() => [])).length : 0;
  let project: string | undefined;
  if (exists) {
    for (const group of groups) {
      if (group.remote) continue;
      for (const root of group.roots ?? []) {
        if (await samePath(root.path, path)) project = group.name || root.path;
      }
    }
  }
  const ancestor = await existingAncestor(path);
  const writable = ancestor
    ? await access(ancestor, constants.W_OK).then(() => true, () => false)
    : false;
  const free = ancestor ? await statfs(ancestor).catch(() => null) : null;
  return {
    path,
    exists,
    blocked,
    entries,
    ...(project ? { project } : {}),
    writable,
    ...(free ? { freeBytes: Number(free.bavail) * Number(free.bsize) } : {}),
  };
}

/**
 * Folders created for a project in this run of the app; only these may be
 * removed again, and only while empty, when creating the project fails.
 */
const createdFolders = new Set<string>();

export async function makeProjectFolder(path: string): Promise<{ path: string; created: boolean }> {
  const target = resolve(path);
  const info = await stat(target).catch(() => null);
  if (info) {
    if (!info.isDirectory()) throw new Error(`${target} exists and is not a folder`);
    return { path: target, created: false };
  }
  await mkdir(target, { recursive: true });
  createdFolders.add(target);
  return { path: target, created: true };
}

export async function removeCreatedProjectFolder(path: string): Promise<boolean> {
  const target = resolve(path);
  if (!createdFolders.has(target)) return false;
  // rmdir refuses a folder with anything in it, which is the point.
  const removed = await rmdir(target).then(() => true, () => false);
  if (removed) createdFolders.delete(target);
  return removed;
}

function invalidDecision(message: string): Error {
  return Object.assign(new Error(message), { errorCode: ErrorCodes.INVALID_ARGUMENT });
}

export function textOf(value: unknown, max = 2000): string {
  return typeof value === "string" ? value.slice(0, max) : "";
}

const STEPS: readonly ProjectCreateStep[] = ["folder", "project", "resources", "prompt"];

/** Shape check of the card's answer; it becomes the tool result. */
export function projectProposalDecisionOf(value: unknown): ProjectProposalDecision {
  if (!value || typeof value !== "object") throw invalidDecision("decision required");
  const raw = value as Record<string, unknown>;
  const name = textOf(raw.name, 200);
  const path = textOf(raw.path, PROJECT_PROPOSAL_PATH_MAX);
  const request = textOf(raw.request);
  switch (raw.outcome) {
    case "created":
      return {
        outcome: "created",
        name,
        path,
        primaryPath: textOf(raw.primaryPath, PROJECT_PROPOSAL_PATH_MAX) || path,
        ...(typeof raw.resourcePath === "string" ? { resourcePath: textOf(raw.resourcePath, PROJECT_PROPOSAL_PATH_MAX) } : {}),
        ...(typeof raw.template === "string" ? { template: textOf(raw.template, 200) } : {}),
        ...(raw.templateSaved === true ? { templateSaved: true } : {}),
        ...(typeof raw.promptTemplate === "string" ? { promptTemplate: textOf(raw.promptTemplate, 200) } : {}),
        folderCreated: raw.folderCreated === true,
      };
    case "draft-requested":
    case "revise":
      return { outcome: raw.outcome, name, path, ...(request ? { request } : {}) };
    case "failed": {
      const step = STEPS.includes(raw.step as ProjectCreateStep) ? (raw.step as ProjectCreateStep) : "project";
      return { outcome: "failed", name, path, step, message: textOf(raw.message) || "Failed." };
    }
    default:
      throw invalidDecision("unknown outcome");
  }
}
