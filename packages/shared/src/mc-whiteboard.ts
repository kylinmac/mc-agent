/**
 * mc-agent Excalidraw whiteboard helpers (MC-ADR-0030 / R38).
 *
 * Pure TypeScript (zero DOM / Electron / Node-fs imports) shared between
 * `agent-runtime`, Electron Main (`canvas-tools`), and the Renderer:
 * 1. Session-scoped `groupId` encoding (`session:<sessionId>`) for non-project chats.
 * 2. Compact structural summarization of Excalidraw scenes for `CanvasRead` & chat context.
 * 3. Deterministic `whiteboardOps` -> Excalidraw scene builder so `CanvasWrite` can draw
 *    labeled shapes, frames, text, lines, and bound `startId -> endId` arrows from Node.js.
 */

export const SESSION_CANVAS_GROUP_PREFIX = "session:";

export function sessionCanvasGroupId(sessionId: string): string {
  return `${SESSION_CANVAS_GROUP_PREFIX}${sessionId.trim()}`;
}

export function parseSessionCanvasGroupId(groupId: string): string | null {
  if (!groupId.startsWith(SESSION_CANVAS_GROUP_PREFIX)) return null;
  const id = groupId.slice(SESSION_CANVAS_GROUP_PREFIX.length).trim();
  return id.length > 0 && id.length <= 128 && !/[\u0000-\u001f/\\]/.test(id) ? id : null;
}

export type CanvasWhiteboardBinaryFile = {
  id: string;
  mimeType: string;
  dataURL: string;
  created?: number;
};

export type CanvasWhiteboardScene = {
  elements: Record<string, unknown>[];
  appState?: {
    viewBackgroundColor?: string;
    gridSize?: number | null;
  };
};

export type WhiteboardShapeKind =
  | "rectangle"
  | "ellipse"
  | "diamond"
  | "text"
  | "arrow"
  | "line"
  | "frame";

export type WhiteboardElementInput = {
  id?: string;
  type?: WhiteboardShapeKind;
  x?: number;
  y?: number;
  w?: number;
  h?: number;
  /** End coordinate for `line` / `arrow` when `points` or `endId` is not used. */
  toX?: number;
  toY?: number;
  /** Relative `[dx, dy]` polyline points for `line` / `arrow`. */
  points?: Array<[number, number]>;
  /** Text content for `text`, frame name for `frame`, or centered bound label on shapes/arrows. */
  text?: string;
  label?: string;
  strokeColor?: string;
  backgroundColor?: string;
  strokeWidth?: number;
  strokeStyle?: "solid" | "dashed" | "dotted";
  fontSize?: number;
  /** Source shape id for `arrow` auto-binding. */
  startId?: string;
  /** Target shape id for `arrow` auto-binding. */
  endId?: string;
};

export type WhiteboardOp =
  | { op: "add"; element: WhiteboardElementInput & { type: WhiteboardShapeKind } }
  | ({ op: "add"; type: WhiteboardShapeKind } & WhiteboardElementInput)
  | { op: "update"; id: string; set: Omit<WhiteboardElementInput, "id" | "type"> }
  | ({ op: "update"; id: string } & Omit<WhiteboardElementInput, "id" | "type">)
  | { op: "remove"; id: string }
  | { op: "clear" };

export type WhiteboardElementSummary = {
  id: string;
  type: string;
  x: number;
  y: number;
  w: number;
  h: number;
  text?: string;
  strokeColor?: string;
  backgroundColor?: string;
  startId?: string;
  endId?: string;
  fileId?: string;
};

export type WhiteboardSceneSummary = {
  totalElements: number;
  imageCount: number;
  elements: WhiteboardElementSummary[];
};

const VALID_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function finiteNum(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.round(value) : fallback;
}

function hashSeed(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h | 0) || 1;
}

function makeShortId(prefix: string, index: number): string {
  const rand = Math.random().toString(36).slice(2, 8);
  return `${prefix}_${Date.now().toString(36)}_${index}_${rand}`;
}

