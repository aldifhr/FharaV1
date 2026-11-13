/**
 * e2e 2026-11-09 night (task B2): after a stall-triggered replan the task
 * sat at running/planning with no further events. The planner call now
 * runs under a watchdog that fails the task with a visible reason; the
 * decision advisor uses the planner fallback CTO and otherwise records the
 * deterministic fallback; deadline/idle aborts are failures, a user stop
 * is `cancelled`.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  PlanningStalledError,
  finishOnPlanningError,
  isPlanningStalledError,
  withPlanningWatchdog,
} from "../src/services/runner/planning";
import { finishCancelledTask } from "../src/services/runner/terminal";
import { decide } from "../src/orchestrator/decision";
import { decideWithLlm, pickDecisionAdvisor } from "../src/orchestrator/decisionLlm";
import { CAPABILITY, type AgentDefinition } from "../src/types";

function fakeApi() {
  const events: Array<{ type: string; payload?: unknown; level?: string }> = [];
  const completed: Array<{ status: string; errorMessage?: string }> = [];
  const lifecycle: string[] = [];
  return {
    events,
    completed,
    lifecycle,
    api: {
      logEvent: vi.fn(async (e: { type: string; payload?: unknown; level?: string }) => {
        events.push(e);
      }),
      completeTask: vi.fn(async (c: { status: string; errorMessage?: string }) => {
        completed.push(c);
        return { applied: true };
      }),
      recordLifecycle: vi.fn(async (l: { state: string }) => {
        lifecycle.push(l.state);
      }),
    },
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("planning watchdog", () => {
  it("a planner call that never returns rejects with PlanningStalledError and aborts the call", async () => {
    vi.useFakeTimers();
    let seen: AbortSignal | undefined;
    const task = new AbortController();
    const pending = withPlanningWatchdog(task.signal, "replanning", 60_000, (signal) => {
      seen = signal;
      return new Promise<string>(() => {}); // hangs and ignores its signal
    });
    const outcome = pending.then(
      () => null,
      (error: unknown) => error
    );
    await vi.advanceTimersByTimeAsync(60_001);
    const error = await outcome;
    expect(isPlanningStalledError(error)).toBe(true);
    expect((error as PlanningStalledError).stage).toBe("replanning");
    expect((error as Error).message).toContain("Replanning stalled");
    expect(seen?.aborted).toBe(true);
    expect(task.signal.aborted).toBe(false);
  });

  it("a fast planner call passes through; 0 disables the watchdog; task abort still reaches the call", async () => {
    const task = new AbortController();
    await expect(withPlanningWatchdog(task.signal, "planning", 60_000, async () => "plan")).resolves.toBe("plan");
    await expect(withPlanningWatchdog(task.signal, "planning", 0, async (signal) => signal === task.signal)).resolves.toBe(true);
    let inner: AbortSignal | undefined;
    const running = withPlanningWatchdog(task.signal, "planning", 60_000, (signal) => {
      inner = signal;
      return new Promise((_, reject) => signal.addEventListener("abort", () => reject(new Error("aborted"))));
    });
    task.abort(new Error("Task cancelled"));
    await expect(running).rejects.toThrow("aborted");
    expect(inner?.aborted).toBe(true);
  });

  it("a stalled planner fails the task with a visible reason (never left in planning)", async () => {
    const fake = fakeApi();
    const pctx = {
      deps: { api: fake.api, policy: {} },
      task: { _id: "t1" },
      project: { _id: "p1" },
      signal: new AbortController().signal,
    } as never;
    await finishOnPlanningError(pctx, new PlanningStalledError("replanning", 12 * 60_000));
    expect(fake.events.map((e) => e.type)).toEqual(["task.planning_stalled", "task.error"]);
    expect(fake.completed).toHaveLength(1);
    expect(fake.completed[0].status).toBe("failed");
    expect(fake.completed[0].errorMessage).toContain("Replanning stalled: the planner made no progress for 12 min");
  });

  it("other planning errors fail the task visibly (task.error + failureKind); lease loss still propagates", async () => {
    const fake = fakeApi();
    const pctx = {
      deps: { api: fake.api, policy: {} },
      task: { _id: "t1" },
      project: { _id: "p1" },
      signal: new AbortController().signal,
    } as never;
    // regress-tests: was rethrown to the worker loop, which failed the task with no task.error / failureKind.
    await finishOnPlanningError(pctx, new Error("boom"));
    expect(fake.events.map((e) => e.type)).toEqual(["task.error"]);
    expect(fake.completed).toEqual([expect.objectContaining({ status: "failed", errorMessage: "boom" })]);
    await expect(finishOnPlanningError(pctx, new Error("Lease lost: another worker owns this task"))).rejects.toThrow("Lease lost");
  });
});

describe("cancel vs failure endings", () => {
  const run = async (reason: Error) => {
    const fake = fakeApi();
    const controller = new AbortController();
    controller.abort(reason);
    await finishCancelledTask({
      deps: { api: fake.api } as never,
      task: { _id: "t1" } as never,
      project: { _id: "p1" } as never,
      signal: controller.signal,
    });
    return fake;
  };

  it("a user stop settles as cancelled", async () => {
    const fake = await run(new Error("Task cancelled by user"));
    expect(fake.completed[0]).toEqual({ taskId: "t1", status: "cancelled", errorMessage: "Cancelled by user" });
    expect(fake.lifecycle).toEqual(["CANCELLED"]);
  });

  it("deadline and idle aborts are failures with their reason", async () => {
    const deadline = await run(new Error("Task deadline exceeded (1200000ms)"));
    expect(deadline.completed[0]).toMatchObject({ status: "failed", errorMessage: "Task deadline exceeded (1200000ms)" });
    const idle = await run(new Error("Task idle exceeded (600000ms)"));
    expect(idle.completed[0]).toMatchObject({ status: "failed", errorMessage: "Task idle exceeded (600000ms)" });
    expect(idle.lifecycle).toEqual(["FAILED"]);
  });
});

describe("decision advisor agent", () => {
  const cto: AgentDefinition = { _id: "cto", name: "CTO", role: "cto", capabilities: [CAPABILITY.ARCHITECTURE] };
  const dev: AgentDefinition = { _id: "fe", name: "Frontend", role: "frontend", capabilities: [CAPABILITY.FRONTEND] };

  it("uses the run's CTO, else the planner fallback CTO, else none", () => {
    expect(pickDecisionAdvisor([dev, cto], null)?._id).toBe("cto");
    expect(pickDecisionAdvisor([dev], cto)?._id).toBe("cto");
    expect(pickDecisionAdvisor([dev], null)).toBeNull();
  });

  it("no advisor agent at all: decide() falls back to the deterministic decision (no throw, no limbo)", async () => {
    const ctx = {
      taskId: "t1",
      objective: "o",
      classification: { kind: "code", strategy: "s", reasons: [] },
      planVersion: 1,
      plan: { goal: "g", strategy: "s", subtasks: [] },
      results: [],
      openIssues: [],
      budget: {},
      policy: { decisionLlmMode: "ambiguous", maxDecisionSteps: 20 },
      agents: [dev],
      completedKeys: new Set<string>(),
      step: 1,
    } as never;
    const result = await decide(
      ctx,
      { outcome: "failed", retryable: false, reason: "Agent stalled: no output or heartbeat progress for 360000ms" } as never,
      {
        llmMode: "always",
        advise: (c, o) => decideWithLlm({ ctx: c, observation: o, plannerAgent: null }),
      }
    );
    expect(result.decision.decidedBy).toBe("deterministic");
    expect(result.decision.action).toBe("replan");
    expect(result.fallback).toContain("no orchestrator-capable agent");
  });
});
