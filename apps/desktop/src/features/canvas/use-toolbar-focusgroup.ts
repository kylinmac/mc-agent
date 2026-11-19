import { useEffect, type RefObject } from "react";

const CONTROL_SELECTOR =
  'button:not([disabled]), select:not([disabled]), input:not([disabled]), [role="button"]:not([aria-disabled="true"])';

/**
 * Roving-tabindex fallback for horizontal `role="toolbar"` containers carrying
 * `focusgroup="toolbar wrap"`. Installed ONLY when native `focusGroup` is
 * absent on `HTMLElement.prototype` so the toolbar maintains a single tab stop
 * with `ArrowLeft`/`ArrowRight` (flipped in RTL) and `Home`/`End` navigation.
 */
export function useToolbarFocusGroup(barRef: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const bar = barRef.current;
    if (!bar || typeof HTMLElement === "undefined" || "focusGroup" in HTMLElement.prototype) {
      return;
    }

    const queryItems = (): HTMLElement[] =>
      Array.from(bar.querySelectorAll<HTMLElement>(CONTROL_SELECTOR)).filter(
        (el) => el.offsetParent !== null || el.getClientRects().length > 0,
      );

    const syncInitial = () => {
      const items = queryItems();
      if (!items.length) return;
      const currentActive = items.find((el) => el.tabIndex === 0) ?? items[0]!;
      for (const el of items) {
        el.tabIndex = el === currentActive ? 0 : -1;
      }
    };
    syncInitial();

    const onFocusIn = (event: FocusEvent) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) return;
      const items = queryItems();
      if (!items.includes(target)) return;
      for (const el of items) {
        el.tabIndex = el === target ? 0 : -1;
      }
    };

    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) return;
      if (target.matches('input, textarea, select, [contenteditable="true"]')) {
        return;
      }
      const items = queryItems();
      const idx = items.indexOf(target);
      if (idx < 0 || items.length === 0) return;

      const vertical = bar.getAttribute("aria-orientation") === "vertical";
      const rtl = getComputedStyle(bar).direction === "rtl";
      const steps: Record<string, number> = vertical
        ? { ArrowDown: 1, ArrowUp: -1 }
        : { ArrowRight: rtl ? -1 : 1, ArrowLeft: rtl ? 1 : -1 };

      let nextIndex = -1;
      if (event.key in steps) {
        nextIndex = (idx + steps[event.key]! + items.length) % items.length;
      } else if (event.key === "Home") {
        nextIndex = 0;
      } else if (event.key === "End") {
        nextIndex = items.length - 1;
      }
      if (nextIndex < 0) return;

      event.preventDefault();
      const next = items[nextIndex]!;
      for (const el of items) {
        el.tabIndex = el === next ? 0 : -1;
      }
      next.focus();
    };

    const observer =
      typeof MutationObserver !== "undefined"
        ? new MutationObserver(() => syncInitial())
        : null;
    observer?.observe(bar, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["disabled", "aria-disabled"],
    });

    bar.addEventListener("focusin", onFocusIn);
    bar.addEventListener("keydown", onKeyDown);
    return () => {
      observer?.disconnect();
      bar.removeEventListener("focusin", onFocusIn);
      bar.removeEventListener("keydown", onKeyDown);
    };
  }, [barRef]);
}
