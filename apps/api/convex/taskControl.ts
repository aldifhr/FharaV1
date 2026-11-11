import { internalMutation, mutation, type MutationCtx } from "./_generated/server";
import type { Doc } from "./_generated/dataModel";
import { internal } from "./_generated/api";
import { v } from "convex/values";
import { assertTaskAccess } from "./lib/authz";
import { appendTaskEvent } from "./lib/taskEvents";
import { nextHoldState, type ProviderHold } from "./lib/providerHold";
import { patchTask } from "./lib/threadIndex";

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

/** Statuses a task can be paused from (status becomes `paused`). */
const PAUSABLE = new Set(["queued", "running"]);
/**
 * Parked on an approval: the pause is only RECORDED (`pausedBy`), the
 * status stays needs_approval and nothing that waits is touched. The
 * resume claim holds while it is set (orchestration.claimResumableTask),
 * and a resume already in flight drains as paused (setTaskStatus).
 */
const RECORD_ONLY_PAUSABLE = new Set(["needs_approval"]);

export const pause = mutation({
  args: { taskId: v.id("tasks") },
  handler: async (ctx, args) => {
    const task = await assertTaskAccess(ctx, args.taskId);
    if (task.status === "paused" && task.pausedBy === "held") {
      // O3: the user pauses a held task: it stops waiting for the
      // automatic resume and only the user's Resume continues it.
      const now = Date.now();
      await patchTask(ctx, task._id, { pausedBy: "user", pausedAt: now, hold: undefined, updatedAt: now });
      await appendTaskEvent(ctx, {
        taskId: task._id,
        projectId: task.projectId,
        type: "task.paused",
        payload: { pausedBy: "user", prevStatus: task.status, wasHeld: true },
        level: "info",
      });
      return { paused: true, changed: true };
    }
    if (task.status === "paused") return { paused: true, changed: false };
    if (RECORD_ONLY_PAUSABLE.has(task.status)) {
      if (task.pausedBy) return { paused: true, changed: false };
      const now = Date.now();
      await patchTask(ctx, task._id, { pausedBy: "user", pausedAt: now, updatedAt: now });
      await appendTaskEvent(ctx, {
        taskId: task._id,
        projectId: task.projectId,
        type: "task.paused",
        payload: { pausedBy: "user", prevStatus: task.status, recordedOnly: true },
        level: "info",
      });
      return { paused: true, changed: true };
    }
    if (!PAUSABLE.has(task.status)) {
      throw new Error(`A ${task.status.replace("_", " ")} task cannot be paused`);
    }
    const now = Date.now();
    await patchTask(ctx, task._id, {
      status: "paused",
      pausedBy: "user",
      pausedAt: now,
      updatedAt: now,
    });
    await appendTaskEvent(ctx, {
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
    if (task.status !== "paused" && task.pausedBy) {
      // A record-only pause (parked on an approval): clear it; a pending
      // approval signal makes the task resumable again by itself.
      const now = Date.now();
      await patchTask(ctx, task._id, { pausedBy: undefined, pausedAt: undefined, updatedAt: now });
      await appendTaskEvent(ctx, {
        taskId: task._id,
        projectId: task.projectId,
        type: "task.resumed",
        payload: { resumedBy: "user", pausedAt: task.pausedAt ?? null, recordedOnly: true },
        level: "info",
      });
      return { resumed: true, status: task.status };
    }
    if (task.status !== "paused") return { resumed: false, status: task.status };
    const now = Date.now();
    // Still draining on a live worker: hand the task back to it as
    // running; its run ends at the next boundary and releasePausedTask
    // re-queues it (its scheduler already stopped dispatching). Otherwise
    // re-queue directly: the next claim continues from the stored plan.
    const draining = Boolean(task.workerId) && (task.leaseExpiresAt ?? 0) > now;
    const wasHeld = task.pausedBy === "held";
    await patchTask(ctx, task._id, {
      status: draining ? "running" : "queued",
      pausedBy: undefined,
      pausedAt: undefined,
      // O3: the user's Resume starts the backoff over.
      ...(wasHeld ? { hold: undefined } : {}),
      updatedAt: now,
      ...(draining ? {} : { workerId: undefined, leaseExpiresAt: undefined }),
    });
    await appendTaskEvent(ctx, {
      taskId: task._id,
      projectId: task.projectId,
      type: "task.resumed",
      payload: { resumedBy: "user", pausedAt: task.pausedAt ?? null, draining, ...(wasHeld ? { wasHeld: true } : {}) },
      level: "info",
    });
    await ctx.db.insert("lifecycleHistory", {
      taskId: task._id,
      projectId: task.projectId,
      state: "RUNNING",
      prevState: wasHeld ? "PAUSED_HELD" : "PAUSED_USER",
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
      await patchTask(ctx, task._id, { workerId: undefined, leaseExpiresAt: undefined, updatedAt: now });
      return { result: "released" as const };
    }
    if (task.status === "running") {
      await patchTask(ctx, task._id, {
        status: "queued",
        workerId: undefined,
        leaseExpiresAt: undefined,
        updatedAt: now,
      });
      await appendTaskEvent(ctx, {
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

/**
 * O3 + L7: put a task on hold for a provider failure (offline, 429, quota,
 * auth) instead of failing it. Status becomes `paused` with pausedBy
 * "held" and the reason; the lease is cleared (the run that hit the
 * failure has ended) and an automatic resume is scheduled with
 * exponential backoff. `paused` is never claimed, recovered or failed by
 * the watchdog, so the task waits safely. Callers have already checked
 * the terminal guard and the lease.
 */
export async function holdTaskForProvider(
  ctx: MutationCtx,
  task: Doc<"tasks">,
  hold: ProviderHold,
  detail?: string
): Promise<{ resumeAt: number; attempts: number }> {
  const now = Date.now();
  const state = nextHoldState(task.hold, hold, now, detail);
  await patchTask(ctx, task._id, {
    status: "paused",
    pausedBy: "held",
    pausedAt: now,
    hold: state,
    workerId: undefined,
    leaseExpiresAt: undefined,
    updatedAt: now,
  });
  await appendTaskEvent(ctx, {
    taskId: task._id,
    projectId: task.projectId,
    type: "task.held",
    payload: { kind: state.kind, reason: state.reason, attempts: state.attempts, resumeAt: state.resumeAt, ...(state.detail ? { detail: state.detail } : {}) },
    level: "warn",
  });
  await ctx.db.insert("lifecycleHistory", {
    taskId: task._id,
    projectId: task.projectId,
    state: "PAUSED_HELD",
    prevState: task.status.toUpperCase(),
    createdAt: now,
  });
  await ctx.scheduler.runAt(state.resumeAt, internal.taskControl.autoResumeHeld, { taskId: task._id, attempt: state.attempts });
  return { resumeAt: state.resumeAt, attempts: state.attempts };
}

/**
 * O3: the scheduled resume of a held task. Re-queues it only when it is
 * still on THIS hold (same attempt): a user pause, a user Resume, a
 * cancel or a later hold all make an older schedule a no-op.
 */
export const autoResumeHeld = internalMutation({
  args: { taskId: v.id("tasks"), attempt: v.number() },
  handler: async (ctx, args): Promise<{ resumed: boolean; reason?: string }> => {
    const task = await ctx.db.get(args.taskId);
    if (!task) return { resumed: false, reason: "missing" };
    if (task.status !== "paused" || task.pausedBy !== "held" || task.hold?.attempts !== args.attempt) {
      return { resumed: false, reason: "not_held" };
    }
    const now = Date.now();
    await patchTask(ctx, task._id, {
      status: "queued",
      pausedBy: undefined,
      pausedAt: undefined,
      workerId: undefined,
      leaseExpiresAt: undefined,
      updatedAt: now,
      // `hold` stays (attempts carry over): a provider still failing holds
      // the task again with the next, longer delay.
    });
    await appendTaskEvent(ctx, {
      taskId: task._id,
      projectId: task.projectId,
      type: "task.resumed",
      payload: { resumedBy: "hold_backoff", attempt: args.attempt, reason: task.hold.reason },
      level: "info",
    });
    await ctx.db.insert("lifecycleHistory", {
      taskId: task._id,
      projectId: task.projectId,
      state: "QUEUED",
      prevState: "PAUSED_HELD",
      createdAt: now,
    });
    return { resumed: true };
  },
});
