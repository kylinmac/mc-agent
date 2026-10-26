import type {
  CreativeAsset,
  CreativeJob,
  CreativeOrigin,
  CreativeRole,
} from "./creative-types";
import { FINAL_JOB_STATUSES } from "./creative-types";

/*
  mc-agent creative studio: pure helpers (kept out of .tsx so tests can
  import them).
*/

/** What the main area shows: every asset, uncategorized ones, one category
 * (with its sub-categories), or saved comparisons. */
export type StudioView =
  | { kind: "all" }
  | { kind: "uncategorized" }
  | { kind: "category"; path: string }
  | { kind: "comparisons" }
  | { kind: "canvas"; canvasId: string };

export function inCategory(assetCategory: string, path: string): boolean {
  return assetCategory === path || assetCategory.startsWith(`${path}/`);
}

export function viewAssets(assets: readonly CreativeAsset[], view: StudioView): CreativeAsset[] {
  switch (view.kind) {
    case "uncategorized":
      return assets.filter((asset) => !asset.category);
    case "category":
      return assets.filter((asset) => inCategory(asset.category, view.path));
    case "comparisons":
    case "canvas":
      return [];
    default:
      return [...assets];
  }
}

export type CategoryNode = {
  path: string;
  name: string;
  /** Assets in this category and every sub-category. */
  total: number;
  children: CategoryNode[];
};

/** The category tree from the flat list (paths like `角色/角色A`). */
export function categoryTree(categories: readonly { path: string; count: number }[]): CategoryNode[] {
  const roots: CategoryNode[] = [];
  const byPath = new Map<string, CategoryNode>();
  const ensure = (path: string): CategoryNode => {
    const existing = byPath.get(path);
    if (existing) return existing;
    const cut = path.lastIndexOf("/");
    const node: CategoryNode = { path, name: cut < 0 ? path : path.slice(cut + 1), total: 0, children: [] };
    byPath.set(path, node);
    if (cut < 0) roots.push(node);
    else ensure(path.slice(0, cut)).children.push(node);
    return node;
  };
  for (const category of [...categories].sort((a, b) => a.path.localeCompare(b.path))) {
    ensure(category.path);
    // Each asset counts toward its category and all of its parents.
    const parts = category.path.split("/");
    for (let depth = 1; depth <= parts.length; depth += 1) {
      ensure(parts.slice(0, depth).join("/")).total += category.count;
    }
  }
  return roots;
}

/** Every category path in display order (for pickers). */
export function flattenCategories(nodes: readonly CategoryNode[]): CategoryNode[] {
  return nodes.flatMap((node) => [node, ...flattenCategories(node.children)]);
}

export type DayItem =
  | { kind: "asset"; key: string; asset: CreativeAsset; job: CreativeJob | null }
  | { kind: "missing"; key: string; job: CreativeJob; index: number; status: string; error?: string | null };

export type DayGroup = {
  /** Local calendar day, `YYYY-MM-DD`. */
  day: string;
  items: DayItem[];
};

