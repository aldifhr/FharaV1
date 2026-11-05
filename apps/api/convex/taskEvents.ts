import { query, mutation } from "./_generated/server";
import { v } from "convex/values";

export const listByTask = query({
  args: { taskId: v.id("tasks") },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("taskEvents")
      .filter((q) => q.eq(q.field("taskId"), args.taskId))
      .order("asc")
      .collect();
  },
});

export const log = mutation({
  args: {
    taskId: v.id("tasks"),
    projectId: v.id("projects"),
    type: v.string(),
    payload: v.optional(v.any()),
  },
  handler: async (ctx, args) => {
    return await ctx.db.insert("taskEvents", args);
  },
});
