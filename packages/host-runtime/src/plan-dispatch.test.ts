import { afterEach, describe, expect, it, vi } from "vitest";
import type { PlanExecution } from "@pi-desktop/shared";

import type { HostRpc } from "./host-ports.js";
import type { LaunchResolver, ResolvedLaunch } from "./launch-resolver.js";
import { PlanExecutionDispatcher, type PlanExecutionDispatcherOptions } from "./plan-dispatch.js";
import type { RuntimeSidecarLink } from "./runtime-service.js";

const execution: PlanExecution = {
  id: "execution-1", proposalId: "proposal-1", sessionId: "s1", kind: "plan",
  plan: "Implement the approved plan", title: "Plan", question: "Proceed?",
  artifact: { relativePath: "plan.md", sha256: "abc", sizeBytes: 1 },
  targetPermissionMode: "auto", state: "queued",
};

const launchResult: ResolvedLaunch = {
  providerId: "p1", modelId: "m1",
  sidecarParams: {
    sessionId: "s1", mode: "agent",
    provider: { id: "p1", name: "Fixture", modelId: "m1", apiKey: "", supportsReasoning: false, supportedThinkingLevels: ["off"] },
  },
};

function build() {
  const calls: Array<{ method: string; params: unknown }> = [];
  const host: HostRpc = {
    async call<T>(method: string, params?: Record<string, unknown>): Promise<T> {
      calls.push({ method, params });
      switch (method) {
        case "plans.claimExecution": return { execution: { ...execution, state: "running" } } as T;
        case "session.get": return { session: { id: "s1" } } as T;
        case "settings.get":
        case "plans.finishExecution": return {} as T;
        default: throw new Error(`unexpected host call ${method}`);
      }
    },
  };
  const sidecar: RuntimeSidecarLink = {
    async call<T>(method: string, params?: unknown): Promise<T> {
      calls.push({ method, params });
      return { accepted: true } as T;
    },
    onNotification: () => () => undefined,
    onExit: () => () => undefined,
    setProjectInstructionRoot: () => undefined,
    clearProjectInstructionRoot: () => undefined,
    clearVendorAuthBindings: () => undefined,
  };
  const runtime: PlanExecutionDispatcherOptions["runtime"] = {
    withSessionOperation: async (_sessionId, operation) => operation(),
    activeTurnId: () => undefined,
    beginTurn: vi.fn(async () => "turn-1"),
    finishTurn: vi.fn(async () => undefined),
    onTurnEnded: () => () => undefined,
  };
  const launch: LaunchResolver = { resolve: vi.fn(async () => launchResult) };
  const dispatcher = new PlanExecutionDispatcher({ getHost: () => host, getSidecar: () => sidecar, runtime, launch, log: () => undefined });
  return { dispatcher, runtime, launch, calls };
}

afterEach(() => vi.useRealTimers());

describe("PlanExecutionDispatcher lifecycle", () => {
  it("shares a busy-session retry and starts the plan once the session is free", async () => {
    vi.useFakeTimers();
    const { dispatcher, runtime, calls } = build();
    runtime.activeTurnId = () => "submitting-turn";
    await dispatcher.dispatchApprovedPlan(execution);
    await dispatcher.dispatchApprovedPlan(execution);
    expect(vi.getTimerCount()).toBe(1);

    runtime.activeTurnId = () => undefined;
    await vi.advanceTimersByTimeAsync(250);

    expect(runtime.beginTurn).toHaveBeenCalledOnce();
    expect(calls.filter((call) => call.method === "agent.executeApprovedPlan")).toHaveLength(1);
    expect(dispatcher.executionForSession("s1")).toBe(execution.id);
    dispatcher.dispose();
  });

  it("cancels a busy-session retry when disposed", async () => {
    vi.useFakeTimers();
    const { dispatcher, runtime, calls } = build();
    runtime.activeTurnId = () => "submitting-turn";
    await dispatcher.dispatchApprovedPlan(execution);
    expect(vi.getTimerCount()).toBe(1);

    dispatcher.dispose();
    runtime.activeTurnId = () => undefined;
    await vi.advanceTimersByTimeAsync(250);

    expect(calls).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("settles a claimed execution without starting work if disposed while resolving its launch", async () => {
    const { dispatcher, runtime, launch, calls } = build();
    let release!: (value: ResolvedLaunch) => void;
    const pendingLaunch = new Promise<ResolvedLaunch>((resolve) => { release = resolve; });
    launch.resolve = vi.fn(() => pendingLaunch);
    const dispatch = dispatcher.dispatchApprovedPlan(execution);
    await vi.waitFor(() => expect(launch.resolve).toHaveBeenCalledOnce());

    dispatcher.dispose();
    release(launchResult);
    await dispatch;

    expect(runtime.beginTurn).not.toHaveBeenCalled();
    expect(calls.some((call) => call.method === "agent.executeApprovedPlan")).toBe(false);
    expect(calls).toContainEqual({ method: "plans.finishExecution", params: {
      executionId: execution.id, status: "interrupted", errorCode: "PLAN_EXECUTION_INTERRUPTED",
    } });
  });
});
