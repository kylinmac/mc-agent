import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { loadStyles } from "./helpers/styles.mjs";

const surfaceSource = await readFile(
  new URL("../src/components/ChatSurface.tsx", import.meta.url),
  "utf8",
);
const composerSource = await readFile(
  new URL("../src/components/Composer.tsx", import.meta.url),
  "utf8",
);
const handleSource = await readFile(
  new URL("../src/components/ConversationWidthHandles.tsx", import.meta.url),
  "utf8",
);
const styles = await loadStyles();

test("the width grip lives in the composer and the surface keeps the saved width", () => {
  assert.match(surfaceSource, /<ConversationWidthSync \/>/);
  assert.match(composerSource, /splitColumns \? null : <ChatWidthGrip \/>/);
  assert.match(handleSource, /data-testid="chat-width-grip"/);
  assert.match(handleSource, /chatContentWidthFromDrag/);
  assert.match(handleSource, /DEFAULT_CHAT_CONTENT_MAX_WIDTH/);
  assert.match(handleSource, /onDoubleClick=\{onDoubleClick\}/);
  assert.match(handleSource, /nav\.resizeChatWidth/);
});

test("the grip sits in the pane gutter beside the composer, not on the panel edge", () => {
  const grip = styles.match(/\.chat-width-grip\s*\{[\s\S]*?\}/)?.[0] ?? "";
  assert.match(grip, /position:\s*absolute/);
  // CHAT_CONTENT_WIDTH_GUTTER is 24px; the grip must stay inside it.
  const right = Number(grip.match(/right:\s*-(\d+)px/)?.[1]);
  assert.ok(right > 0 && right < 24, `grip offset ${right}px must fit the 24px gutter`);
  const mark = styles.match(/\.chat-width-grip::before\s*\{[\s\S]*?\}/)?.[0] ?? "";
  assert.match(mark, /opacity:\s*0/);
  assert.match(mark, /var\(--ds-text-primary\) 18%/);
  assert.match(styles, /\.composer-dock:hover \.chat-width-grip::before/);
  assert.match(styles, /\.chat-width-grip:hover::before/);
  assert.match(styles, /:root\[data-theme="light"\] \.chat-width-grip::before/);
  assert.match(
    styles,
    /\.chat-surface\[data-chat-resizing="true"\] \.chat-width-grip::before/,
  );
  assert.doesNotMatch(styles, /\.chat-width-handle/);
});


test("a squeezed pane keeps min\(100%, preferred\) and does not force 640px", () => {
  assert.match(styles, /--chat-content-max-width:\s*760px/);
  assert.doesNotMatch(
    styles,
    /\.app-shell\.sidebar-collapsed \.main-pane\s*\{[\s\S]*?--chat-content-max-width:\s*640px/,
  );
  assert.match(
    styles,
    /\.thread-content\s*\{[\s\S]*?width:\s*min\(100%,\s*var\(--chat-content-max-width\)\)/,
  );
});
test("dragging the width also scales the per-message prose width", () => {
  // The drag handler publishes the preferred width to every width consumer so
  // the message rows track the band (see applyPreferredWidth). Previously the
  // band widened while --chat-prose-max-width stayed frozen at the .main-pane
  // default of 760px.
  assert.match(
    handleSource,
    /setProperty\("--chat-content-max-width",\s*px\)/,
  );
  assert.match(
    handleSource,
    /setProperty\("--chat-composer-max-width",\s*px\)/,
  );
  assert.match(
    handleSource,
    /setProperty\("--chat-prose-max-width",\s*px\)/,
  );
  // The prose fallback must stay aligned with the banner default so a
  // non-dragged surface still renders both at the same width.
  assert.match(
    styles,
    /--chat-prose-max-width:\s*var\(--chat-content-max-width\)/,
  );
});
