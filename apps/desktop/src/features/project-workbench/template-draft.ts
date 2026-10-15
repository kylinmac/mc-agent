import type { ResourceTemplateDraft, ResourceTemplateSummary } from "@pi-desktop/shared";

/*
  Editing state of one resource template (R1.4). A saved category is a folder
  in the template and can be removed but not renamed; host-core removes it only
  while it is empty and validates every name again.
*/

export type DraftCategory = { name: string; description: string; saved: boolean };

export type TemplateDraftState = {
  name: string;
  description: string;
  categories: DraftCategory[];
};

export type CategoryError = "empty" | "invalid" | "duplicate";

export function draftFromSummary(summary: ResourceTemplateSummary): TemplateDraftState {
  return {
    name: summary.name,
    description: summary.description ?? "",
    categories: summary.categories.map((name) => ({
      name,
      description: summary.categoryDescriptions?.[name] ?? "",
      saved: true,
    })),
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

export function addCategory(
  draft: TemplateDraftState,
  raw: string,
): { draft: TemplateDraftState } | { error: CategoryError } {
  const name = raw.trim();
  const error = folderNameError(name);
  if (error) return { error };
  if (draft.categories.some((category) => category.name === name)) return { error: "duplicate" };
  return {
    draft: {
      ...draft,
      categories: [...draft.categories, { name, description: "", saved: false }],
    },
  };
}

export function removeCategory(draft: TemplateDraftState, name: string): TemplateDraftState {
  return { ...draft, categories: draft.categories.filter((category) => category.name !== name) };
}

export function describeCategory(draft: TemplateDraftState, name: string, description: string): TemplateDraftState {
  return {
    ...draft,
    categories: draft.categories.map((category) =>
      category.name === name ? { ...category, description } : category,
    ),
  };
}

export function toPayload(
  draft: TemplateDraftState,
  options: { create?: boolean; copyFrom?: string } = {},
): ResourceTemplateDraft {
  return {
    name: draft.name.trim(),
    description: draft.description.trim(),
    categories: draft.categories.map(({ name, description }) => ({ name, description: description.trim() })),
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
