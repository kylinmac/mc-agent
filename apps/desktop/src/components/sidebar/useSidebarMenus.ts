import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { placeSidebarFloatingMenuTop, SIDEBAR_FLOATING_MENU_MAX_HEIGHT, SIDEBAR_MENU_VIEWPORT_PADDING } from "../../lib/sidebar-floating-menu";

export function useSidebarMenus(hideSessionHoverCard: () => void) {
  const [sortOpen, setSortOpen] = useState(false);
  const [sessionMenu, setSessionMenu] = useState<string | null>(null);

  const [projectMenu, setProjectMenu] = useState<string | null>(null);
  // mc-agent (#41): the project "+" opens a start-folder menu in the same slot.
  const [projectMenuKind, setProjectMenuKind] = useState<"actions" | "startFolder">("actions");

  const [sectionMenu, setSectionMenu] = useState<"sessions" | "projects" | null>(null);
  const [menuPosition, setMenuPosition] = useState<{
    top: number;
    left: number;
    anchorTop: number;
    anchorBottom: number;
  } | null>(null);

  const menuTriggerRef = useRef<HTMLButtonElement | null>(null);
  const menuFirstItemRef = useRef<HTMLButtonElement | null>(null);
  const floatingMenuRef = useRef<HTMLDivElement | null>(null);

  const closeMenus = useCallback((restoreFocus = true) => {
    const trigger = menuTriggerRef.current;
    setSortOpen(false);
    setSessionMenu(null);
    setProjectMenu(null);
    setSectionMenu(null);
    setMenuPosition(null);
    if (restoreFocus && trigger) requestAnimationFrame(() => trigger.focus());
  }, []);

  const placeMenu = useCallback((event: ReactMouseEvent<HTMLButtonElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const anchor = { top: rect.top, bottom: rect.bottom };
    setMenuPosition({
      top: placeSidebarFloatingMenuTop(
        anchor,
        SIDEBAR_FLOATING_MENU_MAX_HEIGHT,
        window.innerHeight,
      ),
      left: Math.max(SIDEBAR_MENU_VIEWPORT_PADDING, rect.right + 4),
      anchorTop: anchor.top,
      anchorBottom: anchor.bottom,
    });
  }, []);

  // Body-level sidebar menus always anchor their left edge to the right side
  // of the trigger or pointer; they never flip to the left at the viewport edge.
  const placeMenuAtPoint = useCallback((x: number, y: number) => {
    const anchor = { top: y, bottom: y };
    setMenuPosition({
      top: placeSidebarFloatingMenuTop(
        anchor,
        SIDEBAR_FLOATING_MENU_MAX_HEIGHT,
        window.innerHeight,
      ),
      left: Math.max(SIDEBAR_MENU_VIEWPORT_PADDING, x + 4),
      anchorTop: anchor.top,
      anchorBottom: anchor.bottom,
    });
  }, []);

  const openSessionRowMenu = useCallback(
    (sessionId: string, trigger: HTMLButtonElement | null) => {
      menuTriggerRef.current = trigger;
      setSortOpen(false);
      setProjectMenu(null);
      setSectionMenu(null);
      hideSessionHoverCard();
      setSessionMenu(sessionId);
    },
    [hideSessionHoverCard],
  );

  const openProjectRowMenu = useCallback(
    (
      projectKey: string,
      trigger: HTMLButtonElement | null,
      kind: "actions" | "startFolder" = "actions",
    ) => {
      menuTriggerRef.current = trigger;
      setSortOpen(false);
      setSessionMenu(null);
      setSectionMenu(null);
      setProjectMenuKind(kind);
      setProjectMenu(projectKey);
    },
    [],
  );

  const openSectionMenu = useCallback(
    (section: "sessions" | "projects", x: number, y: number) => {
      menuTriggerRef.current = null;
      setSortOpen(false);
      setSessionMenu(null);
      setProjectMenu(null);
      placeMenuAtPoint(x, y);
      setSectionMenu(section);
    },
    [placeMenuAtPoint],
  );

  useEffect(() => {
    if (!sortOpen && !sessionMenu && !projectMenu && !sectionMenu) return;
    const onPointer = (e: PointerEvent) => {
      // Right-click must not dismiss first; contextmenu handlers reopen create menus.
      if (e.button === 2 || (e.pointerType === "mouse" && e.buttons === 2)) return;
      const target = e.target as Node;
      if ((target as Element)?.closest?.(
        ".sidebar-popover, .sidebar-row-menu, .notification-popover-portaled",
      )) return;
      closeMenus(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      closeMenus();
    };
    const onViewportChange = () => closeMenus(false);
    window.addEventListener("pointerdown", onPointer);
    window.addEventListener("keydown", onKey);
    window.addEventListener("resize", onViewportChange);
    return () => {
      window.removeEventListener("pointerdown", onPointer);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", onViewportChange);
    };
  }, [sortOpen, sessionMenu, projectMenu, sectionMenu, closeMenus]);

  useEffect(() => {
    if (!sessionMenu && !projectMenu && !sectionMenu && !sortOpen) return;
    requestAnimationFrame(() => menuFirstItemRef.current?.focus());
  }, [sessionMenu, projectMenu, sectionMenu, sortOpen]);

  const menuAnchorTop = menuPosition?.anchorTop;
  const menuAnchorBottom = menuPosition?.anchorBottom;

  useLayoutEffect(() => {
    if (menuAnchorTop === undefined || menuAnchorBottom === undefined) return;
    const menu = floatingMenuRef.current;
    if (!menu) return;

    const reposition = () => {
      const top = placeSidebarFloatingMenuTop(
        { top: menuAnchorTop, bottom: menuAnchorBottom },
        menu.getBoundingClientRect().height,
        window.innerHeight,
      );
      setMenuPosition((current) =>
        current && current.top !== top ? { ...current, top } : current,
      );
    };

    reposition();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(reposition);
    observer.observe(menu);
    return () => observer.disconnect();
  }, [
    menuAnchorTop,
    menuAnchorBottom,
    sessionMenu,
    projectMenu,
    sectionMenu,
    sortOpen,
  ]);

  return {
    sortOpen,
    setSortOpen,
    sessionMenu,
    setSessionMenu,
    projectMenu,
    setProjectMenu,
    projectMenuKind,
    sectionMenu,
    setSectionMenu,
    menuPosition,
    menuTriggerRef,
    menuFirstItemRef,
    floatingMenuRef,
    closeMenus,
    placeMenu,
    placeMenuAtPoint,
    openSessionRowMenu,
    openProjectRowMenu,
    openSectionMenu,
  };
}
