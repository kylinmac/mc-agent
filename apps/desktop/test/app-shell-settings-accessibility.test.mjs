import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const appShell = await readFile(
  new URL("../src/features/app/AppShell.tsx", import.meta.url),
  "utf8",
);
const settingsPage = await readFile(
  new URL("../src/features/settings/SettingsPage.tsx", import.meta.url),
  "utf8",
);

// mc-agent: Settings opens as a tab inside the main pane, so the chat shell
// (rail, sidebar, title bar) stays visible and interactive around it.
test("settings opens as a tab without hiding the chat shell", () => {
  const chatShell = appShell.match(
    /<div\s+className="app-chat-shell"[\s\S]*?>/,
  )?.[0];

  assert.ok(chatShell, "chat shell must exist");
  assert.doesNotMatch(chatShell, /hidden=/);
  assert.doesNotMatch(chatShell, /inert=/);
  assert.doesNotMatch(chatShell, /aria-hidden/);
  assert.match(appShell, /page === "settings" \? \([\s\S]*?className="route-surface route-page mc-settings-tab"[\s\S]*?<SettingsPage \/>/);
});

test("entering Settings moves focus to its first search control", () => {
  assert.match(settingsPage, /const settingsSearchRef = useRef<HTMLInputElement>\(null\)/);
  assert.match(
    settingsPage,
    /settingsSearchRef\.current\?\.focus\(\{ preventScroll: true \}\)/,
  );
  assert.match(settingsPage, /<input\s+ref=\{settingsSearchRef\}/);
});

test("chat code loads inside the existing route boundary and stays mounted in Settings", () => {
  assert.match(
    appShell,
    /const loadChatSurface = \(\) => import\("\.\.\/\.\.\/components\/ChatSurface"\)/,
  );
  assert.match(appShell, /const ChatSurface = lazy\(\(\) =>\s*loadChatSurface\(\)/);
  assert.match(appShell, /useEffect\(\(\) => \{\s*void loadChatSurface\(\)\.catch/);
  assert.doesNotMatch(appShell, /import \{ ChatSurface \} from/);
  assert.match(
    appShell,
    /<Suspense fallback=\{<RoutePending \/>\}>[\s\S]*?<ChatSurface visible=\{page === "chat"\} \/>[\s\S]*?<\/Suspense>/,
  );
  assert.match(
    appShell,
    /className="app-chat-shell"[\s\S]*?<ChatSurface visible=\{page === "chat"\} \/>/,
  );
});
