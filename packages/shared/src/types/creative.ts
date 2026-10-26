import type { ProjectGroupRecord } from "./workspace.js";

/*
  mc-agent creative studio: the records host-core returns
  (crates/host-core/src/mc_creative.rs) and the `creative.*` methods the
  renderer may call through Main (docs/mc-agent/creative-studio.md). Main
  still checks every method and argument at the IPC boundary; these types only
  keep the three processes reading the same shapes.
*/

export type CreativeOrigin = "reference" | "model" | "code" | "import";
export type CreativeRole = "reference" | "edit" | "style";
export type CreativePurpose = "code" | "creative";

export type CreativeAsset = {
  id: string;
  groupId: string;
  origin: CreativeOrigin;
  kind: string;
  path: string;
  sha256: string;
  mime?: string | null;
  width?: number | null;
  height?: number | null;
  bytes: number;
  title: string;
  favorite: boolean;
  jobId?: string | null;
  resultIndex?: number | null;
  createdAt: number;
  removedAt?: number | null;
  /** Category folder, e.g. `角色/角色A`; empty for uncategorized. */
  category: string;
  fileExists: boolean;
};

export type CreativeCategory = { path: string; count: number };

export type CreativeJobStatus =
  | "pending"
  | "running"
  | "saving"
  | "done"
  | "partial"
  | "failed"
  | "cancelled"
  | "interrupted";

export type CreativeJobResult = {
  index: number;
  status: string;
  path?: string | null;
  assetId?: string | null;
  error?: string | null;
};

export type CreativeReferenceUse = { assetId: string; role: CreativeRole };

export type CreativeSnapshot = {
  prompt?: string;
  params?: Record<string, unknown>;
  references?: CreativeReferenceUse[];
  providerId?: string;
  modelId?: string;
  /** Category folder the results were written to. */
  category?: string;
  /** Code drawings: the command and the kept script. */
  command?: string;
  script?: { source: string; kept: string; sha256: string };
};

export type CreativeJob = {
  id: string;
  groupId: string;
  entry: "chat" | "form" | "code";
  sessionId?: string | null;
  providerId?: string | null;
  modelId?: string | null;
  snapshot: CreativeSnapshot;
  status: CreativeJobStatus;
  error?: string | null;
  createdAt: number;
  updatedAt: number;
  endedAt?: number | null;
  results: CreativeJobResult[];
};

export type CreativeLinks = {
  uses: Array<{ assetId: string; position: number; role: CreativeRole }>;
  usedBy: Array<{ assetId: string; position: number; role: CreativeRole }>;
};

export type CreativeComparison = {
  id: string;
  groupId: string;
  title: string;
  note: string;
  chosen?: string | null;
  assetIds: string[];
  createdAt: number;
  updatedAt: number;
};

export type CreativeComparisonInput = {
  title: string;
  note?: string;
  chosen?: string | null;
  assetIds: string[];
};

export type CreativeAssetFilter = {
  origin?: CreativeOrigin;
  favorite?: boolean;
  includeRemoved?: boolean;
  query?: string;
};

/** Where a project keeps its creative files: `<folder>/creative/`. */
export type CreativeStorage = {
  /** The project folder chosen (one of the group's roots). */
  folder: string;
  kind: "workspace" | "resources" | string;
  /** `<folder>/creative`, the folder new files go to. */
  base: string;
  uncategorized: string;
  scripts: string;
};

/* Creative canvas (docs/mc-agent/creative-canvas.md): plain files under
   `creative/canvas/<id>/`, read and written through host-core. */

export type CanvasElementKind = "frame" | "image" | "note" | "title";
export const CANVAS_NOTE_COLORS = ["yellow", "blue", "green", "pink", "purple", "orange", "gray"] as const;
export type CanvasNoteColor = (typeof CANVAS_NOTE_COLORS)[number];

export type CanvasElement = {
  id: string;
  type: CanvasElementKind;
  x: number;
  y: number;
  w: number;
  /** 0 for a note or title that grows with its text. */
  h: number;
  /** A frame's name strip. */
  title?: string;
  /** A note's or title's text. */
  text?: string;
  color?: CanvasNoteColor;
  assetId?: string;
  /** The frame a note is attached to. */
  boardId?: string;
  /** A frame's source revision. */
  rev: number;
  /** A frame keeps the version before the agent's last change. */
  hasPrev: boolean;
};

export type Canvas = {
  v: number;
  id: string;
  title: string;
  version: number;
  createdAt: number;
  updatedAt: number;
  /** Back to front. */
  elements: CanvasElement[];
};

export type CanvasSummary = {
  id: string;
  title: string;
  version: number;
  updatedAt: number;
  boards: number;
  path: string;
};

