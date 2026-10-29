import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const cardSource = await readFile(new URL("../src/components/AskToolCard.tsx", import.meta.url), "utf8");
const styleSource = await readFile(new URL("../src/styles/messages.css", import.meta.url), "utf8");

function customAnswerKeyDown(source) {
  const start = source.indexOf('className="asktool-custom-input"');
  const end = source.indexOf("autoFocus", start);
  assert.ok(start > -1 && end > start, "custom answer field must exist");
  return source.slice(start, end);
}

// #39: Enter in the custom answer answers like the primary button.
test("Enter in the custom answer submits; Shift+Enter and IME confirm do not", () => {
  const field = customAnswerKeyDown(cardSource);
  assert.match(cardSource, /<Textarea\s+className="asktool-custom-input"/);
  assert.match(field, /onKeyDown=\{\(event\) => \{/);
  const shiftGuard = field.indexOf('event.key !== "Enter" || event.shiftKey');
  const imeGuard = field.indexOf("event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229");
  const submit = field.indexOf("next();");
  assert.ok(shiftGuard > -1, "Shift+Enter must fall through to a newline");
  assert.ok(imeGuard > -1, "the IME confirm keystroke must not submit");
  assert.ok(submit > imeGuard && imeGuard > shiftGuard, "guards run before submitting");
  assert.match(field, /event\.preventDefault\(\);\s*if \(!resolving\) next\(\);/);
  assert.match(styleSource, /\.asktool-custom-input\s*\{[^}]*resize:\s*none;[^}]*field-sizing:\s*content;/);
});
