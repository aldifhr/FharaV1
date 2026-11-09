/**
 * Backend task watchdog (cron, every 5 minutes; see crons.ts and
 * lib/taskWatchdog.ts for the rules). e2e 2026-11-09 (task B2): after a
 * stall-triggered replan the task sat at status=running, planning, with no
 * further events — nothing outside the worker would ever end it.
 *
 * One pass:
 *  1. recovers lapsed leases (orchestration.recoverStale) without needing a
 *     worker to be alive,
 *  2. fails `running` tasks with no progress for the stuck window, with a
 *     visible reason, a `task.watchdog` event and an incident. The worker's
 *     cancel polling sees the terminal status and stops its run.
 */
import { internalMutation } from "./_generated/server";
import type { MutationCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import { closeOpenSubtasks, refreshAgentStatus } from "./orchestration";
import { openIncident } from "./lib/incidents";
import { scheduleDecisionEvaluation } from "./lib/calibration/store";
import { WATCHDOG_BATCH, isStuck, lastProgressAt, stuckReason, taskStuckMs } from "./lib/taskWatchdog";

async function progressOf(ctx: MutationCtx, task: Doc<"tasks">) {
  const [lastEvent] = await ctx.db
    .query("taskEvents")
    .withIndex("by_task", (q) => q.eq("taskId", task._id))
    .order("desc")
    .take(1);
  const live = await ctx.db
    .query("subtaskLive")
    .withIndex("by_task", (q) => q.eq("taskId", task._id))
    .take(50);
  const executions = await ctx.db
    .query("executions")
    .withIndex("by_task", (q) => q.eq("taskId", task._id))
    .order("desc")
    .take(20);
  return {
    at: lastProgressAt([
      // Not task.updatedAt: the worker heartbeat bumps it on every lease
      // renewal, so a hung run would look alive forever.
      task._creationTime,
      task.startedAt,
      lastEvent?._creationTime,
      ...live.map((row) => row.updatedAt),
      ...executions.map((row) => Math.max(row.createdAt, row.startedAt ?? 0, row.completedAt ?? 0)),
    ]),
    lastEventType: lastEvent?.type,
  };
}

async function failStuckTask(ctx: MutationCtx, task: Doc<"tasks">, reason: string, now: number) {
  await ctx.db.patch(task._id, {
    status: "failed",
    errorMessage: reason,
    completedAt: now,
    updatedAt: now,
    workerId: undefined,
    leaseExpiresAt: undefined,
  });
  await closeOpenSubtasks(ctx, task._id, "failed");
  const agents = new Set<Id<"agents">>();
  const executions = await ctx.db
    .query("executions")
    .withIndex("by_task", (q) => q.eq("taskId", task._id))
    .collect();
  for (const execution of executions) {
    if (execution.status !== "running" && execution.status !== "queued") continue;
    await ctx.db.patch(execution._id, { status: "failed", error: reason, leaseExpiresAt: undefined, completedAt: now });
    if (execution.agentId) agents.add(execution.agentId);
  }
  for (const agentId of agents) await refreshAgentStatus(ctx, agentId);
  await ctx.db.insert("taskEvents", {
    taskId: task._id,
    projectId: task.projectId,
    type: "task.watchdog",
    payload: { action: "failed", reason, workerId: task.workerId ?? null },
    level: "error",
  });
  await ctx.db.insert("taskEvents", {
    taskId: task._id,
    projectId: task.projectId,
    type: "task.failed",
    payload: { error: reason.slice(0, 500) },
    level: "error",
  });
  await openIncident(ctx, { taskId: task._id, trigger: "task_failed", error: reason, stage: "watchdog" });
  await scheduleDecisionEvaluation(ctx, task._id);
}

export const run = internalMutation({
  args: {
    now: v.optional(v.number()),
    /** Override for tests; default TASK_WATCHDOG_STUCK_MS (30 min, 0 = off). */
    stuckMs: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const now = args.now ?? Date.now();
    const stuckMs = args.stuckMs ?? taskStuckMs();
    // 1) Lapsed leases: same recovery the worker runs, but worker-independent.
    await ctx.scheduler.runAfter(0, internal.orchestration.recoverStale, { now });
    // 2) Live lease, no progress.
    const failed: string[] = [];
    if (stuckMs > 0) {
      const candidates = await ctx.db
        .query("tasks")
        .withIndex("by_status", (q) => q.eq("status", "running"))
        .take(WATCHDOG_BATCH);
      for (const task of candidates) {
        const progress = await progressOf(ctx, task);
        if (!isStuck(progress.at, now, stuckMs)) continue;
        await failStuckTask(ctx, task, stuckReason(progress.at, now, progress.lastEventType), now);
        failed.push(task._id);
      }
    }
    return { failed };
  },
});
