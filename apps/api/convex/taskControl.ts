import { internalMutation, mutation } from "./_generated/server";
import { v } from "convex/values";
import { assertTaskAccess } from "./lib/authz";

/**
 * Plan 022: user Pause / Resume. `paused` is its own non-terminal task
 * status, distinct from cancelled (failed + "Cancelled by user") and from
 * blocked: no new subtask is dispatched while it holds, running subtasks
 * finish, and nothing resumes it except the user — `claimNextTask` only
 * claims `queued`, `recoverStale` only looks at `running`, and the
 * resumable scan only at `needs_approval`.
 *
 * Draining: a worker that was running the task keeps its lease (the
 * heartbeat renews `paused` tasks it owns) until its run reaches a stage
 * boundary and calls `releasePausedTask`.
 */

/** Statuses a task can be paused from. Waiting states already wait on the user. */
const PAUSABLE = new Set(["queued", "running"]);

export const pause = mutation({
  args: { taskId: v.id("tasks") },
  handler: async (ctx, args) => {
    const task = await assertTaskAccess(ctx, args.taskId);
    if (task.status === "paused") return { paused: true, changed: false };
    if (!PAUSABLE.has(task.status)) {
      throw new Error(`A ${task.status.replace("_", " ")} task cannot be paused`);
    }
    const now = Date.now();
    await ctx.db.patch(task._id, {
      status: "paused",
      pausedBy: "user",
      pausedAt: now,
      updatedAt: now,
    });
    await ctx.db.insert("taskEvents", {
      taskId: task._id,
      projectId: task.projectId,
      type: "task.paused",
      payload: { pausedBy: "user", prevStatus: task.status, draining: Boolean(task.workerId) },
      level: "info",
    });
    await ctx.db.insert("lifecycleHistory", {
      taskId: task._id,
      projectId: task.projectId,
      state: "PAUSED_USER",
      prevState: task.status.toUpperCase(),
      createdAt: now,
    });
    return { paused: true, changed: true };
  },
});

export const resume = mutation({
  args: { taskId: v.id("tasks") },
  handler: async (ctx, args) => {
    const task = await assertTaskAccess(ctx, args.taskId);
    if (task.status !== "paused") return { resumed: false, status: task.status };
    const now = Date.now();
    // Still draining on a live worker: hand the task back to it as
    // running; its run ends at the next boundary and releasePausedTask
    // re-queues it (its scheduler already stopped dispatching). Otherwise
    // re-queue directly: the next claim continues from the stored plan.
    const draining = Boolean(task.workerId) && (task.leaseExpiresAt ?? 0) > now;
    await ctx.db.patch(task._id, {
      status: draining ? "running" : "queued",
      pausedBy: undefined,
      pausedAt: undefined,
      updatedAt: now,
      ...(draining ? {} : { workerId: undefined, leaseExpiresAt: undefined }),
    });
    await ctx.db.insert("taskEvents", {
      taskId: task._id,
      projectId: task.projectId,
      type: "task.resumed",
      payload: { resumedBy: "user", pausedAt: task.pausedAt ?? null, draining },
      level: "info",
    });
    await ctx.db.insert("lifecycleHistory", {
      taskId: task._id,
      projectId: task.projectId,
      state: "RUNNING",
      prevState: "PAUSED_USER",
      createdAt: now,
    });
    return { resumed: true, status: draining ? "running" : "queued" };
  },
});

/**
 * The worker's run stopped because of a pause. Paused → clear this
 * worker's lease and stay paused. Resumed while draining (running again,
 * still owned by this worker) → re-queue so a fresh claim continues.
 * Anything else (cancelled, another owner) is left alone.
 */
export const releasePausedTask = internalMutation({
  args: { taskId: v.id("tasks"), workerId: v.string() },
  handler: async (ctx, args) => {
    const task = await ctx.db.get(args.taskId);
    if (!task) return { result: "missing" as const };
    if (task.workerId && task.workerId !== args.workerId) return { result: "not_owner" as const };
    const now = Date.now();
    if (task.status === "paused") {
      await ctx.db.patch(task._id, { workerId: undefined, leaseExpiresAt: undefined, updatedAt: now });
      return { result: "released" as const };
    }
    if (task.status === "running") {
      await ctx.db.patch(task._id, {
        status: "queued",
        workerId: undefined,
        leaseExpiresAt: undefined,
        updatedAt: now,
      });
      await ctx.db.insert("taskEvents", {
        taskId: task._id,
        projectId: task.projectId,
        type: "task.requeued",
        payload: { reason: "resumed_while_draining" },
        level: "info",
      });
      return { result: "requeued" as const };
    }
    return { result: "unchanged" as const };
  },
});