function estimateTextBox(text: string, fontSize: number): { w: number; h: number } {
  const lines = text.split(/\r?\n/);
  const maxWidth = lines.reduce((acc, line) => {
    let units = 0;
    for (const ch of line) {
      units += ch.charCodeAt(0) > 0xff ? 1.05 : 0.62;
    }
    return Math.max(acc, Math.ceil(units * fontSize));
  }, fontSize);
  return {
    w: Math.max(24, maxWidth + 8),
    h: Math.max(Math.round(fontSize * 1.25), Math.round(lines.length * fontSize * 1.25)),
  };
}

/**
 * Summarize a raw Excalidraw scene into a compact, LLM-friendly structural digest.
 * Bound text elements (`containerId`) are folded onto their parent container's `text`
 * field so shapes and labeled arrows read naturally as single semantic nodes.
 */
export function summarizeWhiteboardScene(
  scene: CanvasWhiteboardScene | null | undefined,
  options?: { onlyIds?: ReadonlySet<string>; maxElements?: number },
): WhiteboardSceneSummary {
  const raw = Array.isArray(scene?.elements) ? scene.elements : [];
  const active = raw.filter((el) => isRecord(el) && el.isDeleted !== true);
  const boundTextByContainer = new Map<string, string>();
  for (const el of active) {
    if (el.type === "text" && typeof el.containerId === "string" && typeof el.text === "string" && el.text.trim()) {
      boundTextByContainer.set(el.containerId, el.text.trim());
    }
  }

  let imageCount = 0;
  let totalCount = 0;
  const summaries: WhiteboardElementSummary[] = [];
  const limit = options?.maxElements ?? 120;

  for (const el of active) {
    const id = typeof el.id === "string" ? el.id : "";
    if (!id) continue;
    // Skip bound text nodes whose parent container is also active; they appear as parent `text`.
    if (el.type === "text" && typeof el.containerId === "string" && active.some((p) => p.id === el.containerId)) {
      continue;
    }
    if (options?.onlyIds && !options.onlyIds.has(id)) continue;

    totalCount += 1;
    const type = typeof el.type === "string" ? el.type : "unknown";
    if (type === "image") imageCount += 1;

    const rawText =
      typeof el.text === "string" && el.text.trim()
        ? el.text.trim()
        : typeof el.name === "string" && el.name.trim()
          ? el.name.trim()
          : boundTextByContainer.get(id);

    const startBinding = isRecord(el.startBinding) && typeof el.startBinding.elementId === "string"
      ? el.startBinding.elementId
      : undefined;
    const endBinding = isRecord(el.endBinding) && typeof el.endBinding.elementId === "string"
      ? el.endBinding.elementId
      : undefined;

    if (summaries.length < limit) {
      summaries.push({
        id,
        type,
        x: finiteNum(el.x),
        y: finiteNum(el.y),
        w: finiteNum(el.width),
        h: finiteNum(el.height),
        ...(rawText ? { text: rawText.slice(0, 300) } : {}),
        ...(typeof el.strokeColor === "string" ? { strokeColor: el.strokeColor } : {}),
        ...(typeof el.backgroundColor === "string" && el.backgroundColor !== "transparent"
          ? { backgroundColor: el.backgroundColor }
          : {}),
        ...(startBinding ? { startId: startBinding } : {}),
        ...(endBinding ? { endId: endBinding } : {}),
        ...(type === "image" && typeof el.fileId === "string" ? { fileId: el.fileId } : {}),
      });
    }
  }

  return {
    totalElements: totalCount,
    imageCount,
    elements: summaries,
  };
}

