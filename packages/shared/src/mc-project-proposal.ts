/**
 * mc-agent (MC-ADR-0023): creating a project from a conversation.
 *
 * The agent proposes a project with `CreateProject`; the desktop shows the
 * proposal as a card and nothing touches the disk until the user presses
 * Create. These types are shared by the runtime's tool declaration, Electron
 * main (which validates the arguments and brokers the card) and the renderer.
 */

export const PROJECT_TEMPLATES_TOOL_NAME = "ProjectTemplates";
export const CREATE_PROJECT_TOOL_NAME = "CreateProject";
export const NEW_PROJECT_SKILL_ID = "mc-agent/new-project";

export const PROJECT_PROPOSAL_NAME_MAX = 80;
export const PROJECT_PROPOSAL_FOLDER_MAX = 120;
export const PROJECT_PROPOSAL_PATH_MAX = 4096;
export const PROJECT_PROPOSAL_TEMPLATES_MAX = 3;
export const PROJECT_DRAFT_FOLDERS_MAX = 60;
export const PROJECT_DRAFT_FOLDER_DEPTH_MAX = 6;
export const PROJECT_DRAFT_DESCRIPTION_MAX = 500;
export const PROJECT_DRAFT_PROMPT_MAX = 8000;
export const PROJECT_PROPOSAL_NOTE_MAX = 300;

/** A resource-folder template the agent drafted for this project. */
export type ProjectDraftTemplate = {
  /** Template name; also the name it is saved under when the user keeps it. */
  name: string;
  description: string;
  /** Folders as `/`-separated relative paths, each with what belongs in it. */
  folders: Array<{ path: string; description: string }>;
  /** Extra system-prompt rules for conversations in this project. */
  systemPrompt?: string;
};

/** What the card shows. `parent` is absolute; the project is `parent/folder`. */
export type ProjectProposal = {
  requestId: string;
  sessionId: string;
  name: string;
  parent: string;
  folder: string;
  /** Existing resource templates, best match first; empty means none fits. */
  templates: string[];
  draft?: ProjectDraftTemplate;
  /** An existing system prompt template for the project's folders. */
  promptTemplateId?: string;
  /** The agent's one-line reason for its pick, shown on the card. */
  note?: string;
};

export type ProjectProposalInput = Omit<ProjectProposal, "requestId" | "sessionId">;

/** How the user answered the card; this is what the tool returns. */
export type ProjectProposalDecision =
  | {
      outcome: "created";
      name: string;
      path: string;
      /** The project's primary folder: its resource folder when it has one. */
      primaryPath: string;
      resourcePath?: string;
      template?: string;
      templateSaved?: boolean;
      promptTemplate?: string;
      folderCreated: boolean;
    }
  | { outcome: "draft-requested"; name: string; path: string; request?: string }
  | { outcome: "revise"; name: string; path: string; request?: string }
  | { outcome: "failed"; name: string; path: string; step: ProjectCreateStep; message: string };

export type ProjectCreateStep = "folder" | "project" | "resources" | "prompt";

/** A folder the user set up for new projects, and what goes there. */
export type ProjectLocationPreference = { path: string; note: string };

/** Where a proposed location stands on disk (answered by Electron main). */
export type ProjectLocationCheck = {
  path: string;
  /** The folder exists (as a directory). */
  exists: boolean;
  /** Something that is not a directory sits at the path. */
  blocked: boolean;
  /** Entries in the folder, hidden ones included; 0 when it does not exist. */
  entries: number;
  /** The name of the project that already owns the folder. */
  project?: string;
  /** The folder, or the closest existing ancestor, accepts new entries. */
  writable: boolean;
  freeBytes?: number;
};

const CONTROL = /[\u0000-\u001f\u007f]/;

/** A single folder name the user can create (no separators, not `.`/`..`). */
export function isValidProjectFolderName(name: string): boolean {
  const value = name.trim();
  return (
    value.length > 0 &&
    value.length <= PROJECT_PROPOSAL_FOLDER_MAX &&
    value !== "." &&
    value !== ".." &&
    !/[\\/:*?"<>|]/.test(value) &&
    !CONTROL.test(value) &&
    value === name
  );
}

function isDraftFolderPath(path: string): boolean {
  const parts = path.split("/");
  return (
    parts.length <= PROJECT_DRAFT_FOLDER_DEPTH_MAX &&
    parts.every(
      (part) =>
        part.length > 0 &&
        part.length <= 80 &&
        !part.startsWith(".") &&
        !part.includes("\\") &&
        !CONTROL.test(part),
    )
  );
}

function expandHome(path: string, home: string): string {
  if (path === "~") return home;
  if (path.startsWith("~/") || path.startsWith("~\\")) {
    return `${home.replace(/[\\/]+$/, "")}${path.slice(1)}`;
  }
  return path;
}

function isAbsolutePath(path: string): boolean {
  return path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path) || path.startsWith("\\\\");
}

/** Join a parent and a folder name with the parent's own separator. */
export function joinProjectPath(parent: string, folder: string): string {
  const separator = parent.includes("\\") && !parent.includes("/") ? "\\" : "/";
  return `${parent.replace(/[\\/]+$/, "")}${separator}${folder}`;
}

type Parsed<T> = { ok: true; value: T } | { ok: false; message: string };

