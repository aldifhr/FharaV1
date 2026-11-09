import { query } from "./_generated/server";
import { v } from "convex/values";
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

export const listByTask = query({
  args: { taskId: v.id("tasks") },
  handler: async (ctx, args) => {
    const task = await getVisibleTask(ctx, args.taskId);
    if (!task) return [];
    return await ctx.db
      .query("taskEvents")
      .withIndex("by_task", (q) => q.eq("taskId", args.taskId))
      .order("asc")
      .take(500);
  },
});