function anchorBetweenBoxes(
  from: { x: number; y: number; w: number; h: number },
  to: { x: number; y: number; w: number; h: number },
): { start: [number, number]; end: [number, number] } {
  const fromCx = from.x + from.w / 2;
  const fromCy = from.y + from.h / 2;
  const toCx = to.x + to.w / 2;
  const toCy = to.y + to.h / 2;
  const dx = toCx - fromCx;
  const dy = toCy - fromCy;
  const gap = 6;

  if (Math.abs(dx) >= Math.abs(dy)) {
    if (dx >= 0) {
      return {
        start: [Math.round(from.x + from.w + gap), Math.round(fromCy)],
        end: [Math.round(to.x - gap), Math.round(toCy)],
      };
    }
    return {
      start: [Math.round(from.x - gap), Math.round(fromCy)],
      end: [Math.round(to.x + to.w + gap), Math.round(toCy)],
    };
  }
  if (dy >= 0) {
    return {
      start: [Math.round(fromCx), Math.round(from.y + from.h + gap)],
      end: [Math.round(toCx), Math.round(to.y - gap)],
    };
  }
  return {
    start: [Math.round(fromCx), Math.round(from.y - gap)],
    end: [Math.round(toCx), Math.round(to.y + to.h + gap)],
  };
}

function baseExcalidrawFields(id: string, now: number) {
  return {
    id,
    angle: 0,
    fillStyle: "solid",
    strokeWidth: 2,
    strokeStyle: "solid",
    roughness: 1,
    opacity: 100,
    groupIds: [] as string[],
    frameId: null,
    seed: hashSeed(id),
    version: 1,
    versionNonce: hashSeed(`${id}:${now}`),
    isDeleted: false,
    boundElements: [] as Array<{ id: string; type: string }>,
    updated: now,
    link: null,
    locked: false,
  };
}

function addBoundReference(target: Record<string, unknown>, ref: { id: string; type: string }) {
  const list = Array.isArray(target.boundElements)
    ? (target.boundElements as Array<{ id: string; type: string }>).filter(
        (entry) => isRecord(entry) && entry.id !== ref.id,
      )
    : [];
  target.boundElements = [...list, ref];
  target.version = finiteNum(target.version, 1) + 1;
}

function makeBoundLabelId(parentId: string, findActive: (id: string) => unknown): string {
  const base = `${parentId.slice(0, 56)}_label`;
  if (!findActive(base)) return base;
  for (let seq = 2; seq < 1000; seq += 1) {
    const candidate = `${parentId.slice(0, 52)}_lbl${seq}`;
    if (!findActive(candidate)) return candidate;
  }
  return `${parentId.slice(0, 48)}_lbl_${Date.now().toString(36).slice(-8)}`;
}

/**
 * Apply structured `WhiteboardOp[]` to an Excalidraw scene, returning the updated
 * scene and the IDs added in operation order. Throws with `INVALID_ARGUMENT:` /
 * `NOT_FOUND:` / `CONFLICT:` prefixes matching `host-core` RPC error mapping.
 */
