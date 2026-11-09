import { internalMutation, query } from "./_generated/server";
import type { MutationCtx } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { v } from "convex/values";
import { holdsTaskLease } from "./orchestration";
import { getVisibleTask } from "./lib/authz";

/**
 * Live output tail of a running subtask. The worker coalesces streamed
 * model text and writes the last ~8KB here every ~400ms; the task panel,
 * the board and the runs page show its last lines under the running row.
 * One small row per running subtask, deleted when the subtask settles.
 */

export const LIVE_TEXT_MAX = 8192;

/** Remove the live tail of one subtask (or of every subtask of a task). */
export async function clearSubtaskLive(
  ctx: MutationCtx,
  taskId: Id<"tasks">,
  key?: string
): Promise<number> {
  const rows =
    key === undefined
      ? await ctx.db.query("subtaskLive").withIndex("by_task", (q) => q.eq("taskId", taskId)).collect()
      : await ctx.db
          .query("subtaskLive")
          .withIndex("by_task_and_key", (q) => q.eq("taskId", taskId).eq("key", key))
          .collect();
  for (const row of rows) await ctx.db.delete(row._id);
  return rows.length;
}

/**
 * Worker write (via worker:setSubtaskLiveOutput). An empty `text` clears.
 * Lease fenced like the activity line; a subtask that is no longer
 * running only gets its tail cleared, never rewritten.
 */
export const set = internalMutation({
  args: {
    taskId: v.id("tasks"),
    key: v.string(),
    text: v.string(),
    workerId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    if (!(await holdsTaskLease(ctx, args.taskId, args.workerId))) return false;
    const subtask = await ctx.db
      .query("subtasks")
      .withIndex("by_task_and_key", (q) => q.eq("taskId", args.taskId).eq("key", args.key))
      .unique();
    if (args.text === "" || !subtask || subtask.status !== "running") {
      await clearSubtaskLive(ctx, args.taskId, args.key);
      return false;
    }
    const text = args.text.length > LIVE_TEXT_MAX ? args.text.slice(args.text.length - LIVE_TEXT_MAX) : args.text;
    const existing = await ctx.db
      .query("subtaskLive")
      .withIndex("by_task_and_key", (q) => q.eq("taskId", args.taskId).eq("key", args.key))
      .first();
    const now = Date.now();
    if (existing) {
      if (existing.text !== text) await ctx.db.patch(existing._id, { text, updatedAt: now });
    } else {
      await ctx.db.insert("subtaskLive", {
        taskId: args.taskId,
        projectId: subtask.projectId,
        key: args.key,
        text,
        updatedAt: now,
      });
    }
    return true;
  },
});

/** Live tail for one subtask, or null when it has none. */
export const get = query({
  args: { taskId: v.id("tasks"), key: v.string() },
  handler: async (ctx, args) => {
    const task = await getVisibleTask(ctx, args.taskId);
    if (!task) return null;
    const row = await ctx.db
      .query("subtaskLive")
      .withIndex("by_task_and_key", (q) => q.eq("taskId", args.taskId).eq("key", args.key))
      .first();
    return row ? { text: row.text, updatedAt: row.updatedAt } : null;
  },
});
