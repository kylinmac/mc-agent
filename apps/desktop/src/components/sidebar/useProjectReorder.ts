import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import {
  projectGroupKeyFromPoint,
  projectReorderInsertAfter,
  projectReorderShouldArm,
  sameProjectReorderBucket,
} from "../../lib/sidebar-project-reorder";
import type { ProjectEntry } from "./project-entry";
type ProjectReorderPointerState = {
  pointerId: number;
  projectKey: string;
  startX: number;
  startY: number;
  lastX: number;
  lastY: number;
  armed: boolean;
  dropKey: string | null;
  dropTop: number;
  dropHeight: number;
  insertAfter: boolean;
  onMove: (event: PointerEvent) => void;
  onUp: (event: PointerEvent) => void;
  onCancel: (event: PointerEvent) => void;
};
export function useProjectReorder(projectEntries: ProjectEntry[], reorderProjects: (keys: string[]) => void) {
  const [draggingProjectKey, setDraggingProjectKey] = useState<string | null>(null);
  const [dropIndicator, setDropIndicator] = useState<{ key: string; insertAfter: boolean } | null>(null);

  const projectReorderRef = useRef<ProjectReorderPointerState | null>(null);
  const suppressProjectTitleClickRef = useRef(false);
  const projectEntriesRef = useRef<ProjectEntry[]>([]);
  const reorderProjectEntriesRef = useRef<(
    sourceKey: string,
    targetKey: string,
    insertAfter: boolean,
  ) => void>(() => {});

  projectEntriesRef.current = projectEntries;

  const finishProjectReorderPress = useCallback((opts?: { keepClickSuppressed?: boolean }) => {
    const state = projectReorderRef.current;
    if (state) {
      window.removeEventListener("pointermove", state.onMove, true);
      window.removeEventListener("pointerup", state.onUp, true);
      window.removeEventListener("pointercancel", state.onCancel, true);
      projectReorderRef.current = null;
    }
    if (!opts?.keepClickSuppressed) suppressProjectTitleClickRef.current = false;
    setDraggingProjectKey(null);
    setDropIndicator(null);
    document.documentElement.removeAttribute("data-project-reordering");
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (!projectReorderRef.current) return;
      event.preventDefault();
      finishProjectReorderPress();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      finishProjectReorderPress();
    };
  }, [finishProjectReorderPress]);

  const reorderProjectEntries = useCallback(
    (sourceKey: string, targetKey: string, insertAfter: boolean) => {
      if (!sourceKey || !targetKey || sourceKey === targetKey) return;
      const keys = projectEntries.map((entry) => entry.key);
      const sourceIndex = keys.indexOf(sourceKey);
      const targetIndex = keys.indexOf(targetKey);
      if (sourceIndex < 0 || targetIndex < 0) return;
      const source = projectEntries[sourceIndex];
      const target = projectEntries[targetIndex];
      if (!sameProjectReorderBucket(source.meta, target.meta)) {
        return;
      }
      keys.splice(sourceIndex, 1);
      const nextTargetIndex = keys.indexOf(targetKey) + (insertAfter ? 1 : 0);
      keys.splice(nextTargetIndex, 0, sourceKey);
      reorderProjects(keys);
    },
    [projectEntries, reorderProjects],
  );
  reorderProjectEntriesRef.current = reorderProjectEntries;

  const beginProjectReorderPress = useCallback(
    (event: ReactPointerEvent<HTMLButtonElement>, projectKey: string) => {
      if (event.button !== 0 || event.pointerType === "touch" || projectReorderRef.current) {
        return;
      }

      const onMove = (moveEvent: PointerEvent) => {
        const current = projectReorderRef.current;
        if (!current || current.pointerId !== moveEvent.pointerId) return;
        current.lastX = moveEvent.clientX;
        current.lastY = moveEvent.clientY;
        if (!current.armed) {
          if (
            !projectReorderShouldArm(
              moveEvent.clientX - current.startX,
              moveEvent.clientY - current.startY,
            )
          ) {
            return;
          }
          current.armed = true;
          suppressProjectTitleClickRef.current = true;
          document.documentElement.setAttribute("data-project-reordering", "true");
          setDraggingProjectKey(current.projectKey);
        }
        moveEvent.preventDefault();
        const target = projectGroupKeyFromPoint(moveEvent.clientX, moveEvent.clientY);
        const source = projectEntriesRef.current.find((entry) => entry.key === current.projectKey);
        const destination = target
          ? projectEntriesRef.current.find((entry) => entry.key === target.key)
          : undefined;
        if (
          target &&
          source &&
          destination &&
          target.key !== current.projectKey &&
          sameProjectReorderBucket(source.meta, destination.meta)
        ) {
          const insertAfter = projectReorderInsertAfter(
            moveEvent.clientY,
            target.top,
            target.height,
          );
          current.dropKey = target.key;
          current.dropTop = target.top;
          current.dropHeight = target.height;
          current.insertAfter = insertAfter;
          setDropIndicator({ key: target.key, insertAfter });
        } else {
          current.dropKey = null;
          setDropIndicator(null);
        }
      };

      const onUp = (upEvent: PointerEvent) => {
        const current = projectReorderRef.current;
        if (!current || current.pointerId !== upEvent.pointerId) return;
        if (current.armed) {
          upEvent.preventDefault();
          if (current.dropKey) {
            reorderProjectEntriesRef.current(
              current.projectKey,
              current.dropKey,
              current.insertAfter,
            );
          }
          finishProjectReorderPress({ keepClickSuppressed: true });
          return;
        }
        finishProjectReorderPress();
      };

      const onCancel = (cancelEvent: PointerEvent) => {
        const current = projectReorderRef.current;
        if (!current || current.pointerId !== cancelEvent.pointerId) return;
        finishProjectReorderPress();
      };

      const state: ProjectReorderPointerState = {
        pointerId: event.pointerId,
        projectKey,
        startX: event.clientX,
        startY: event.clientY,
        lastX: event.clientX,
        lastY: event.clientY,
        armed: false,
        dropKey: null,
        dropTop: 0,
        dropHeight: 0,
        insertAfter: false,
        onMove,
        onUp,
        onCancel,
      };
      projectReorderRef.current = state;
      window.addEventListener("pointermove", onMove, true);
      window.addEventListener("pointerup", onUp, true);
      window.addEventListener("pointercancel", onCancel, true);
    },
    [finishProjectReorderPress],
  );

  const moveProjectWithKeyboard = useCallback(
    (event: ReactKeyboardEvent<HTMLButtonElement>, projectKey: string) => {
      if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
      const index = projectEntries.findIndex((entry) => entry.key === projectKey);
      const target = projectEntries[index + (event.key === "ArrowUp" ? -1 : 1)];
      if (!target) return;
      event.preventDefault();
      event.stopPropagation();
      reorderProjectEntries(projectKey, target.key, event.key === "ArrowDown");
    },
    [projectEntries, reorderProjectEntries],
  );

  return {
    draggingProjectKey,
    dropIndicator,
    suppressProjectTitleClickRef,
    beginProjectReorderPress,
    moveProjectWithKeyboard,
    projectReorderRef,
  };
}
