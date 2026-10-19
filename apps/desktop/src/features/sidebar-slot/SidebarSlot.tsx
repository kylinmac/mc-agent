import { useCallback, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { create } from "zustand";

/*
  mc-agent: lets a page put its own navigation where the sidebar's
  conversation list sits (settings does, MC-ADR-0004). The sidebar hosts an
  empty slot; a page portals into it while the slot exists and renders in
  place otherwise (for example while the sidebar is collapsed).
*/
const useSlotStore = create<{ element: HTMLElement | null; setElement: (element: HTMLElement | null) => void }>(
  (set) => ({ element: null, setElement: (element) => set({ element }) }),
);

export function SidebarSlotHost() {
  const setElement = useSlotStore((s) => s.setElement);
  const ref = useCallback((node: HTMLDivElement | null) => setElement(node), [setElement]);
  return <div ref={ref} className="mc-sidebar-slot" />;
}

export function IntoSidebarSlot({ children }: { children: ReactNode }) {
  const element = useSlotStore((s) => s.element);
  return element ? createPortal(children, element) : <>{children}</>;
}
