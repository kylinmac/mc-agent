/** mc-agent: next-message suggestions in the composer. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { register } from "node:module";
import test from "node:test";

register("./helpers/ts-import-hooks.mjs", import.meta.url);
const { replyFinished, suggestsFor } = await import(
  "../src/features/chat/composer/hooks/useNextPromptSuggestion.ts"
);

test("a suggestion is asked for only when a reply in the same session ends", () => {
  assert.equal(replyFinished({ sessionId: "a", running: true }, { sessionId: "a", running: false }), true);
  assert.equal(replyFinished({ sessionId: "a", running: false }, { sessionId: "a", running: false }), false);
  assert.equal(replyFinished({ sessionId: "a", running: false }, { sessionId: "a", running: true }), false);
  assert.equal(
    replyFinished({ sessionId: "a", running: true }, { sessionId: "b", running: false }),
    false,
    "switching away from a running session is not a finished reply",
  );
  assert.equal(replyFinished({ sessionId: null, running: true }, { sessionId: null, running: false }), false);
});

test("remote and imported pi sessions are not asked", () => {
  assert.equal(suggestsFor("session-1"), true);
  assert.equal(suggestsFor("remote:h1:abc"), false);
  assert.equal(suggestsFor("native-pi:abc"), false);
  assert.equal(suggestsFor(null), false);
});

test("Tab accepts only into an empty draft, and the setting gates the request", () => {
  const input = readFileSync(new URL("../src/features/chat/composer/ComposerInput.tsx", import.meta.url), "utf8");
  const composer = readFileSync(new URL("../src/components/Composer.tsx", import.meta.url), "utf8");
  const ipc = readFileSync(new URL("../electron/main/ipc/mc-session-insight-ipc.ts", import.meta.url), "utf8");
  // The suggestion shares the plugin slot (ADR 0333): drawn only while the
  // draft is empty, and Tab takes it only when no completion claims the key.
  assert.match(input, /\{value\.length === 0 \? \(\s*suggestion \?/);
  assert.match(input, /composerSuggestionKeyAction\(event,/);
  assert.match(composer, /nextSuggestionText\s*\? \{[\s\S]*?: pluginSuggestion,/);
  assert.match(composer, /applyEditorDraft\(nextSuggestionText, \[\], nextSuggestionText\.length\)/);
  assert.match(composer, /enabled: settings\?\.promptSuggestions === true/);
  assert.match(composer, /if \(source\) nextSuggestion\.dismiss\(\)/);
  assert.match(ipc, /if \(!suggestionsEnabled \|\| !\(await suggestionsEnabled\(\)\)\) return \{ text: null \}/);
});
