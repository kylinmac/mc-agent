/** mc-agent (bugs.md B-007): a stopped reply is a quiet state, not an error card. */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("../src/features/chat/transcript/shared.tsx", import.meta.url), "utf8");
const card = source.slice(source.indexOf("function AssistantErrorMessage"), source.indexOf("const TOOL_ACTION_KEYS"));

test("TURN_ABORTED renders a stopped line with Continue and folded details", () => {
  const stopped = card.slice(card.indexOf('error.code === "TURN_ABORTED"'), card.indexOf("const networkDetails"));
  assert.match(stopped, /className="message-stopped"/);
  assert.match(stopped, /errors\.action\.continue/);
  assert.match(stopped, /<details className="message-stopped-details">/);
  assert.doesNotMatch(stopped, /message-error\b/);
  assert.doesNotMatch(stopped, /IconCircleAlert/);
});

test("the provider shows by name, its id only as a tooltip", () => {
  assert.match(card, /state\.providers\.find\(\(provider\) => provider\.id === message\.providerId\)\?\.name/);
  assert.match(card, /<dd title=\{message\.providerId\}>\{providerName \?\? message\.providerId\}<\/dd>/);
});
