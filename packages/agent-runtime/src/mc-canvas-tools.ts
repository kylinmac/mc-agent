import { Type } from "@earendil-works/pi-ai";

/**
 * mc-agent creative canvas (docs/mc-agent/creative-canvas.md): the agent's
 * tools. Electron main runs them (host-local, like SaveCreativeAsset); they
 * refuse outside a creative project.
 */
export const CANVAS_TOOL_NAMES = ["CanvasRead", "CanvasWrite", "CanvasComment"] as const;

export const canvasToolDescriptions: Record<(typeof CANVAS_TOOL_NAMES)[number], string> = {
  CanvasRead:
    "Read this creative project's canvases. Without canvasId: the list of canvases. With canvasId: its elements (back to front), its version (pass it to CanvasWrite as baseVersion), the HTML of the artboards you name in boards (or all with \"all\"), and its comment threads, each marked sentToYou when it was sent to this conversation.",
  CanvasWrite: [
    "Create a canvas (give title, no canvasId) and/or change one with a batch of operations made against baseVersion (the version you last read). The batch applies all or nothing; if the canvas changed since, nothing is applied: read it again and redo the change.",
    "Operations: {op:\"add\", element:{type, id?, x, y, w, h, title?, text?, color?, assetId?, boardId?}, html?} — type frame (an artboard; html required), image (assetId of a library asset), note (text; color yellow|blue|green|pink|purple|orange|gray; boardId attaches it to an artboard), title (one bold line above a row of artboards; w is its width). {op:\"update\", id, set:{…same fields}, html?} changes fields and/or an artboard's HTML (the previous HTML is kept so the user can restore it). {op:\"remove\", id}. {op:\"restore\", id} swaps an artboard with its previous HTML. {op:\"reorder\", id, to:\"front\"|\"back\"}.",
    "Artboard HTML is a fragment checked on write: every element closed, attribute values quoted, no <!doctype>/<html>/<head>/<body>/<meta>/<link>/<iframe>/<object>/<embed>, unique data-mc-id values. Write styles inline, text as literal markup, images as <img src=\"asset:<assetId>\">; nothing loads from the network. The result lists warnings worth fixing.",
  ].join(" "),
  CanvasComment:
    "Act on a canvas comment thread. action reply (threadId, text; resolve: true also resolves it), resolve or reopen (threadId) — only for threads sent to this conversation. action add starts a thread of your own: on an element (boardId and its data-mc-id as mcId), on an artboard (boardId, x, y inside it) or on the canvas (x, y), e.g. to flag something you are unsure of.",
};

const opParameter = Type.Object(
  {
    op: Type.String({ description: "add, update, remove, restore or reorder." }),
  },
  { additionalProperties: true, description: "One element operation; see the tool description for its fields." },
);

export const canvasToolParameters: Record<(typeof CANVAS_TOOL_NAMES)[number], Parameters<typeof Type.Object>[0]> = {
  CanvasRead: {
    canvasId: Type.Optional(Type.String({ maxLength: 40, description: "The canvas to read; omit to list canvases." })),
    boards: Type.Optional(
      Type.Union([Type.Array(Type.String({ maxLength: 40 }), { maxItems: 50 }), Type.Literal("all")], {
        description: "Artboard ids whose HTML to include, or \"all\".",
      }),
    ),
    comments: Type.Optional(Type.Boolean({ description: "Include comment threads (default true)." })),
  },
  CanvasWrite: {
    canvasId: Type.Optional(Type.String({ maxLength: 40, description: "The canvas to change; omit with title to create one." })),
    title: Type.Optional(Type.String({ maxLength: 200, description: "Title of a new canvas." })),
    baseVersion: Type.Optional(Type.Number({ minimum: 1, description: "The canvas version you last read." })),
    ops: Type.Optional(Type.Array(opParameter, { maxItems: 100 })),
  },
  CanvasComment: {
    canvasId: Type.String({ maxLength: 40 }),
    action: Type.String({ description: "reply, resolve, reopen or add." }),
    threadId: Type.Optional(Type.String({ maxLength: 40 })),
    text: Type.Optional(Type.String({ maxLength: 4000 })),
    resolve: Type.Optional(Type.Boolean({ description: "With reply: also resolve the thread." })),
    boardId: Type.Optional(Type.String({ maxLength: 40 })),
    mcId: Type.Optional(Type.String({ maxLength: 40 })),
    x: Type.Optional(Type.Number()),
    y: Type.Optional(Type.Number()),
  },
};
