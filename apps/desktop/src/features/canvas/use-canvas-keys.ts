import { useEffect } from "react";
import type { Tool } from "./CanvasToolbar";

function editableTarget(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName));
}

/**
 * The canvas's keys: Escape steps out of what is open; Space pans; V / H / C
 * pick a tool; ⌘Z / ⇧⌘Z undo and redo; Delete removes the selection.
 */
export function useCanvasKeys({
  stage,
  pointerInside,
  composer,
  openThread,
  entered,
  selected,
  setComposer,
  setOpenThread,
  setEntered,
  setSpaceHeld,
  setSelected,
  setNodes,
  setTool,
  undo,
  removeElements,
}: {
  stage: { current: HTMLDivElement | null };
  /** Whether the pointer is over this canvas. */
  pointerInside: { current: boolean };
  composer: object | null;
  openThread: string | null;
  entered: string | null;
  selected: string[];
  setComposer: (value: null) => void;
  setOpenThread: (value: null) => void;
  setEntered: (value: null) => void;
  setSpaceHeld: (value: boolean) => void;
  setSelected: (value: []) => void;
  setNodes: (value: []) => void;
  setTool: (tool: Tool) => void;
  undo: (direction: "undo" | "redo") => Promise<void>;
  removeElements: (ids: readonly string[]) => Promise<void>;
}) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const node = stage.current;
      if (!node?.isConnected) return;
      // Escape always steps out of what is open here, unless the user is
      // typing somewhere else in the window.
      if (event.type === "keydown" && event.key === "Escape" && (composer || openThread || entered)) {
        const outside = editableTarget(event.target) && !node.closest(".mc-canvas")?.contains(event.target as Node);
        if (!outside) {
          if (composer) setComposer(null);
          else if (openThread) setOpenThread(null);
          else setEntered(null);
          return;
        }
      }
      // Other keys only while the pointer or focus is on this canvas: it
      // shares the window with the conversation.
      if (!pointerInside.current && !node.closest(".mc-canvas")?.matches(":focus-within")) {
        if (event.type === "keyup" && event.key === " ") setSpaceHeld(false);
        return;
      }
      if (event.key === " " && !editableTarget(event.target)) {
        if (event.type === "keydown") {
          if (!event.repeat) setSpaceHeld(true);
          event.preventDefault();
        } else setSpaceHeld(false);
        return;
      }
      if (event.type !== "keydown" || editableTarget(event.target)) return;
      const mod = event.metaKey || event.ctrlKey;
      if (event.key === "Escape") {
        setSelected([]);
        setNodes([]);
        return;
      }
      if (mod && event.key.toLowerCase() === "z") {
        event.preventDefault();
        void undo(event.shiftKey ? "redo" : "undo");
        return;
      }
      if (mod) return;
      if ((event.key === "Delete" || event.key === "Backspace") && selected.length) {
        event.preventDefault();
        void removeElements(selected);
        return;
      }
      const tools: Record<string, Tool> = { v: "select", h: "hand", c: "comment" };
      const next = tools[event.key.toLowerCase()];
      if (next) setTool(next);
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("keyup", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("keyup", onKey);
    };
  }, [composer, entered, openThread, pointerInside, removeElements, selected, setComposer, setEntered, setNodes, setOpenThread, setSelected, setSpaceHeld, setTool, stage, undo]);
}
