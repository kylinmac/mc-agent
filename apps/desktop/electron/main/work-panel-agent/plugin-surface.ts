import { randomUUID } from "node:crypto";
import type { WebContents } from "electron";
import { flattenAxTree, type AxNode } from "../browser-cdp";
import { withAgentInput } from "./agent-input-gate";

type Surface = { wc: WebContents; current: () => boolean };
type Snapshot = { token: string; uids: Map<string, number>; sessionId: string; current: () => boolean };
const snapshots = new WeakMap<WebContents, Snapshot>();
let resolveSurface: ((resource: string, sessionId: string) => Surface) | undefined;
export function setPluginPanelResolver(resolve: NonNullable<typeof resolveSurface>) { resolveSurface = resolve; }

/** Fixed UI operations only: no arbitrary renderer JS or plugin process calls. */
export async function pluginPanelOperation(resource: string, sessionId: string, args: Record<string, unknown>, signal: AbortSignal) {
  const surface = resolveSurface?.(resource, sessionId);
  if (!surface) throw new Error("Plugin panel unavailable");
  const { wc, current } = surface;
  const guard = () => {
    signal.throwIfAborted();
    if (wc.isDestroyed() || !current()) throw new Error("Plugin panel changed session, closed or became hidden; read it again");
  };
  const send = async (method: string, params: Record<string, unknown> = {}) => {
    guard();
    const result: unknown = await wc.debugger.sendCommand(method, params);
    guard();
    return result;
  };
  guard();
  if (args.action === "screenshot") {
    const image = await wc.capturePage();
    guard();
    const size = image.getSize();
    const scaled = size.width > 1280 ? image.resize({ width: 1280 }) : image;
    return { text: "Visible plugin panel", images: [{ mimeType: "image/png", data: scaled.toPNG().toString("base64") }] };
  }
  if (!wc.debugger.isAttached()) wc.debugger.attach("1.3");
  if (args.action === "read") {
    const { nodes } = await send("Accessibility.getFullAXTree") as { nodes?: Array<AxNode & {
      value?: { value?: string }; properties?: Array<{ name?: string; value?: { value?: unknown } }>;
    }> };
    const readable = (nodes ?? []).map(node => {
      const protectedValue = node.properties?.some(property => property.name === "protected" && property.value?.value === true);
      const value = protectedValue ? undefined : node.value?.value;
      return typeof value === "string" && value
        ? { ...node, name: { value: `${node.name?.value ?? ""}\nValue: ${value.slice(0, 32768)}` } }
        : node;
    });
    const { tree, uids } = flattenAxTree(readable);
    const token = randomUUID();
    snapshots.set(wc, { token, uids, sessionId, current });
    return { tree: tree.slice(0, 65536), truncated: tree.length > 65536, snapshot: token,
      note: "Live UI, including visible unsaved editor text. Virtualized offscreen content may be absent. Use click/type/key to edit through the editor and its normal save/conflict controls.",
      actions: ["click", "type", "key"] };
  }
  const snapshot = snapshots.get(wc);
  if (!snapshot || snapshot.sessionId !== sessionId || snapshot.token !== args.snapshot || !snapshot.current()) throw new Error("Stale plugin snapshot; read the panel again");
  snapshots.delete(wc); // Consume once, before any asynchronous input.
  const uid = typeof args.uid === "string" ? args.uid : "";
  const { blocked } = await withAgentInput(wc, async () => {
  if (args.action === "click" || args.action === "type") {
    const backendNodeId = snapshot.uids.get(uid);
    if (!backendNodeId) throw new Error("Unknown element; read the panel again");
    if (args.action === "click") {
      await send("DOM.scrollIntoViewIfNeeded", { backendNodeId });
      const { model } = await send("DOM.getBoxModel", { backendNodeId }) as { model: { content: number[] } };
      const quad = model.content;
      const x = (quad[0] + quad[2] + quad[4] + quad[6]) / 4;
      const y = (quad[1] + quad[3] + quad[5] + quad[7]) / 4;
      await send("Input.dispatchMouseEvent", { type: "mousePressed", button: "left", x, y, clickCount: 1 });
      await send("Input.dispatchMouseEvent", { type: "mouseReleased", button: "left", x, y, clickCount: 1 });
    } else {
      if (typeof args.text !== "string" || args.text.length > 65536) throw new Error("Invalid text");
      await send("DOM.focus", { backendNodeId });
      await send("Input.insertText", { text: args.text });
    }
  } else if (args.action === "key") {
    const keys: Record<string, { key: string; code: number; modifiers?: number }> = {
      Enter: { key: "Enter", code: 13 }, Escape: { key: "Escape", code: 27 }, Tab: { key: "Tab", code: 9 },
      Backspace: { key: "Backspace", code: 8 }, Delete: { key: "Delete", code: 46 },
      ArrowUp: { key: "ArrowUp", code: 38 }, ArrowDown: { key: "ArrowDown", code: 40 },
      ArrowLeft: { key: "ArrowLeft", code: 37 }, ArrowRight: { key: "ArrowRight", code: 39 },
      SelectAll: { key: "a", code: 65, modifiers: process.platform === "darwin" ? 4 : 2 },
      Save: { key: "s", code: 83, modifiers: process.platform === "darwin" ? 4 : 2 },
      Undo: { key: "z", code: 90, modifiers: process.platform === "darwin" ? 4 : 2 },
    };
    const key = keys[String(args.key)];
    if (!key) throw new Error("Unsupported key");
    await send("Input.dispatchKeyEvent", { type: "keyDown", key: key.key, windowsVirtualKeyCode: key.code, modifiers: key.modifiers ?? 0 });
    await send("Input.dispatchKeyEvent", { type: "keyUp", key: key.key, windowsVirtualKeyCode: key.code, modifiers: key.modifiers ?? 0 });
  } else throw new Error("Unsupported plugin panel action");
  });
  snapshots.delete(wc);
  return { ok: true, note: "Read the panel again to verify the result and get a fresh snapshot.",
    ...(blocked.length ? { linksNotOpened: blocked, linkNote: "Links are not opened from agent input. Tell the user the address instead." } : {}) };
}
