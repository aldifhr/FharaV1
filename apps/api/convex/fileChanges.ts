import { query } from "./_generated/server";
import { v } from "convex/values";
import { getVisibleTask } from "./authz";

export const listByTask = query({
  args: { taskId: v.id("tasks") },
  handler: async (ctx, args) => {
    const task = await getVisibleTask(ctx, args.taskId);
    if (!task) return [];
    return await ctx.db
      .query("fileChanges")
      .withIndex("by_task", (q) => q.eq("taskId", args.taskId))
      .collect();
  },
});

export const listByProject = query({
  args: { projectId: v.id("projects") },
  handler: async (ctx, args) => {
    const project = await ctx.db.get(args.projectId);
    if (!project) return [];
    const rows = await ctx.db
      .query("fileChanges")
      .withIndex("by_project", (q) => q.eq("projectId", args.projectId))
      .collect();
    const byPath = new Map<string, { _id: string; filePath: string; changeType: string }>();
    for (const row of rows) {
      const existing = byPath.get(row.filePath);
      if (!existing || row.changeType === "new" || row.changeType === "modified") {
        byPath.set(row.filePath, { _id: row._id, filePath: row.filePath, changeType: row.changeType });
      }
    }
    return [...byPath.values()];
  },
});
