import { query } from "./_generated/server";
import { v } from "convex/values";
import { getVisibleTask } from "./authz";

export const getForTask = query({
  args: { taskId: v.id("tasks") },
  handler: async (ctx, args) => {
    const task = await getVisibleTask(ctx, args.taskId);
    if (!task) return null;

    const plans = await ctx.db
      .query("plans")
      .withIndex("by_task", (q) => q.eq("taskId", args.taskId))
      .order("desc")
      .take(1);

    const subtasks = await ctx.db
      .query("subtasks")
      .withIndex("by_task", (q) => q.eq("taskId", args.taskId))
      .order("asc")
      .collect();

    const executions = await ctx.db
      .query("executions")
      .withIndex("by_task", (q) => q.eq("taskId", args.taskId))
      .collect();
    executions.sort((a, b) => a.createdAt - b.createdAt);

    const approvals = await ctx.db
      .query("approvals")
      .withIndex("by_task", (q) => q.eq("taskId", args.taskId))
      .collect();

    const fileChanges = await ctx.db
      .query("fileChanges")
      .withIndex("by_task", (q) => q.eq("taskId", args.taskId))
      .collect();

    const evaluations = await ctx.db
      .query("evaluations")
      .withIndex("by_task", (q) => q.eq("taskId", args.taskId))
      .order("desc")
      .take(1);

    return {
      task,
      plan: plans[0] ?? null,
      subtasks,
      executions,
      approvals,
      fileChanges,
      evaluation: evaluations[0] ?? null,
    };
  },
});

export const activeByAgent = query({
  args: {},
  handler: async (ctx) => {
    const active = await ctx.db
      .query("executions")
      .withIndex("by_status", (q) => q.eq("status", "running"))
      .collect();
    const waiting = await ctx.db
      .query("executions")
      .withIndex("by_status", (q) => q.eq("status", "waiting_approval"))
      .collect();
    const queued = await ctx.db
      .query("executions")
      .withIndex("by_status", (q) => q.eq("status", "queued"))
      .collect();
    const map = new Map<string, { taskId: string; projectId: string; taskTitle: string; subtaskKey?: string; status: string }>();
    for (const exec of [...active, ...waiting, ...queued]) {
      if (!exec.agentId) continue;
      const task = await ctx.db.get(exec.taskId);
      if (!task) continue;
      // Only executions whose task is still live count as active — a
      // cancelled/terminal task leaves orphaned queued/running executions
      // that must not surface as "X is thinking" in an unrelated project.
      if (task.status === "failed" || task.status === "done" || task.status === "rejected") continue;
      map.set(exec.agentId as string, {
        taskId: exec.taskId as string,
        projectId: task.projectId as string,
        taskTitle: task.title,
        subtaskKey: exec.subtaskKey,
        status: exec.status,
      });
    }
    return Object.fromEntries(map);
  },
});
