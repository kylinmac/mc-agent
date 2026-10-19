/*
  mc-agent: open tabs in the title bar. A tab is a conversation (its session
  id) or an app page ("page:plugins", "page:scheduled", "page:settings"). The
  list keeps the order tabs were opened in (unlike the most-recently-used
  order of retained panes) and lives only in this browser profile.
*/

export const MAX_TABS = 20;
export const PAGE_TABS = ["plugins", "scheduled", "settings"] as const;
export type PageTab = (typeof PAGE_TABS)[number];
const PAGE_PREFIX = "page:";

export function pageTabKey(page: PageTab): string {
  return `${PAGE_PREFIX}${page}`;
}

/** The page a tab key opens, or null for a conversation tab. */
export function tabPage(key: string): PageTab | null {
  if (!key.startsWith(PAGE_PREFIX)) return null;
  const page = key.slice(PAGE_PREFIX.length);
  return (PAGE_TABS as readonly string[]).includes(page) ? (page as PageTab) : null;
}

/** The tab key of what is on screen: the page, or the conversation. */
export function activeTabKey(page: string, activeSessionId: string | null | undefined): string | null {
  if ((PAGE_TABS as readonly string[]).includes(page)) return pageTabKey(page as PageTab);
  return page === "chat" && activeSessionId ? activeSessionId : null;
}

const STORAGE_KEY = "mc.sessionTabs";

/** Add `id` after the existing tabs; the oldest tab drops past MAX_TABS. */
export function openTab(tabs: readonly string[], id: string, keep?: string): string[] {
  if (!id || tabs.includes(id)) return [...tabs];
  const next = [...tabs, id];
  while (next.length > MAX_TABS) {
    const drop = next.findIndex((tab) => tab !== keep && tab !== id);
    next.splice(drop < 0 ? 0 : drop, 1);
  }
  return next;
}

/**
 * Close `id`. When it was the active tab, `next` is the tab to show instead:
 * the one to its right, else to its left, else null (no tabs left).
 */
export function closeTab(
  tabs: readonly string[],
  id: string,
  activeId: string | null,
): { tabs: string[]; next: string | null; closedActive: boolean } {
  const index = tabs.indexOf(id);
  if (index < 0) return { tabs: [...tabs], next: null, closedActive: false };
  const rest = tabs.filter((tab) => tab !== id);
  if (id !== activeId) return { tabs: rest, next: null, closedActive: false };
  return { tabs: rest, next: rest[index] ?? rest[index - 1] ?? null, closedActive: true };
}

/** Drop conversation tabs whose session no longer exists. */
export function pruneTabs(tabs: readonly string[], known: ReadonlySet<string>): string[] {
  return tabs.filter((tab) => tabPage(tab) !== null || known.has(tab));
}

export function loadTabs(): string[] {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed)
      ? parsed.filter((id): id is string => typeof id === "string").slice(0, MAX_TABS)
      : [];
  } catch {
    return [];
  }
}

export function saveTabs(tabs: readonly string[]): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(tabs));
  } catch {
    // Tabs are a convenience; without storage they last for this window only.
  }
}