function text(value: unknown, max: number, label: string, required = false): Parsed<string> {
  if (value === undefined || value === null) {
    return required ? { ok: false, message: `${label} is required.` } : { ok: true, value: "" };
  }
  if (typeof value !== "string") return { ok: false, message: `${label} must be a string.` };
  const trimmed = value.trim();
  if (required && !trimmed) return { ok: false, message: `${label} is required.` };
  if (trimmed.length > max) return { ok: false, message: `${label} is longer than ${max} characters.` };
  return { ok: true, value: trimmed };
}

function draftOf(value: unknown): Parsed<ProjectDraftTemplate | undefined> {
  if (value === undefined || value === null) return { ok: true, value: undefined };
  if (typeof value !== "object") return { ok: false, message: "draft must be an object." };
  const raw = value as Record<string, unknown>;
  const name = text(raw.name, 80, "draft.name", true);
  if (!name.ok) return name;
  if (name.value.startsWith(".") || /[\\/]/.test(name.value) || CONTROL.test(name.value)) {
    return { ok: false, message: "draft.name must be a plain folder name." };
  }
  const description = text(raw.description, PROJECT_DRAFT_DESCRIPTION_MAX, "draft.description");
  if (!description.ok) return description;
  if (!Array.isArray(raw.folders) || raw.folders.length === 0) {
    return { ok: false, message: "draft.folders needs at least one folder." };
  }
  if (raw.folders.length > PROJECT_DRAFT_FOLDERS_MAX) {
    return { ok: false, message: `draft.folders can have at most ${PROJECT_DRAFT_FOLDERS_MAX} folders.` };
  }
  const folders: ProjectDraftTemplate["folders"] = [];
  const seen = new Set<string>();
  for (const entry of raw.folders) {
    if (!entry || typeof entry !== "object") return { ok: false, message: "Each draft folder must be an object." };
    const folder = entry as Record<string, unknown>;
    const path = text(folder.path, 6 * 81, "draft folder path", true);
    if (!path.ok) return path;
    const normalized = path.value.replace(/^\/+|\/+$/g, "");
    if (!isDraftFolderPath(normalized)) {
      return { ok: false, message: `Invalid draft folder: ${path.value}` };
    }
    if (seen.has(normalized)) return { ok: false, message: `Duplicate draft folder: ${normalized}` };
    seen.add(normalized);
    const note = text(folder.description, PROJECT_DRAFT_DESCRIPTION_MAX, "draft folder description");
    if (!note.ok) return note;
    if (/[\r\n]/.test(note.value)) return { ok: false, message: "A draft folder description must be one line." };
    folders.push({ path: normalized, description: note.value });
  }
  const systemPrompt = text(raw.systemPrompt, PROJECT_DRAFT_PROMPT_MAX, "draft.systemPrompt");
  if (!systemPrompt.ok) return systemPrompt;
  return {
    ok: true,
    value: {
      name: name.value,
      description: /[\r\n]/.test(description.value) ? description.value.split(/\r?\n/)[0] : description.value,
      folders,
      ...(systemPrompt.value ? { systemPrompt: systemPrompt.value } : {}),
    },
  };
}

/**
 * Check `CreateProject` arguments. `home` expands a leading `~`; the result's
 * parent is always absolute. Errors are written for the model to correct.
 */
export function normalizeProjectProposalArgs(
  args: unknown,
  home: string,
): Parsed<ProjectProposalInput> {
  if (!args || typeof args !== "object") return { ok: false, message: "Arguments must be an object." };
  const raw = args as Record<string, unknown>;
  const name = text(raw.name, PROJECT_PROPOSAL_NAME_MAX, "name", true);
  if (!name.ok) return name;
  const parentText = text(raw.parent, PROJECT_PROPOSAL_PATH_MAX, "parent", true);
  if (!parentText.ok) return parentText;
  const parent = expandHome(parentText.value, home).replace(/(?<=.)[\\/]+$/, "");
  if (!isAbsolutePath(parent)) {
    return { ok: false, message: "parent must be an absolute path or start with ~." };
  }
  if (CONTROL.test(parent)) return { ok: false, message: "parent contains control characters." };
  const folder = text(raw.folder, PROJECT_PROPOSAL_FOLDER_MAX, "folder", true);
  if (!folder.ok) return folder;
  if (!isValidProjectFolderName(folder.value)) {
    return { ok: false, message: "folder must be one folder name without / \\ : * ? \" < > |." };
  }
  let templates: string[] = [];
  if (raw.templates !== undefined) {
    if (!Array.isArray(raw.templates) || raw.templates.some((item) => typeof item !== "string")) {
      return { ok: false, message: "templates must be a list of template names." };
    }
    templates = [...new Set((raw.templates as string[]).map((item) => item.trim()).filter(Boolean))];
    if (templates.length > PROJECT_PROPOSAL_TEMPLATES_MAX) {
      return { ok: false, message: `List at most ${PROJECT_PROPOSAL_TEMPLATES_MAX} templates.` };
    }
  }
  const draft = draftOf(raw.draft);
  if (!draft.ok) return draft;
  const promptTemplateId = text(raw.promptTemplateId, 200, "promptTemplateId");
  if (!promptTemplateId.ok) return promptTemplateId;
  const note = text(raw.note, PROJECT_PROPOSAL_NOTE_MAX, "note");
  if (!note.ok) return note;
  return {
    ok: true,
    value: {
      name: name.value,
      parent,
      folder: folder.value,
      templates,
      ...(draft.value ? { draft: draft.value } : {}),
      ...(promptTemplateId.value ? { promptTemplateId: promptTemplateId.value } : {}),
      ...(note.value ? { note: note.value } : {}),
    },
  };
}
