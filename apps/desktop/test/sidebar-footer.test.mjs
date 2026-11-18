import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { loadStyles } from "./helpers/styles.mjs";

const sidebarSource = await readFile(
  new URL("../src/components/Sidebar.tsx", import.meta.url),
  "utf8",
);
const globalStyles = await loadStyles();
const zhLocale = await readFile(
  new URL("../../../packages/i18n/src/locales/zh-CN/index.ts", import.meta.url),
  "utf8",
);
const enLocale = await readFile(
  new URL("../../../packages/i18n/src/locales/en/index.ts", import.meta.url),
  "utf8",
);

test("the sidebar footer is an action bar, not a fabricated identity", () => {
  // The app has no accounts; an avatar with a name implied one that never existed.
  assert.doesNotMatch(sidebarSource, /footer-profile/);
  assert.doesNotMatch(sidebarSource, /profile-menu/);
  assert.doesNotMatch(sidebarSource, /sidebar-profile-menu/);
  assert.doesNotMatch(sidebarSource, /IconUser/);
  assert.doesNotMatch(globalStyles, /\.footer-profile/);
  assert.doesNotMatch(globalStyles, /\.profile-menu/);
  for (const locale of [zhLocale, enLocale]) {
    assert.doesNotMatch(locale, /localProfile:/);
    assert.doesNotMatch(locale, /openProfileMenu:/);
  }
});

// mc-agent (MC-ADR-0029): app-level destinations consolidated from the
// standalone leftmost AppRail into SidebarFooter (`features/app-rail/SidebarFooter.tsx`),
// and the Creative Studio entry is retired (R35).
const footerSource = await readFile(
  new URL("../src/features/app-rail/SidebarFooter.tsx", import.meta.url),
  "utf8",
);
const tabsSource = await readFile(
  new URL("../src/features/session-tabs/SessionTabs.tsx", import.meta.url),
  "utf8",
);

test("sidebar footer dock exposes home, plugins, scheduled tasks and settings without creative; notifications sit in the title bar", () => {
  assert.match(sidebarSource, /<SidebarFooter \/>/);
  assert.match(footerSource, /className="mc-sidebar-footer no-drag"/);
  assert.match(footerSource, /data-nav="settings"/);
  assert.match(footerSource, /data-nav="plugins"/);
  assert.doesNotMatch(footerSource, /data-nav="creative"/);
  const pluginsAction = footerSource.match(
    /<TooltipButton[\s\S]*?data-nav="plugins"[\s\S]*?<\/TooltipButton>/,
  )?.[0] ?? "";
  assert.match(pluginsAction, /<IconPlug size=\{15\} aria-hidden \/>/);
  assert.doesNotMatch(footerSource, /data-nav="theme"/);
  assert.doesNotMatch(footerSource, /<NotificationCenter/);
  assert.match(tabsSource, /<NotificationCenter \/>/);
  assert.doesNotMatch(footerSource, /openLogs/);
  const actions = footerSource
    .split("<TooltipButton")
    .filter((chunk) => /className=(?:"footer-action"|\{`footer-action )/.test(chunk));
  // home, plugins, scheduled, settings, plus plugin view slot template (5 total).
  assert.equal(actions.length, 5);
  assert.match(footerSource, /data-nav=\{`rail-view:\$\{view\.ref\}`\}/);
  for (const action of actions) {
    const attrs = action.slice(0, action.indexOf(">"));
    assert.match(attrs, /tooltip=/);
    assert.match(attrs, /ariaLabel=/);
  }
  const footerAttributes = (marker) => {
    const at = footerSource.indexOf(marker);
    if (at < 0) return "";
    return footerSource.slice(
      footerSource.lastIndexOf("<TooltipButton", at),
      footerSource.indexOf("</TooltipButton>", at),
    );
  };
  assert.match(footerAttributes('data-nav="settings"'), /aria-pressed=\{page === "settings"\}/);
  assert.match(footerAttributes('data-nav="plugins"'), /aria-pressed=\{page === "plugins"\}/);
  assert.match(footerAttributes('data-nav="scheduled"'), /aria-pressed=\{page === "scheduled"\}/);
});

test("footer sits on the sidebar content grid without a hairline", () => {
  const block = globalStyles.match(/\.sidebar-footer\s*\{[^}]+\}/)?.[0] ?? "";
  // Zero side padding keeps the chip text and trailing icon aligned with the
  // nav rows that .sidebar-body already insets by 8px. D297: the footer is set
  // apart from the nav by `margin-top: auto` and its own padding, not a rule.
  assert.match(block, /padding:\s*7px 0 2px/);
  assert.doesNotMatch(block, /border-top/);
});

test("footer action buttons share the notification trigger's hit target", () => {
  const block = globalStyles.match(/\.footer-action\s*\{[^}]+\}/)?.[0] ?? "";
  assert.match(block, /width:\s*32px/);
  assert.match(block, /height:\s*32px/);
  assert.match(block, /transition:[^;]*var\(--motion-duration-fast\)/);
});

test("mc-agent: the sidebar has no version chip; updates live in the app rail", () => {
  // bugs.md B-013: the chip showed upstream's PI-Desktop version.
  assert.doesNotMatch(sidebarSource, /footer-build/);
  assert.doesNotMatch(sidebarSource, /useUpdateState\(\)/);
});
