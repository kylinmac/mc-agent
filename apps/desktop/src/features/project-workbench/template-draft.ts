import type { ResourceTemplateDraft, ResourceTemplateSummary, ResourceTemplateTarget } from "@pi-desktop/shared";

/*
  Editing state of one resource template (R1.4). Folders form a tree and are
  kept as `/`-separated relative paths, parents before children; each one has
  its own description. A saved folder can be removed but not renamed; host-core
  removes it only while it is empty and validates every name again.
*/

export type DraftFolder = { path: string; description: string; saved: boolean };

export type TemplateDraftState = {
  name: string;
  description: string;
  folders: DraftFolder[];
  /** A resource folder template, or one for creative categories. */
  target: ResourceTemplateTarget;
};

export type FolderError = "empty" | "invalid" | "duplicate" | "tooDeep";

/** Mirrors host-core's MAX_FOLDER_DEPTH. */
export const MAX_FOLDER_DEPTH = 6;

function compareFolders(left: string, right: string): number {
  const a = left.split("/");
  const b = right.split("/");
  for (let i = 0; i < Math.min(a.length, b.length); i += 1) {
    if (a[i] !== b[i]) return a[i]! < b[i]! ? -1 : 1;
  }
  return a.length - b.length;
}

function sorted(folders: DraftFolder[]): DraftFolder[] {
  return [...folders].sort((left, right) => compareFolders(left.path, right.path));
}

export function folderDepth(path: string): number {
  return path.split("/").length - 1;
}

export function folderName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

export function draftFromSummary(summary: ResourceTemplateSummary): TemplateDraftState {
  const paths = summary.folders ?? summary.categories;
  return {
    name: summary.name,
    description: summary.description ?? "",
    target: summary.target ?? "resources",
    folders: sorted(
      paths.map((path) => ({
        path,
        description: summary.categoryDescriptions?.[path] ?? "",
        saved: true,
      })),
    ),
  };
}

/** Mirrors host-core's folder-name rule so mistakes show before saving. */
export function folderNameError(raw: string): "empty" | "invalid" | null {
  const name = raw.trim();
  if (!name) return "empty";
  if (name === "." || name === ".." || name.startsWith(".") || /[\\/]/.test(name)) return "invalid";
  if ([...name].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)) return "invalid";
  if ([...name].length > 80) return "invalid";
  return null;
}

/** Add a folder at the top (`parent` null) or inside `parent`. */
export function addFolder(
  draft: TemplateDraftState,
  parent: string | null,
  raw: string,
): { draft: TemplateDraftState; path: string } | { error: FolderError } {
  const name = raw.trim();
  const error = folderNameError(name);
  if (error) return { error };
  const path = parent ? `${parent}/${name}` : name;
  if (folderDepth(path) >= MAX_FOLDER_DEPTH) return { error: "tooDeep" };
  if (draft.folders.some((folder) => folder.path === path)) return { error: "duplicate" };
  return {
    draft: { ...draft, folders: sorted([...draft.folders, { path, description: "", saved: false }]) },
    path,
  };
}

/** Remove a folder together with everything below it. */
export function removeFolder(draft: TemplateDraftState, path: string): TemplateDraftState {
  return {
    ...draft,
    folders: draft.folders.filter((folder) => folder.path !== path && !folder.path.startsWith(`${path}/`)),
  };
}

export function describeFolder(draft: TemplateDraftState, path: string, description: string): TemplateDraftState {
  return {
    ...draft,
    folders: draft.folders.map((folder) => (folder.path === path ? { ...folder, description } : folder)),
  };
}

export function toPayload(
  draft: TemplateDraftState,
  options: { create?: boolean; copyFrom?: string } = {},
): ResourceTemplateDraft {
  return {
    name: draft.name.trim(),
    description: draft.description.trim(),
    categories: draft.folders.map(({ path, description }) => ({ name: path, description: description.trim() })),
    target: draft.target,
    ...(options.create ? { create: true } : {}),
    ...(options.copyFrom ? { copyFrom: options.copyFrom } : {}),
  };
}

/** True when saving would change the template. */
export function isDirty(draft: TemplateDraftState, saved: ResourceTemplateSummary | undefined): boolean {
  if (!saved) return true;
  const payload = toPayload(draft);
  const original = toPayload(draftFromSummary(saved));
  return JSON.stringify(payload) !== JSON.stringify(original);
}
