import { query, mutation } from "./_generated/server";
import { v } from "convex/values";

export const listByTask = query({
  args: { taskId: v.id("tasks") },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("fileChanges")
      .filter((q) => q.eq(q.field("taskId"), args.taskId))
      .collect();
  },
});

export const create = mutation({
  args: {
    taskId: v.id("tasks"),
    projectId: v.id("projects"),
    filePath: v.string(),
    changeType: v.union(
      v.literal("new"),
      v.literal("modified"),
      v.literal("deleted")
    ),
    oldContent: v.optional(v.string()),
    newContent: v.optional(v.string()),
    diff: v.string(),
  },
  handler: async (ctx, args) => {
    return await ctx.db.insert("fileChanges", args);
  },
});
