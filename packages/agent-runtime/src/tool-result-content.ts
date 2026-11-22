import type { ImageContent, ToolResultMessage } from "@earendil-works/pi-ai";
import { isRecord, safeJson } from "./agent-messages.js";

type Content = ToolResultMessage["content"];
const MISSING_RESULT = "[no tool result recorded]";

export function isMissingToolResultPlaceholder(content: Content): boolean {
  return content.length === 1 && content[0].type === "text" && content[0].text === MISSING_RESULT;
}

function imageBlock(value: unknown): ImageContent | undefined {
  if (isRecord(value) && typeof value.data === "string" && typeof value.mimeType === "string") {
    return { type: "image", data: value.data, mimeType: value.mimeType };
  }
}

function isContentBlock(block: unknown): boolean {
  return isRecord(block) && (
    block.type === "text" || block.type === "image" || block.type === "audio"
    || block.type === "resource" || block.type === "resource_link"
  );
}

/** Plugins may return JSON rows or a bare block array. MCP wraps blocks in content. */
function hostBlocks(raw: unknown): Content | undefined {
  const blocks = Array.isArray(raw) ? raw : isRecord(raw) ? raw.content : undefined;
  if (!Array.isArray(blocks)) return undefined;
  if (Array.isArray(raw) && !blocks.some(isContentBlock)) return undefined;
  const content: Content = [];
  for (const block of blocks) {
    if (Array.isArray(raw) && !isContentBlock(block)) {
      content.push({ type: "text", text: safeJson(withoutInlineBinary(block)) });
      continue;
    }
    if (!isRecord(block)) continue;
    if (block.type === "text" && typeof block.text === "string") {
      content.push({ type: "text", text: block.text });
    } else if (block.type === "resource" && isRecord(block.resource) && typeof block.resource.text === "string") {
      content.push({ type: "text", text: block.resource.text });
    } else if (block.type === "resource_link" && typeof block.uri === "string") {
      const name = typeof block.name === "string" && block.name.trim() ? block.name.trim() + ": " : "";
      content.push({ type: "text", text: "[resource link] " + name + block.uri });
    } else if (block.type === "image") {
      const image = imageBlock(block);
      if (image) content.push(image);
    }
  }
  return content;
}

/** Image data and embedded resource blobs do not belong in the JSON text fallback. */
function withoutInlineBinary(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutInlineBinary);
  if (!isRecord(value)) return value;
  const next: Record<string, unknown> = Object.create(null);
  for (const [key, entry] of Object.entries(value)) {
    if (key === "data" && (value.type === "image" || value.type === "audio")) continue;
    if (key === "resource" && value.type === "resource" && isRecord(entry)) {
      const resource: Record<string, unknown> = Object.create(null);
      for (const [name, value] of Object.entries(entry)) {
        if (name !== "blob") resource[name] = withoutInlineBinary(value);
      }
      next.resource = resource;
    } else {
      next[key] = withoutInlineBinary(entry);
    }
  }
  return next;
}

export function liveToolResultContent(raw: unknown, vision: boolean): { content: Content; details: unknown } {
  const blocks = hostBlocks(raw);
  let details = raw;
  let text: string;
  let images: ImageContent[] = [];
  if (blocks) {
    text = blocks.filter((block) => block.type === "text").map((block) => block.text).join("\n")
      || JSON.stringify(withoutInlineBinary(raw), null, 2);
    if (vision) images = blocks.filter((block) => block.type === "image");
    details = Array.isArray(raw)
      ? { blocks: raw, imageCount: images.length }
      : { ...(isRecord(raw) ? raw : {}), imageCount: images.length };
  } else if (isRecord(raw) && Array.isArray(raw.images)) {
    const { images: attachments, ...rest } = raw;
    text = typeof raw.text === "string" ? raw.text : JSON.stringify(rest, null, 2);
    if (vision) images = attachments.map(imageBlock).filter((image) => image !== undefined);
    details = { ...rest, imageCount: images.length };
  } else {
    text = typeof raw === "string" ? raw : JSON.stringify(withoutInlineBinary(raw), null, 2) ?? safeJson(raw);
    if (Array.isArray(raw)) details = { blocks: raw, imageCount: 0 };
  }
  return { content: [{ type: "text", text }, ...images], details };
}

export function restoredToolContent(raw: unknown, interrupted: boolean): Content {
  const blocks = hostBlocks(raw);
  if (blocks?.length) return blocks;
  if (!blocks && raw !== null && raw !== undefined) {
    if (isRecord(raw) && Array.isArray(raw.images)) {
      const { images, ...rest } = raw;
      return [{ type: "text", text: safeJson(rest) }, ...images.map(imageBlock).filter((image) => image !== undefined)];
    }
    if (typeof raw === "string" && raw.trim()) return [{ type: "text", text: raw }];
    return [{ type: "text", text: safeJson(withoutInlineBinary(raw)) }];
  }
  return [{ type: "text", text: interrupted ? "[tool call was interrupted before a result was recorded]" : MISSING_RESULT }];
}
