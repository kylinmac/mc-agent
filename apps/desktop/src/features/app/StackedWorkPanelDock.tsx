import {
  lazy,
  type PointerEvent as ReactPointerEvent,
  Suspense,
  useCallback,
  useEffect,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import {
  clampWorkPanelDockShare,
  readWorkPanelDockShare,
  writeWorkPanelDockShare,
} from "../../lib/work-panel-resize";

const WorkPanelBottomDock = lazy(() =>
  import("../../components/workpanel/WorkPanel").then((module) => ({
    default: module.WorkPanelBottomDock,
  })),
);

/** mc-agent: the window's height, for the portrait check of the stacked layout. */
export function useWindowHeight(): number {
  const [height, setHeight] = useState(() => window.innerHeight);
  useEffect(() => {
    const update = () => setHeight(window.innerHeight);
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, []);
  return height;
}

/**
 * mc-agent: in a narrow or portrait window the work panel sits under the
 * conversation, the same bottom form a split column uses, with the same
 * saved height share. Rendered as the last children of `.main-pane`.
 */
export function StackedWorkPanelDock() {
  const { t } = useTranslation();
  const [share, setShare] = useState(readWorkPanelDockShare);

  const startResize = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    const pane = event.currentTarget.parentElement;
    if (!pane) return;
    const rect = pane.getBoundingClientRect();
    let next = readWorkPanelDockShare();
    // A release anywhere, a cancel, or losing focus always ends the drag.
    const move = (moveEvent: PointerEvent) => {
      next = clampWorkPanelDockShare((rect.bottom - moveEvent.clientY) / rect.height);
      setShare(next);
    };
    const finish = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", finish);
      window.removeEventListener("blur", finish);
      writeWorkPanelDockShare(next);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", finish);
    window.addEventListener("pointercancel", finish);
    window.addEventListener("blur", finish);
  }, []);

  return (
    <>
      <div
        className="mc-split-dock-divider"
        role="separator"
        aria-orientation="horizontal"
        aria-label={t("mcProject.splitDockResize")}
        onPointerDown={startResize}
      />
      <div
        className="mc-split-dock mc-stacked-dock"
        data-testid="stacked-work-panel"
        style={{ flexBasis: `${share * 100}%` }}
      >
        <Suspense fallback={null}>
          <WorkPanelBottomDock />
        </Suspense>
      </div>
    </>
  );
}
