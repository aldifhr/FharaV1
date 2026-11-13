import { afterEach, describe, expect, it, vi } from "vitest";
import {
  USER_CANCEL_MESSAGE,
  armTaskAbort,
  isLeaseLostOrShutdown,
  isUserCancelStatus,
  taskStatusReader,
} from "@/services/runner/abort";
import { withPlanningWatchdog } from "@/services/runner/planning";
import { finishCancelledTask } from "@/services/runner/terminal";
import type { ExecutionPolicy } from "@/orchestrator/policy";

/**
 * Task Stop on the worker: tasks.cancel only writes the row, so each run
 * polls its own status (armTaskAbort readStatus) and aborts the shared task
 * signal, which planning, the DAG, executors and LLM calls all observe.
 */

const policy = { taskTimeoutMs: 60_000, idleTimeoutMs: 0 } as unknown as ExecutionPolicy;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
afterEach(() => vi.useRealTimers());

describe("armTaskAbort status poll", () => {
  it("aborts with the user-cancel reason once the row reads cancelled", async () => {
    let status: string | null = "running";
    const reads = vi.fn(async () => status);
    const run = armTaskAbort(policy, undefined, reads, 20);
    await wait(60);
    expect(run.controller.signal.aborted).toBe(false);
    status = "cancelled";
    await wait(60);
    expect(run.controller.signal.aborted).toBe(true);
    const reason = run.controller.signal.reason as Error;
    expect(reason.message).toBe(USER_CANCEL_MESSAGE);
    // A user stop is not "no longer owned".
    expect(isLeaseLostOrShutdown(reason)).toBe(false);
    run.dispose();
  });

  it("only cancelled is a stop; a failed read or other statuses never abort; dispose stops polling", async () => {
    for (const s of ["running", "paused", "done", "failed", null, undefined]) expect(isUserCancelStatus(s as any)).toBe(false);
    let calls = 0;
    const run = armTaskAbort(policy, undefined, async () => {
      calls += 1;
      throw new Error("offline");
    }, 10);
    await wait(50);
    expect(run.controller.signal.aborted).toBe(false);
    expect(calls).toBeGreaterThan(0);
    run.dispose();
    const after = calls;
    await wait(40);
    expect(calls).toBe(after);
  });

  it("a stop reaches a planner call in flight", async () => {
    let status = "running";
    const run = armTaskAbort(policy, undefined, async () => status, 10);
    const planning = withPlanningWatchdog(run.controller.signal, "planning", 60_000, (signal) =>
      new Promise<string>((_, reject) => signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true }))
    );
    status = "cancelled";
    await expect(planning).rejects.toThrow("aborted");
    run.dispose();
  });

  it("taskStatusReader uses the api's getTaskStatus, or nothing for a fake without it", async () => {
    expect(taskStatusReader({ api: {} }, "t1")).toBeUndefined();
    const getTaskStatus = vi.fn(async () => "running");
    const read = taskStatusReader({ api: { getTaskStatus } }, "t1");
    expect(await read?.()).toBe("running");
    expect(getTaskStatus).toHaveBeenCalledWith("t1");
  });
});

describe("finishCancelledTask after a user stop", () => {
  it("ends the run cancelled (not failed, not interrupted)", async () => {
    const completed: Array<{ status: string; errorMessage?: string }> = [];
    const events: string[] = [];
    const lifecycle: string[] = [];
    const controller = new AbortController();
    controller.abort(new Error(USER_CANCEL_MESSAGE));
    await finishCancelledTask({
      deps: {
        api: {
          logEvent: async (e: { type: string }) => void events.push(e.type),
          completeTask: async (c: { status: string; errorMessage?: string }) => void completed.push(c),
          recordLifecycle: async (l: { state: string }) => void lifecycle.push(l.state),
        },
      } as any,
      task: { _id: "t1" } as any,
      project: { _id: "p1" } as any,
      signal: controller.signal,
    });
    expect(completed).toEqual([{ taskId: "t1", status: "cancelled", errorMessage: "Cancelled by user" }]);
    expect(events).toContain("task.cancelled");
    expect(lifecycle).toContain("CANCELLED");
  });
});
