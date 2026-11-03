import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { createEventsSlice } = await import("../src/stores/slices/events-slice.ts");
const { createSessionRuntime } = await import("../src/stores/runtime/session-runtime.ts");
const { sessionModeForPlanningState } = await import("../src/stores/helpers/store-helpers.ts");

const proposal = { id: "p", sessionId: "s", turnId: "t", toolCallId: "c", kind: "plan", status: "pending", version: 1, title: "Plan", markdown: "# Plan", createdAt: "2026-11-03T00:00:00Z", updatedAt: "2026-11-03T00:00:00Z" };
function fixture() {
  const restores = [];
  let state = {
    activeSessionId: "s", sessions: [{ id: "s", mode: "plan" }], messages: [], retainedTranscripts: {},
    planCheckpoints: {}, pendingPlans: {}, planningStates: {}, runningSessions: {},
    agentStatuses: {}, pendingPermissions: {}, pendingAsks: {}, askDrafts: {}, latestTurnResults: {},
    restorePendingPlan: async id => { restores.push(id); }, refreshSessions: async () => {}, refreshQueuedPrompts: async () => {},
  };
  const access = { get: () => state, set: update => { state = { ...state, ...(typeof update === "function" ? update(state) : update) }; } };
  const runtime = createSessionRuntime(access);
  const slice = createEventsSlice({ ...access, runtime, sessionModeForPlanningState,
    withoutRecordKey: (record, key) => Object.fromEntries(Object.entries(record).filter(([id]) => id !== key)),
    openPlanArtifact() {}, notifyInteractivePrompt() {}, flushPendingSessionConfiguration: async () => {},
  });
  state.handleAgentEvent = slice.handleAgentEvent;
  return { ...access, slice, restores };
}

test("runtime reuse cannot erase a durable pending approval", () => {
  const f = fixture();
  f.slice.handlePlansChanged({ sessionId: "s", state: "awaiting_approval", proposal });
  for (const state of ["planning", "inactive"]) {
    f.slice.handleAgentEvent({ sessionId: "s", turnId: "t", ts: Date.now(), event: { type: "planning_state", state } });
    assert.equal(f.get().pendingPlans.s.id, "p");
    assert.equal(f.get().planCheckpoints.s.status, "pending");
    assert.equal(f.get().sessions[0].mode, "plan");
  }
  assert.deepEqual(f.restores, ["s", "s"]);
});

test("host approval automatically switches to Agent and tracks execution; rejection stays in Plan", () => {
  for (const action of ["approve", "reject"]) {
    const f = fixture();
    f.slice.handlePlansChanged({ sessionId: "s", state: "awaiting_approval", proposal });
    f.slice.handlePlansChanged({ sessionId: "s", state: action === "approve" ? "inactive" : "planning",
      proposal: { ...proposal, version: 2, status: action === "approve" ? "approved" : "rejected", action,
        ...(action === "approve" ? { executionId: "e", executionState: "queued" } : {}) } });
    assert.equal(f.get().pendingPlans.s, undefined);
    assert.equal(f.get().sessions[0].mode, action === "approve" ? "agent" : "plan");
    assert.equal(!!f.get().runningSessions.s, action === "approve");
  }
});

test("a finished planning turn recovers approvals even when the live notification was missed", () => {
  const f = fixture();
  f.slice.handleAgentEvent({ sessionId: "s", turnId: "t", ts: Date.now(), event: { type: "agent_end" } });
  assert.deepEqual(f.restores, ["s"]);
});