export type CanvasElementInput = Partial<Omit<CanvasElement, "rev" | "hasPrev" | "color" | "boardId">> & {
  /** Empty clears it. */
  color?: CanvasNoteColor | "";
  /** Empty detaches the note. */
  boardId?: string;
};

export type CanvasOp =
  | { op: "add"; element: CanvasElementInput & { type: CanvasElementKind }; html?: string }
  | { op: "update"; id: string; set?: Omit<CanvasElementInput, "id" | "type">; html?: string }
  | { op: "remove"; id: string }
  | { op: "restore"; id: string }
  | { op: "reorder"; id: string; to: "front" | "back" };

export type CanvasApplied = { canvas: Canvas; added: string[]; warnings: string[] };

/** An element of an artboard, as host-core reads it from the source. */
export type CanvasNode = {
  boardId: string;
  /** `<board>#<n>:<path>`. */
  address: string;
  tid: number;
  path: number[];
  mcId?: string | null;
  label?: string | null;
  kind: "text" | "image" | "shape" | "line" | "other";
  tag: string;
  rev: number;
};

export type CanvasAnchorKind = "element" | "board" | "canvas";
export type CanvasAnchor = {
  kind: CanvasAnchorKind;
  boardId?: string;
  address?: string;
  mcId?: string;
  label?: string;
  rev?: number;
  /** Inside the artboard for element and board anchors, else on the canvas. */
  x: number;
  y: number;
};
export type CanvasAnchorInput = {
  kind: CanvasAnchorKind;
  boardId?: string;
  /** The element's number in the served frame. */
  node?: number;
  x: number;
  y: number;
};

export type CanvasCommentMessage = { id: string; author: "user" | "agent"; text: string; at: number };
export type CanvasThread = {
  id: string;
  anchor: CanvasAnchor;
  status: "open" | "resolved";
  /** The conversation the thread was sent to. */
  agentSession?: string;
  createdAt: number;
  updatedAt: number;
  messages: CanvasCommentMessage[];
  located: {
    state: "ok" | "moved" | "boardMissing" | "board" | "canvas";
    node?: CanvasNode;
  };
};
export type CanvasComments = { version: number; threads: CanvasThread[] };

type WithCanvas<T extends object = object> = { groupId: string; canvasId: string } & T;

type WithGroup<T extends object = object> = { groupId: string } & T;

/**
 * Every `creative.*` method the renderer may call, with its parameters and
 * result. Main's allowlist is typed against these names.
 */
