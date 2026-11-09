import { query } from "./_generated/server";
import { v } from "convex/values";
import { assertProjectAccess } from "./lib/authz";

export const listSubtasksByProject = query({
  args: { projectId: v.id("projects") },
  handler: async (ctx, args) => {
    await assertProjectAccess(ctx, args.projectId);
    const tasks = await ctx.db
      .query("tasks")
      .withIndex("by_project", (q) => q.eq("projectId", args.projectId))
      .collect();
    const rows = await ctx.db
      .query("subtasks")
      .withIndex("by_project", (q) => q.eq("projectId", args.projectId))
      .collect();
    const byTask = new Map<string, typeof rows>();
    for (const row of rows) {
      const list = byTask.get(row.taskId as string) ?? [];
      list.push(row);
      byTask.set(row.taskId as string, list);
    }
    return tasks.map((task) => ({
      taskId: task._id as string,
      subtasks: (byTask.get(task._id as string) ?? []).map((s) => ({
        _id: s._id as string,
        key: s.key,
        title: s.title,
        kind: s.kind,
        capability: s.capability,
        status: s.status,
        assignedAgentId: s.assignedAgentId as string | undefined,
        assignedAgentName: s.assignedAgentName,
        output: s.output,
        error: s.error,
        attempts: s.attempts,
        reviewRound: (s as any).reviewRound,
        // Live "what the agent is doing" line (worker:setSubtaskActivity).
        activity: (s as any).activity as string | undefined,
        activityAt: (s as any).activityAt as number | undefined,
        completedAt: s.completedAt,
      })),
    }));
  },
});

export const listPlansByProject = query({
  args: { projectId: v.id("projects") },
  handler: async (ctx, args) => {
    await assertProjectAccess(ctx, args.projectId);
    const plans = await ctx.db
      .query("plans")
      .withIndex("by_project", (q) => q.eq("projectId", args.projectId))
      .order("desc")
      .collect();
    const latest = new Map<string, (typeof plans)[number]>();
    for (const plan of plans) {
      const id = plan.taskId as string;
      if (!latest.has(id)) latest.set(id, plan);
    }
    return [...latest.values()].map((plan) => ({
      taskId: plan.taskId as string,
      version: plan.version,
      strategy: plan.strategy,
      createdBy: plan.createdBy,
      goal: plan.goal,
      payload: plan.payload,
    }));
  },
});
