import assert from "node:assert/strict";
import test from "node:test";
import { readTranscriptModule } from "./helpers/source-contracts.mjs";

const [transcript, assistantTurn] = await Promise.all([
  readTranscriptModule("ChatTranscript.tsx"),
  readTranscriptModule("AssistantTurn.tsx"),
]);

test("the history list keeps a non-tail live turn active", () => {
  // A steering message or system row can render after the running turn, so
  // tail position cannot decide liveness (#1949): the transcript resolves the
  // live turn from row state, and only while the live tail is in view, so the
  // reading window keeps #1900's semantics and hung rows keep #1965's
  // unsettled reading.
  assert.match(transcript, /liveTurnId = useMemo\(/);
  assert.match(
    transcript,
    /transcriptRunning \? liveHistoryTurnId\(historyEntries, tailEntry\) : undefined/,
  );
  assert.match(transcript, /liveTurnId=\{liveTurnId\}/);
  assert.match(
    assistantTurn,
    /isActive=\{entry\.kind === "assistant-turn" && entry\.id === liveTurnId\}/,
  );
  // The bail-out comparator must hear the same signal, or a settled list would
  // keep a turn that just went live frozen in its inactive rendering.
  assert.match(assistantTurn, /previous\.liveTurnId !== next\.liveTurnId/);
});