export function applyWhiteboardOpsToScene(
  current: CanvasWhiteboardScene | null | undefined,
  ops: readonly WhiteboardOp[],
): { scene: CanvasWhiteboardScene; added: string[] } {
  if (!ops.length) {
    throw new Error("INVALID_ARGUMENT: whiteboardOps must not be empty");
  }
  if (ops.length > 100) {
    throw new Error("INVALID_ARGUMENT: at most 100 whiteboard operations at once");
  }

  let elements: Record<string, unknown>[] = (Array.isArray(current?.elements) ? current.elements : [])
    .filter((el) => isRecord(el) && el.isDeleted !== true)
    .map((el) => ({ ...el }));
  const added: string[] = [];
  const now = Date.now();

  const findActive = (id: string) => elements.find((el) => el.id === id && el.isDeleted !== true);

  ops.forEach((op, index) => {
    if (!isRecord(op) || typeof op.op !== "string") {
      throw new Error(`INVALID_ARGUMENT: invalid whiteboard op at index ${index}`);
    }
    if (op.op === "clear") {
      elements = [];
      return;
    }
    if (op.op === "remove") {
      const target = findActive(op.id);
      if (!target) {
        throw new Error(`NOT_FOUND: no whiteboard element ${op.id}`);
      }
      const removeIds = new Set<string>([op.id]);
      for (const el of elements) {
        if (el.type === "text" && el.containerId === op.id && typeof el.id === "string") {
          removeIds.add(el.id);
        }
      }
      elements = elements
        .filter((el) => typeof el.id !== "string" || !removeIds.has(el.id))
        .map((el) => {
          const next: Record<string, unknown> = { ...el };
          if (Array.isArray(el.boundElements)) {
            next.boundElements = (el.boundElements as Array<{ id?: string }>).filter(
              (b) => !b?.id || !removeIds.has(b.id),
            );
          }
          if (isRecord(el.startBinding) && typeof el.startBinding.elementId === "string" && removeIds.has(el.startBinding.elementId)) {
            next.startBinding = null;
          }
          if (isRecord(el.endBinding) && typeof el.endBinding.elementId === "string" && removeIds.has(el.endBinding.elementId)) {
            next.endBinding = null;
          }
          return next;
        });
      return;
    }

    if (op.op === "add") {
      const rawOp = op as Record<string, unknown>;
      const input = (isRecord(rawOp.element) ? rawOp.element : rawOp) as WhiteboardElementInput;
      if (!isRecord(input) || typeof input.type !== "string") {
        throw new Error(`INVALID_ARGUMENT: added whiteboard element needs a type (op ${index + 1})`);
      }
      const type = input.type as WhiteboardShapeKind;
      if (!["rectangle", "ellipse", "diamond", "text", "arrow", "line", "frame"].includes(type)) {
        throw new Error(`INVALID_ARGUMENT: unsupported whiteboard type ${String(type)} (op ${index + 1})`);
      }
      const id = input.id?.trim() || makeShortId(type[0] ?? "e", index);
      if (!VALID_ID.test(id)) {
        throw new Error(`INVALID_ARGUMENT: invalid element id ${id}`);
      }
      if (findActive(id)) {
        throw new Error(`CONFLICT: whiteboard element ${id} already exists`);
      }

      const strokeColor = input.strokeColor?.trim() || "#1e1e1e";
      const backgroundColor = input.backgroundColor?.trim() || "transparent";
      const strokeWidth = input.strokeWidth && Number.isFinite(input.strokeWidth) ? Math.max(1, Math.min(8, input.strokeWidth)) : 2;
      const strokeStyle = input.strokeStyle && ["solid", "dashed", "dotted"].includes(input.strokeStyle) ? input.strokeStyle : "solid";
      const fontSize = input.fontSize && Number.isFinite(input.fontSize) ? Math.max(12, Math.min(72, Math.round(input.fontSize))) : 20;
      const labelText = (input.label ?? input.text ?? "").trim();

      if (type === "text") {
        const content = labelText || "Text";
        const box = estimateTextBox(content, fontSize);
        elements.push({
          ...baseExcalidrawFields(id, now),
          type: "text",
          x: finiteNum(input.x, 0),
          y: finiteNum(input.y, 0),
          width: input.w ? Math.max(20, finiteNum(input.w, box.w)) : box.w,
          height: input.h ? Math.max(20, finiteNum(input.h, box.h)) : box.h,
          strokeColor,
          backgroundColor: "transparent",
          roundness: null,
          text: content,
          originalText: content,
          autoResize: true,
          fontSize,
          fontFamily: 1,
          textAlign: "left",
          verticalAlign: "top",
          containerId: null,
          lineHeight: 1.25,
        });
        added.push(id);
        return;
      }

      if (type === "arrow" || type === "line") {
        let x = finiteNum(input.x, 0);
        let y = finiteNum(input.y, 0);
        let points: Array<[number, number]>;
        let startBinding: Record<string, unknown> | null = null;
        let endBinding: Record<string, unknown> | null = null;

        const startEl = type === "arrow" && input.startId ? findActive(input.startId) : undefined;
        const endEl = type === "arrow" && input.endId ? findActive(input.endId) : undefined;

        if (startEl && endEl) {
          const anchors = anchorBetweenBoxes(
            { x: finiteNum(startEl.x), y: finiteNum(startEl.y), w: finiteNum(startEl.width, 120), h: finiteNum(startEl.height, 60) },
            { x: finiteNum(endEl.x), y: finiteNum(endEl.y), w: finiteNum(endEl.width, 120), h: finiteNum(endEl.height, 60) },
          );
          x = anchors.start[0];
          y = anchors.start[1];
          points = [
            [0, 0],
            [anchors.end[0] - x, anchors.end[1] - y],
          ];
          startBinding = { elementId: startEl.id, focus: 0, gap: 6 };
          endBinding = { elementId: endEl.id, focus: 0, gap: 6 };
          addBoundReference(startEl, { id, type: "arrow" });
          addBoundReference(endEl, { id, type: "arrow" });
        } else if (Array.isArray(input.points) && input.points.length >= 2) {
          points = input.points.map(([px, py]) => [finiteNum(px), finiteNum(py)]);
        } else {
          const dx = input.toX !== undefined ? finiteNum(input.toX) - x : finiteNum(input.w, 160);
          const dy = input.toY !== undefined ? finiteNum(input.toY) - y : finiteNum(input.h, 0);
          points = [
            [0, 0],
            [dx === 0 && dy === 0 ? 120 : dx, dy],
          ];
          if (startEl) {
            startBinding = { elementId: startEl.id, focus: 0, gap: 6 };
            addBoundReference(startEl, { id, type: "arrow" });
          }
          if (endEl) {
            endBinding = { elementId: endEl.id, focus: 0, gap: 6 };
            addBoundReference(endEl, { id, type: "arrow" });
          }
        }

        const xs = points.map((p) => p[0]);
        const ys = points.map((p) => p[1]);
        const width = Math.max(1, Math.max(...xs) - Math.min(...xs));
        const height = Math.max(1, Math.max(...ys) - Math.min(...ys));
        const arrowEl: Record<string, unknown> = {
          ...baseExcalidrawFields(id, now),
          type,
          x,
          y,
          width,
          height,
          strokeColor,
          backgroundColor: "transparent",
          strokeWidth,
          strokeStyle,
          roundness: { type: 2 },
          points,
          lastCommittedPoint: null,
          startBinding,
          endBinding,
          startArrowhead: null,
          endArrowhead: type === "arrow" ? "arrow" : null,
        };
        elements.push(arrowEl);
        if (labelText && type === "arrow") {
          const textId = makeBoundLabelId(id, findActive);
          const box = estimateTextBox(labelText, 16);
          addBoundReference(arrowEl, { id: textId, type: "text" });
          const midX = x + (points[points.length - 1]![0] - box.w) / 2;
          const midY = y + (points[points.length - 1]![1] - box.h) / 2;
          elements.push({
            ...baseExcalidrawFields(textId, now),
            type: "text",
            x: Math.round(midX),
            y: Math.round(midY),
            width: box.w,
            height: box.h,
            strokeColor,
            backgroundColor: "transparent",
            roundness: null,
            text: labelText,
            originalText: labelText,
            autoResize: true,
            fontSize: 16,
            fontFamily: 1,
            textAlign: "center",
            verticalAlign: "middle",
            containerId: id,
            lineHeight: 1.25,
          });
        }
        added.push(id);
        return;
      }

      // rectangle | ellipse | diamond | frame
      const x = finiteNum(input.x, 0);
      const y = finiteNum(input.y, 0);
      const w = Math.max(32, finiteNum(input.w, type === "frame" ? 640 : 180));
      const h = Math.max(32, finiteNum(input.h, type === "frame" ? 420 : 80));

      const shapeEl: Record<string, unknown> = {
        ...baseExcalidrawFields(id, now),
        type,
        x,
        y,
        width: w,
        height: h,
        strokeColor,
        backgroundColor,
        strokeWidth,
        strokeStyle,
        roundness: type === "frame" ? null : { type: type === "diamond" ? 2 : 3 },
        ...(type === "frame" ? { name: labelText || null } : {}),
      };
      elements.push(shapeEl);

      if (labelText && type !== "frame") {
        const textId = makeBoundLabelId(id, findActive);
        const box = estimateTextBox(labelText, fontSize);
        addBoundReference(shapeEl, { id: textId, type: "text" });
        elements.push({
          ...baseExcalidrawFields(textId, now),
          type: "text",
          x: Math.round(x + (w - box.w) / 2),
          y: Math.round(y + (h - box.h) / 2),
          width: box.w,
          height: box.h,
          strokeColor,
          backgroundColor: "transparent",
          roundness: null,
          text: labelText,
          originalText: labelText,
          autoResize: true,
          fontSize,
          fontFamily: 1,
          textAlign: "center",
          verticalAlign: "middle",
          containerId: id,
          lineHeight: 1.25,
        });
      }
      added.push(id);
      return;
    }

    if (op.op === "update") {
      const target = findActive(op.id);
      if (!target) {
        throw new Error(`NOT_FOUND: no whiteboard element ${op.id}`);
      }
      const rawOp = op as Record<string, unknown>;
      const set = (isRecord(rawOp.set) ? rawOp.set : rawOp) as Omit<WhiteboardElementInput, "id" | "type">;
      const geomChanged =
        set.x !== undefined || set.y !== undefined || set.w !== undefined || set.h !== undefined;
      if (set.x !== undefined) target.x = finiteNum(set.x, finiteNum(target.x));
      if (set.y !== undefined) target.y = finiteNum(set.y, finiteNum(target.y));
      if (set.w !== undefined) target.width = Math.max(16, finiteNum(set.w, finiteNum(target.width, 100)));
      if (set.h !== undefined) target.height = Math.max(16, finiteNum(set.h, finiteNum(target.height, 60)));
      if (set.strokeColor !== undefined) target.strokeColor = set.strokeColor.trim() || "#1e1e1e";
      if (set.backgroundColor !== undefined) target.backgroundColor = set.backgroundColor.trim() || "transparent";
      if (set.strokeWidth !== undefined && Number.isFinite(set.strokeWidth)) {
        target.strokeWidth = Math.max(1, Math.min(8, set.strokeWidth));
      }
      if (set.strokeStyle && ["solid", "dashed", "dotted"].includes(set.strokeStyle)) {
        target.strokeStyle = set.strokeStyle;
      }
      const nextLabel = set.label !== undefined ? set.label : set.text;
      if (nextLabel !== undefined) {
        const trimmed = nextLabel.trim();
        if (target.type === "text") {
          const fs = set.fontSize ?? finiteNum(target.fontSize, 20);
          const box = estimateTextBox(trimmed || " ", fs);
          target.text = trimmed;
          target.originalText = trimmed;
          target.fontSize = fs;
          if (set.w === undefined) target.width = box.w;
          if (set.h === undefined) target.height = box.h;
        } else if (target.type === "frame") {
          target.name = trimmed || null;
        } else {
          const existingBound = elements.find(
            (el) => el.type === "text" && el.containerId === op.id && el.isDeleted !== true,
          );
          if (!trimmed) {
            if (existingBound) {
              elements = elements.filter((el) => el !== existingBound);
              if (Array.isArray(target.boundElements)) {
                target.boundElements = (target.boundElements as Array<{ id?: string }>).filter(
                  (b) => b?.id !== existingBound.id,
                );
              }
            }
          } else if (existingBound) {
            const fs = set.fontSize ?? finiteNum(existingBound.fontSize, 20);
            const box = estimateTextBox(trimmed, fs);
            existingBound.text = trimmed;
            existingBound.originalText = trimmed;
            existingBound.fontSize = fs;
            existingBound.width = box.w;
            existingBound.height = box.h;
            existingBound.x = Math.round(finiteNum(target.x) + (finiteNum(target.width) - box.w) / 2);
            existingBound.y = Math.round(finiteNum(target.y) + (finiteNum(target.height) - box.h) / 2);
            existingBound.version = finiteNum(existingBound.version, 1) + 1;
            existingBound.updated = now;
          } else {
            const textId = makeBoundLabelId(op.id, findActive);
            const fs = set.fontSize ?? 20;
            const box = estimateTextBox(trimmed, fs);
            addBoundReference(target, { id: textId, type: "text" });
            elements.push({
              ...baseExcalidrawFields(textId, now),
              type: "text",
              x: Math.round(finiteNum(target.x) + (finiteNum(target.width) - box.w) / 2),
              y: Math.round(finiteNum(target.y) + (finiteNum(target.height) - box.h) / 2),
              width: box.w,
              height: box.h,
              strokeColor: typeof target.strokeColor === "string" ? target.strokeColor : "#1e1e1e",
              backgroundColor: "transparent",
              roundness: null,
              text: trimmed,
              originalText: trimmed,
              autoResize: true,
              fontSize: fs,
              fontFamily: 1,
              textAlign: "center",
              verticalAlign: "middle",
              containerId: op.id,
              lineHeight: 1.25,
            });
          }
        }
      } else if (geomChanged && target.type !== "arrow" && target.type !== "line") {
        const existingBound = elements.find(
          (el) => el.type === "text" && el.containerId === op.id && el.isDeleted !== true,
        );
        if (existingBound) {
          existingBound.x = Math.round(
            finiteNum(target.x) + (finiteNum(target.width) - finiteNum(existingBound.width)) / 2,
          );
          existingBound.y = Math.round(
            finiteNum(target.y) + (finiteNum(target.height) - finiteNum(existingBound.height)) / 2,
          );
          existingBound.version = finiteNum(existingBound.version, 1) + 1;
          existingBound.updated = now;
        }
      }
      if (geomChanged) {
        for (const arrow of elements) {
          if (arrow.type !== "arrow" || arrow.isDeleted === true) continue;
          const startId = isRecord(arrow.startBinding) && typeof arrow.startBinding.elementId === "string"
            ? arrow.startBinding.elementId
            : undefined;
          const endId = isRecord(arrow.endBinding) && typeof arrow.endBinding.elementId === "string"
            ? arrow.endBinding.elementId
            : undefined;
          if (startId !== op.id && endId !== op.id) continue;
          const sEl = startId ? findActive(startId) : undefined;
          const eEl = endId ? findActive(endId) : undefined;
          if (!sEl || !eEl) continue;
          const anchors = anchorBetweenBoxes(
            { x: finiteNum(sEl.x), y: finiteNum(sEl.y), w: finiteNum(sEl.width, 120), h: finiteNum(sEl.height, 60) },
            { x: finiteNum(eEl.x), y: finiteNum(eEl.y), w: finiteNum(eEl.width, 120), h: finiteNum(eEl.height, 60) },
          );
          const dx = anchors.end[0] - anchors.start[0];
          const dy = anchors.end[1] - anchors.start[1];
          arrow.x = anchors.start[0];
          arrow.y = anchors.start[1];
          arrow.points = [
            [0, 0],
            [dx, dy],
          ];
          arrow.width = Math.max(1, Math.abs(dx));
          arrow.height = Math.max(1, Math.abs(dy));
          arrow.version = finiteNum(arrow.version, 1) + 1;
          arrow.updated = now;
          const arrowLabel = elements.find(
            (el) => el.type === "text" && el.containerId === arrow.id && el.isDeleted !== true,
          );
          if (arrowLabel) {
            arrowLabel.x = Math.round(anchors.start[0] + (dx - finiteNum(arrowLabel.width)) / 2);
            arrowLabel.y = Math.round(anchors.start[1] + (dy - finiteNum(arrowLabel.height)) / 2);
            arrowLabel.version = finiteNum(arrowLabel.version, 1) + 1;
            arrowLabel.updated = now;
          }
        }
      }
      target.version = finiteNum(target.version, 1) + 1;
      target.versionNonce = hashSeed(`${op.id}:${now}:${target.version}`);
      target.updated = now;
    }
  });

  return {
    scene: {
      elements,
      ...(current?.appState ? { appState: current.appState } : {}),
    },
    added,
  };
}
