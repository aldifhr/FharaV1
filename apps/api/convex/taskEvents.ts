import { query } from "./_generated/server";
import { v } from "convex/values";
import { paginationOptsValidator } from "convex/server";
import { decideResume, replayEncodedBytes, RESUME_MAX_REPLAY_EVENTS } from "./lib/eventResume";
import { assertProjectAccess, getVisibleTask, visibleProjectIds } from "./lib/authz";

export const listAll = query({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    // Only events of projects the caller may see (core H5).
    const visible = await visibleProjectIds(ctx);
    const rows = await ctx.db
      .query("taskEvents")
      .order("desc")
      .take(Math.min(Math.max(args.limit ?? 200, 1), 500));
    return rows.filter((row) => visible.has(row.projectId as string));
  },
});

export const listByProject = query({
  args: { projectId: v.id("projects"), limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    await assertProjectAccess(ctx, args.projectId);
    return await ctx.db
      .query("taskEvents")
      .withIndex("by_project", (q) => q.eq("projectId", args.projectId))
      .order("desc")
      .take(Math.min(Math.max(args.limit ?? 200, 1), 500));
  },
});

/** Newest-window size bounds for per-task event reads. */
export const TASK_EVENT_WINDOW_DEFAULT = 500;
export const TASK_EVENT_WINDOW_MAX = 1000;

function windowSize(limit: number | undefined): number {
  return Math.min(Math.max(Math.floor(limit ?? TASK_EVENT_WINDOW_DEFAULT), 1), TASK_EVENT_WINDOW_MAX);
}

/**
 * Snapshot: the newest `limit` events of a task, returned oldest-first, plus
 * the sequence it was taken at (t3code idea #3, snapshot + cursor). It used
 * to return the *oldest* 500, so long tasks stopped showing new events.
 * Order follows `by_task_and_sequence`: legacy rows without a sequence come
 * first by creation time, then numbered rows by sequence.
 */
export const listByTask = query({
  args: { taskId: v.id("tasks"), limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const task = await getVisibleTask(ctx, args.taskId);
    if (!task) return [];
    const rows = await ctx.db
      .query("taskEvents")
      .withIndex("by_task_and_sequence", (q) => q.eq("taskId", args.taskId))
      .order("desc")
      .take(windowSize(args.limit));
    return rows.reverse();
  },
});

/**
 * Older history, newest page first (cursor paging over the same index), for
 * "load earlier" on long tasks. Each page is returned newest-first as Convex
 * paginates; callers reverse after merging.
 */
export const pageByTask = query({
  args: { taskId: v.id("tasks"), paginationOpts: paginationOptsValidator },
  handler: async (ctx, args) => {
    const task = await getVisibleTask(ctx, args.taskId);
    if (!task) return { page: [], isDone: true, continueCursor: "" };
    return await ctx.db
      .query("taskEvents")
      .withIndex("by_task_and_sequence", (q) => q.eq("taskId", args.taskId))
      .order("desc")
      .paginate(args.paginationOpts);
  },
});

/**
 * Reconnect: events after `afterSequence`, or a fresh snapshot when the gap
 * is too large to replay (decideResume, adapted from t3code's
 * decideThreadResume; see lib/eventResume.ts).
 */
export const sinceByTask = query({
  args: { taskId: v.id("tasks"), afterSequence: v.number(), limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const task = await getVisibleTask(ctx, args.taskId);
    if (!task) return { mode: "snapshot" as const, events: [], highWater: 0 };
    const newest = await ctx.db
      .query("taskEvents")
      .withIndex("by_task_and_sequence", (q) => q.eq("taskId", args.taskId))
      .order("desc")
      .first();
    const high = typeof newest?.sequence === "number" ? newest.sequence : 0;
    const replay = await ctx.db
      .query("taskEvents")
      .withIndex("by_task_and_sequence", (q) => q.eq("taskId", args.taskId).gt("sequence", args.afterSequence))
      .order("asc")
      .take(RESUME_MAX_REPLAY_EVENTS + 1);
    const plan = decideResume({
      afterSequence: args.afterSequence,
      highWater: high,
      replayEventCount: replay.length,
      replayEncodedBytes: replayEncodedBytes(replay),
    });
    if (plan.mode === "replay") return { mode: "replay" as const, events: replay, highWater: high };
    const rows = await ctx.db
      .query("taskEvents")
      .withIndex("by_task_and_sequence", (q) => q.eq("taskId", args.taskId))
      .order("desc")
      .take(windowSize(args.limit));
    return { mode: "snapshot" as const, events: rows.reverse(), highWater: high };
  },
});
