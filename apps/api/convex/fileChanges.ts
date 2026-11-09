import { query } from "./_generated/server";
import { v } from "convex/values";
import { assertProjectAccess, getVisibleTask } from "./authz";

/** Newest file-change rows considered per project (bounded read). */
const PROJECT_FILE_CHANGE_LIMIT = 2000;

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
    // Authorization (core H5): file diffs belong to the project's owner.
    await assertProjectAccess(ctx, args.projectId);
    // Newest rows, then back to oldest-first so the per-path pick below
    // keeps its original semantics.
    const rows = (
      await ctx.db
        .query("fileChanges")
        .withIndex("by_project", (q) => q.eq("projectId", args.projectId))
        .order("desc")
        .take(PROJECT_FILE_CHANGE_LIMIT)
    ).reverse();
    const byPath = new Map<string, { _id: string; filePath: string; changeType: string; taskId: string }>();
    for (const row of rows) {
      const existing = byPath.get(row.filePath);
      if (!existing || row.changeType === "new" || row.changeType === "modified") {
        byPath.set(row.filePath, { _id: row._id, filePath: row.filePath, changeType: row.changeType, taskId: row.taskId });
      }
    }
    return [...byPath.values()];
  },
});
