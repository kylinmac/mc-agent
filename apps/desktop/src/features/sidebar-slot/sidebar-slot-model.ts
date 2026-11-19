/**
 * Pages whose own navigation occupies the left sidebar via `IntoSidebarSlot`.
 * While one of these routes is active, the sidebar stays expanded, hides its
 * collapse button, and ignores sidebar-collapse shortcuts/gestures.
 */
export function pagePinsSidebar(page: string | null | undefined): boolean {
  return page === "settings" || page === "plugins" || page === "scheduled";
}
