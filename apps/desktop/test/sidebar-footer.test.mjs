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

// mc-agent: the app-level destinations moved from the sidebar footer to the
// app rail at the window's left edge (features/app-rail/AppRail.tsx).
const railSource = await readFile(
  new URL("../src/features/app-rail/AppRail.tsx", import.meta.url),
  "utf8",
);
const tabsSource = await readFile(
  new URL("../src/features/session-tabs/SessionTabs.tsx", import.meta.url),
  "utf8",
);

test("app rail exposes plugins, scheduled tasks and settings; notifications sit in the title bar", () => {
  assert.doesNotMatch(sidebarSource, /className="footer-actions"/);
  assert.match(railSource, /className="footer-actions app-rail-actions no-drag"/);
  assert.match(railSource, /data-nav="settings"/);
  assert.match(railSource, /data-nav="plugins"/);
  const pluginsAction = railSource.match(
    /<TooltipButton[\s\S]*?data-nav="plugins"[\s\S]*?<\/TooltipButton>/,
  )?.[0] ?? "";
  assert.match(pluginsAction, /<IconPlug size=\{16\} aria-hidden \/>/);
  assert.doesNotMatch(railSource, /data-nav="theme"/);
  assert.doesNotMatch(railSource, /<NotificationCenter/);
  assert.match(tabsSource, /<NotificationCenter \/>/);
  // Logs live in Settings → About; the rail stays down to daily controls.
  assert.doesNotMatch(railSource, /openLogs/);
  // Every action is icon-only, so each needs a label for pointer and AT users.
  const actions = railSource
    .split("<TooltipButton")
    .filter((chunk) => /className=(?:"footer-action"|\{`footer-action )/.test(chunk));
  // mc-agent: home, plugins, scheduled and settings.
  assert.equal(actions.length, 4);
  for (const action of actions) {
    const attrs = action.slice(0, action.indexOf(">"));
    assert.match(attrs, /tooltip=/);
    assert.match(attrs, /ariaLabel=/);
  }
  // All destinations report their active state to assistive tech; the
  // Plugins button also reports the Back toggle a second activation performs.
  const railAttributes = (marker) => {
    const at = railSource.indexOf(marker);
    if (at < 0) return "";
    return railSource.slice(
      railSource.lastIndexOf("<TooltipButton", at),
      railSource.indexOf("</TooltipButton>", at),
    );
  };
  assert.match(railAttributes('data-nav="settings"'), /aria-pressed=\{page === "settings"\}/);
  assert.match(railAttributes('data-nav="plugins"'), /aria-pressed=\{page === "plugins"\}/);
  assert.match(railAttributes('data-nav="scheduled"'), /aria-pressed=\{page === "scheduled"\}/);
});

test("footer sits on the sidebar content grid without a hairline", () => {
  const block = globalStyles.match(/\.sidebar-footer\s*\{[^}]+\}/)?.[0] ?? "";
  // Zero side padding keeps the chip text and trailing icon aligned with the
  // nav rows that .sidebar-body already insets by 8px. D297: the footer is set
  // apart from the nav by `margin-top: auto` and its own padding, not a rule.
  assert.match(block, /padding:\s*7px 0 2px/);
  assert.doesNotMatch(block, /border-top/);
  assert.match(globalStyles, /\.footer-build\s*\{[^}]*padding:\s*5px 8px/s);
});

test("footer action buttons share the notification trigger's hit target", () => {
  const block = globalStyles.match(/\.footer-action\s*\{[^}]+\}/)?.[0] ?? "";
  assert.match(block, /width:\s*32px/);
  assert.match(block, /height:\s*32px/);
  assert.match(block, /transition:[^;]*var\(--motion-duration-fast\)/);
});

test("build chip surfaces the version and only dots an actionable update", () => {
  assert.match(sidebarSource, /const update = useUpdateState\(\)/);
  assert.match(
    sidebarSource,
    /update\?\.status === "available" \|\| update\?\.status === "downloaded"/,
  );
  assert.match(sidebarSource, /className="footer-build-dot"/);
  // An actionable update routes to the Settings row that can act on it.
  assert.match(sidebarSource, /setSettingsAnchor\("updates\.title"\)/);
  assert.match(sidebarSource, /setSettingsTab\("about"\)/);
  assert.match(sidebarSource, /api\.updatesCheck\(\)/);
  const dot = globalStyles.match(/\.footer-build-dot\s*\{[^}]+\}/)?.[0] ?? "";
  assert.match(dot, /background:\s*var\(--ds-accent\)/);
});