function localDay(ms: number): string {
  const date = new Date(ms);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/**
 * The grid as photo libraries lay it out: one continuous run of images per
 * day, newest first, so a run of single-image generations still fills rows.
 * With `jobs`, results still generating or failed sit among them as
 * placeholders; each image keeps its job for the hover caption and details.
 */
export function dayGroups(assets: readonly CreativeAsset[], jobs: readonly CreativeJob[], withPlaceholders: boolean): DayGroup[] {
  const jobById = new Map(jobs.map((job) => [job.id, job]));
  const items: Array<{ at: number; order: number; item: DayItem }> = assets.map((asset) => {
    const job = asset.jobId ? jobById.get(asset.jobId) ?? null : null;
    // A batch sorts by when it was asked for, so its images stay together.
    return { at: job?.createdAt ?? asset.createdAt, order: asset.resultIndex ?? 0, item: { kind: "asset", key: asset.id, asset, job } };
  });
  if (withPlaceholders) {
    const present = new Set(assets.map((asset) => `${asset.jobId}\u0000${asset.resultIndex}`));
    for (const job of jobs) {
      for (const result of job.results) {
        if (result.assetId || present.has(`${job.id}\u0000${result.index}`)) continue;
        items.push({
          at: job.createdAt,
          order: result.index,
          item: { kind: "missing", key: `${job.id}:${result.index}`, job, index: result.index, status: result.status, error: result.error },
        });
      }
    }
  }
  // Newest first; a batch keeps its result order.
  items.sort((a, b) => b.at - a.at || a.order - b.order);
  const groups: DayGroup[] = [];
  for (const { at, item } of items) {
    const day = localDay(at);
    const last = groups[groups.length - 1];
    if (last && last.day === day) last.items.push(item);
    else groups.push({ day, items: [item] });
  }
  return groups;
}

/** Most images one comparison holds. */
export const MAX_COMPARE = 12;

export type CompareLayout = { kind: "row" | "column" | "grid"; columns: number };

/**
 * Drop `id` onto a comparison: on a panel (`target`), a newcomer replaces it
 * and a member swaps places with it; on the empty slot (`null`), a newcomer
 * is added at the end. Full comparisons only take replacements.
 */
export function placeInComparison(ids: readonly string[], id: string, target: number | null): string[] {
  const from = ids.indexOf(id);
  const next = [...ids];
  if (target === null || target >= ids.length) {
    if (from >= 0) {
      next.splice(from, 1);
      next.push(id);
      return next;
    }
    return ids.length >= MAX_COMPARE ? next : [...next, id];
  }
  if (from === target) return next;
  if (from >= 0) {
    [next[from], next[target]] = [next[target]!, next[from]!];
    return next;
  }
  next[target] = id;
  return next;
}

/** Columns and rows for `slots` panels in a layout (a grid's 0 columns means automatic). */
export function compareGrid(layout: CompareLayout, slots: number): { columns: number; rows: number } {
  const count = Math.max(1, slots);
  if (layout.kind === "row") return { columns: count, rows: 1 };
  if (layout.kind === "column") return { columns: 1, rows: count };
  const columns = Math.min(count, layout.columns > 0 ? layout.columns : Math.ceil(Math.sqrt(count)));
  return { columns, rows: Math.ceil(count / columns) };
}

export function isActiveJob(job: CreativeJob): boolean {
  return !FINAL_JOB_STATUSES.includes(job.status);
}

/** Jobs the queue shows: everything still running, then the latest finished. */
export function queueJobs(jobs: readonly CreativeJob[], finished = 5): CreativeJob[] {
  const active = jobs.filter(isActiveJob);
  const done = jobs.filter((job) => !isActiveJob(job)).slice(0, finished);
  return [...active, ...done];
}

export function jobProgress(job: CreativeJob): { done: number; total: number } {
  return {
    done: job.results.filter((result) => result.status === "done").length,
    total: job.results.length,
  };
}

/** A selection kept in click order; toggling removes or appends. */
export function toggleSelection(selection: readonly string[], id: string): string[] {
  return selection.includes(id) ? selection.filter((entry) => entry !== id) : [...selection, id];
}

/**
 * The selection after a click on `id`, the way photo libraries and file
 * managers do it: a plain click selects only it, ⌘/Ctrl toggles it, ⇧ selects
 * the run from the anchor (added to the selection with ⌘ as well). `order` is
 * the grid's visible order. The anchor moves to `id` except on a ⇧ click.
 */
export function selectionAfterClick(
  current: readonly string[],
  anchor: string | null,
  order: readonly string[],
  id: string,
  modifiers: { toggle: boolean; range: boolean },
): { selection: string[]; anchor: string } {
  if (modifiers.range && anchor && order.includes(anchor) && order.includes(id)) {
    const [from, to] = [order.indexOf(anchor), order.indexOf(id)].sort((a, b) => a - b);
    const run = order.slice(from, to + 1);
    const base = modifiers.toggle ? current.filter((entry) => !run.includes(entry)) : [];
    return { selection: [...base, ...run], anchor };
  }
  if (modifiers.toggle) return { selection: toggleSelection(current, id), anchor: id };
  return { selection: [id], anchor: id };
}

/** The id one step from `id` in `order` (clamped), for ← → in a grid or a preview. */
export function neighbour(order: readonly string[], id: string | null, step: number): string | null {
  if (!order.length) return null;
  const index = id ? order.indexOf(id) : -1;
  if (index < 0) return order[step < 0 ? order.length - 1 : 0] ?? null;
  return order[Math.min(order.length - 1, Math.max(0, index + step))] ?? null;
}

export type FormReference = { assetId: string; role: CreativeRole };

/** References for the form from a selection, keeping roles already chosen. */
export function referencesFromSelection(
  selection: readonly string[],
  previous: readonly FormReference[],
): FormReference[] {
  return selection.map((assetId) => previous.find((entry) => entry.assetId === assetId) ?? { assetId, role: "reference" });
}

export const ORIGIN_LABEL_KEYS: Record<CreativeOrigin, string> = {
  reference: "mcProject.creativeOriginReference",
  model: "mcProject.creativeOriginModel",
  code: "mcProject.creativeOriginCode",
  import: "mcProject.creativeOriginImport",
};

export const ROLE_HINT_KEYS: Record<CreativeRole, string> = {
  reference: "mcProject.creativeRoleReferenceHint",
  edit: "mcProject.creativeRoleEditHint",
  style: "mcProject.creativeRoleStyleHint",
};

export const ROLE_LABEL_KEYS: Record<CreativeRole, string> = {
  reference: "mcProject.creativeRoleReference",
  edit: "mcProject.creativeRoleEdit",
  style: "mcProject.creativeRoleStyle",
};

/**
 * The message that hands selected assets to a conversation: their order and
 * role are written out, so the request does not depend on a later selection.
 */
/**
 * What the chat is told about the images in 对比集: their order (as the
 * panels show them) and file paths, so "the second one" means something.
 */
export function compareContextText(assets: readonly CreativeAsset[], intro: string): string {
  if (!assets.length) return "";
  const lines = assets.map((asset, index) => `${index + 1}. ${asset.title || asset.path.split(/[\\/]/).pop()} (${asset.path})`);
  return `${intro}\n${lines.join("\n")}`;
}

export function chatHandoffText(
  assets: ReadonlyArray<{ asset: CreativeAsset; role: CreativeRole }>,
  roleLabel: (role: CreativeRole) => string,
  intro: string,
): string {
  if (!assets.length) return "";
  const lines = assets.map(
    ({ asset, role }, index) => `${index + 1}. ${roleLabel(role)}：${asset.title || asset.path.split(/[\\/]/).pop()} (${asset.path})`,
  );
  return `${intro}\n${lines.join("\n")}\n\n`;
}

/**
 * Where a project folder keeps creative files, for the preview before
 * anything is created: `<folder>/creative`, as host-core's storage rule says
 * for workspaces and resource folders alike. After creation the studio shows
 * the path host-core returns instead.
 */
export function creativeFolderOf(folder: string): string {
  const windows = folder.includes("\\") && !folder.includes("/");
  const separator = windows ? "\\" : "/";
  const trimmed = folder.replace(/[\\/]+$/, "");
  return `${trimmed || separator}${trimmed ? separator : ""}creative`;
}

export type CategoryNameError = "empty" | "dots" | "hidden" | "tooLong" | "chars" | "tooDeep" | "reserved";

/**
 * Why a category path would be refused, mirroring host-core's
 * `normalize_category` so the form can say so before sending (bugs.md B-006).
 * host-core still checks every name.
 */
export function categoryNameError(raw: string): CategoryNameError | null {
  const segments = raw
    .split(/[\\/]/)
    .map((segment) => segment.trim())
    .filter(Boolean);
  if (!segments.length) return "empty";
  if (segments.length > 6) return "tooDeep";
  for (const segment of segments) {
    if (segment === "." || segment === "..") return "dots";
    if (segment.startsWith(".")) return "hidden";
    if ([...segment].length > 60) return "tooLong";
    if ([...segment].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127 || ':*?"<>|'.includes(char))) {
      return "chars";
    }
  }
  if (segments[0] === "scripts" || segments[0] === "未分类") return "reserved";
  return null;
}
