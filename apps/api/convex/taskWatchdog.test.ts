/// <reference types="vite/client" />
/**
 * e2e 2026-11-09 night: Stop must end a task as `cancelled` (not failed),
 * and a task left running with no progress (B2: running/planning after a
 * stall-triggered replan) must be ended by the backend watchdog.
 */
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";
import { DEFAULT_TASK_STUCK_MS, MIN_TASK_STUCK_MS, isStuck, lastProgressAt, stuckReason, taskStuckMs } from "./lib/taskWatchdog";

const modules = import.meta.glob("./**/*.ts");
const MIN = 60_000;

async function seedRunning(t: ReturnType<typeof convexTest>) {
  return await t.run(async (ctx) => {
    const projectId = await ctx.db.insert("projects", { name: "P", workspacePath: "/tmp/p" });
    const taskId = await ctx.db.insert("tasks", {
      projectId,
      title: "buat halaman login",
      command: "c",
      status: "running",
      workerId: "w1",
      // The heartbeat keeps the lease (and updatedAt) fresh on a hung run.
      leaseExpiresAt: Date.now() + 60 * MIN,
      updatedAt: Date.now(),
    });
    return { projectId, taskId };
  });
}

describe("Stop → cancelled", () => {
  test("tasks.cancel stores status cancelled; late worker writes are refused; Retry requeues", async () => {
    const t = convexTest(schema, modules);
    const { taskId } = await seedRunning(t);
    expect(await t.mutation(api.tasks.cancel, { taskId })).toBe(true);
    const task = await t.run((ctx) => ctx.db.get(taskId));
    expect(task).toMatchObject({ status: "cancelled", errorMessage: "Cancelled by user" });
    // A second Stop is a no-op.
    expect(await t.mutation(api.tasks.cancel, { taskId })).toBe(false);
    // Absorbing: a late worker completion keeps the cancellation.
    const late = await t.mutation(internal.orchestration.completeTask, { taskId, status: "failed", errorMessage: "late", workerId: "w1" });
    expect(late).toMatchObject({ applied: false, reason: "task_already_terminal", status: "cancelled" });
    // A user stop is not a failure: no incident opens.
    expect(await t.run((ctx) => ctx.db.query("incidents").collect())).toHaveLength(0);
    // Retry works from cancelled.
    await t.mutation(api.tasks.retry, { taskId });
    expect((await t.run((ctx) => ctx.db.get(taskId)))?.status).toBe("queued");
  });

  test("the worker may settle a run as cancelled", async () => {
    const t = convexTest(schema, modules);
    const { taskId } = await seedRunning(t);
    const result = await t.mutation(internal.orchestration.completeTask, {
      taskId,
      status: "cancelled",
      errorMessage: "Cancelled by user",
      workerId: "w1",
    });
    expect(result).toMatchObject({ applied: true, status: "cancelled" });
  });
});

describe("task watchdog", () => {
  test("pure rules", () => {
    expect(taskStuckMs(undefined)).toBe(DEFAULT_TASK_STUCK_MS);
    expect(taskStuckMs("0")).toBe(0);
    expect(taskStuckMs("1000")).toBe(MIN_TASK_STUCK_MS);
    expect(taskStuckMs("nope")).toBe(DEFAULT_TASK_STUCK_MS);
    expect(lastProgressAt([undefined, 5, null, 9, 3])).toBe(9);
    expect(isStuck(0, 31 * MIN, 30 * MIN)).toBe(true);
    expect(isStuck(2 * MIN, 31 * MIN, 30 * MIN)).toBe(false);
    expect(isStuck(0, 99 * MIN, 0)).toBe(false);
    expect(stuckReason(0, 45 * MIN, "orchestrator.decision")).toContain("no progress for 45 min (last event: orchestrator.decision)");
  });

  test("a running task with a live lease but no progress is failed with a visible reason", async () => {
    const t = convexTest(schema, modules);
    const { taskId, projectId } = await seedRunning(t);
    await t.mutation(internal.orchestration.logEvent, {
      taskId,
      projectId,
      type: "orchestrator.decision",
      payload: { action: "replan" },
    });
    const now = Date.now() + 40 * MIN;
    const result = await t.mutation(internal.taskWatchdog.run, { now, stuckMs: 30 * MIN });
    expect(result.failed).toEqual([taskId]);
    const task = await t.run((ctx) => ctx.db.get(taskId));
    expect(task?.status).toBe("failed");
    expect(task?.errorMessage).toMatch(/^Watchdog: no progress for 40 min \(last event: orchestrator.decision\)/);
    expect(task?.workerId).toBeUndefined();
    const events = await t.run((ctx) => ctx.db.query("taskEvents").withIndex("by_task", (q) => q.eq("taskId", taskId)).collect());
    expect(events.map((e) => e.type)).toEqual(expect.arrayContaining(["task.watchdog", "task.failed"]));
    expect(await t.run((ctx) => ctx.db.query("incidents").collect())).toHaveLength(1);
    // Terminal now: a late worker write is refused.
    const late = await t.mutation(internal.orchestration.completeTask, { taskId, status: "done", workerId: "w1" });
    expect(late).toMatchObject({ applied: false, reason: "task_already_terminal" });
  });

  test("recent progress (events or live output) keeps the task running; paused/waiting tasks are ignored", async () => {
    const t = convexTest(schema, modules);
    const { taskId, projectId } = await seedRunning(t);
    const paused = await t.run((ctx) =>
      ctx.db.insert("tasks", { projectId, title: "p", command: "c", status: "waiting_input", updatedAt: 1 })
    );
    const now = Date.now() + 40 * MIN;
    await t.run((ctx) =>
      ctx.db.insert("subtaskLive", { taskId, projectId, key: "fe", text: "streaming…", updatedAt: now - 2 * MIN })
    );
    const result = await t.mutation(internal.taskWatchdog.run, { now, stuckMs: 30 * MIN });
    expect(result.failed).toEqual([]);
    expect((await t.run((ctx) => ctx.db.get(taskId)))?.status).toBe("running");
    expect((await t.run((ctx) => ctx.db.get(paused)))?.status).toBe("waiting_input");
  });

  test("lapsed leases are recovered without a worker (recoverStale with no `now`)", async () => {
    const t = convexTest(schema, modules);
    const taskId = await t.run(async (ctx) => {
      const projectId = await ctx.db.insert("projects", { name: "P", workspacePath: "/tmp/p" });
      return ctx.db.insert("tasks", { projectId, title: "t", command: "c", status: "running", workerId: "dead", leaseExpiresAt: 1 });
    });
    await t.mutation(internal.orchestration.recoverStale, {});
    // Planning interrupted (no plan, no execution): requeued, never limbo.
    expect((await t.run((ctx) => ctx.db.get(taskId)))?.status).toBe("queued");
  });
});