export type CreativeMethods = {
  "creative.purposes": { params: object; result: { purposes: Record<string, CreativePurpose> } };
  "creative.createProject": {
    /** `template`: a creative template laid out in the new `creative/`. */
    params: { folder: string; name?: string; template?: string };
    result: { group: ProjectGroupRecord };
  };
  "creative.accountImageModels": { params: object; result: { models: Record<string, string[]> } };
  "creative.setAccountImageModels": {
    params: { providerId: string; modelIds: string[] };
    result: { modelIds: string[] };
  };
  "creative.setPurpose": {
    params: WithGroup<{ purpose: CreativePurpose }>;
    result: { group: ProjectGroupRecord; purpose: CreativePurpose };
  };
  "creative.storage": { params: WithGroup; result: { storage: CreativeStorage } };
  "creative.useWorkspace": {
    params: WithGroup<{ folder: string; add?: boolean; template?: string }>;
    result: { group: ProjectGroupRecord; storage: CreativeStorage };
  };
  "creative.setStorage": { params: WithGroup<{ folder: string }>; result: { storage: CreativeStorage } };
  "creative.assets.list": { params: WithGroup<{ filter?: CreativeAssetFilter }>; result: { assets: CreativeAsset[] } };
  "creative.assets.get": {
    params: WithGroup<{ assetId: string }>;
    result: { asset: CreativeAsset; job: CreativeJob | null; links: CreativeLinks };
  };
  "creative.assets.setFavorite": {
    params: WithGroup<{ assetId: string; favorite: boolean }>;
    result: { asset: CreativeAsset };
  };
  "creative.assets.setTitle": { params: WithGroup<{ assetId: string; title: string }>; result: { asset: CreativeAsset } };
  "creative.assets.remove": { params: WithGroup<{ assetId: string }>; result: { asset: CreativeAsset } };
  "creative.assets.restore": { params: WithGroup<{ assetId: string }>; result: { asset: CreativeAsset } };
  "creative.assets.deleteFile": { params: WithGroup<{ assetId: string }>; result: { asset: CreativeAsset } };
  "creative.assets.move": {
    params: WithGroup<{ assetIds: string[]; category: string }>;
    result: { assets: CreativeAsset[] };
  };
  "creative.categories.list": { params: WithGroup; result: { categories: CreativeCategory[] } };
  "creative.categories.create": { params: WithGroup<{ path: string }>; result: { path: string } };
  "creative.categories.rename": { params: WithGroup<{ from: string; to: string }>; result: { path: string } };
  "creative.categories.delete": { params: WithGroup<{ path: string }>; result: { ok: true } };
  "creative.jobs.list": { params: WithGroup<{ limit?: number }>; result: { jobs: CreativeJob[] } };
  "creative.jobs.get": { params: WithGroup<{ jobId: string }>; result: { job: CreativeJob } };
  "creative.jobs.reconcile": { params: WithGroup; result: { registered: number } };
  "creative.comparisons.list": { params: WithGroup; result: { comparisons: CreativeComparison[] } };
  "creative.comparisons.save": {
    params: WithGroup<{ comparisonId?: string; comparison: CreativeComparisonInput }>;
    result: { comparison: CreativeComparison };
  };
  "creative.comparisons.delete": { params: WithGroup<{ comparisonId: string }>; result: { ok: true } };
  "creative.canvas.list": { params: WithGroup; result: { canvases: CanvasSummary[] } };
  "creative.canvas.create": { params: WithGroup<{ title: string }>; result: { canvas: Canvas } };
  "creative.canvas.get": {
    params: WithCanvas<{ html?: boolean; boards?: string[] }>;
    result: { canvas: Canvas; html: Record<string, string> | null };
  };
  "creative.canvas.apply": { params: WithCanvas<{ baseVersion: number; ops: CanvasOp[] }>; result: CanvasApplied };
  "creative.canvas.rename": { params: WithCanvas<{ title: string }>; result: { canvas: Canvas } };
  "creative.canvas.delete": { params: WithCanvas; result: { ok: true } };
  "creative.canvas.resolveNode": { params: WithCanvas<{ boardId: string; node: number }>; result: { node: CanvasNode } };
  "creative.canvasComments.list": { params: WithCanvas; result: { comments: CanvasComments } };
  "creative.canvasComments.add": {
    params: WithCanvas<{ anchor: CanvasAnchorInput; text: string }>;
    result: { threadId: string; comments: CanvasComments };
  };
  "creative.canvasComments.reply": {
    params: WithCanvas<{ threadId: string; text: string }>;
    result: { comments: CanvasComments };
  };
  "creative.canvasComments.setStatus": {
    params: WithCanvas<{ threadId: string; status: "open" | "resolved" }>;
    result: { comments: CanvasComments };
  };
  "creative.canvasComments.assign": {
    params: WithCanvas<{ threadId: string; sessionId: string }>;
    result: { comments: CanvasComments };
  };
  "creative.canvasComments.delete": { params: WithCanvas<{ threadId: string }>; result: { comments: CanvasComments } };
};

export type CreativeMethod = keyof CreativeMethods;
export type CreativeParams<M extends CreativeMethod> = CreativeMethods[M]["params"];
export type CreativeResult<M extends CreativeMethod> = CreativeMethods[M]["result"];

/** The methods Main lets the renderer reach directly, in one place. */
export const CREATIVE_RENDERER_METHODS = [
  "creative.purposes",
  "creative.createProject",
  "creative.accountImageModels",
  "creative.setAccountImageModels",
  "creative.setPurpose",
  "creative.storage",
  "creative.useWorkspace",
  "creative.setStorage",
  "creative.assets.list",
  "creative.assets.get",
  "creative.assets.setFavorite",
  "creative.assets.setTitle",
  "creative.assets.remove",
  "creative.assets.restore",
  "creative.assets.deleteFile",
  "creative.assets.move",
  "creative.categories.list",
  "creative.categories.create",
  "creative.categories.rename",
  "creative.categories.delete",
  "creative.jobs.list",
  "creative.jobs.get",
  "creative.jobs.reconcile",
  "creative.comparisons.list",
  "creative.comparisons.save",
  "creative.comparisons.delete",
  "creative.canvas.list",
  "creative.canvas.create",
  "creative.canvas.get",
  "creative.canvas.apply",
  "creative.canvas.rename",
  "creative.canvas.delete",
  "creative.canvas.resolveNode",
  "creative.canvasComments.list",
  "creative.canvasComments.add",
  "creative.canvasComments.reply",
  "creative.canvasComments.setStatus",
  "creative.canvasComments.assign",
  "creative.canvasComments.delete",
] as const satisfies readonly CreativeMethod[];

/** Every method in CreativeMethods is listed above, and nothing else. */
type MissingMethods = Exclude<CreativeMethod, (typeof CREATIVE_RENDERER_METHODS)[number]>;
const allListed: MissingMethods extends never ? true : false = true;
void allListed;
