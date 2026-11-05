import { query, mutation } from "./_generated/server";
import { v } from "convex/values";
import { assertProjectAccess, getVisibleTask } from "./authz";

export const listByProject = query({
  args: { projectId: v.id("projects"), limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    await assertProjectAccess(ctx, args.projectId);
    return await ctx.db
      .query("messages")
      .withIndex("by_project", (q) => q.eq("projectId", args.projectId))
      .order("asc")
      .take(Math.min(Math.max(args.limit ?? 500, 1), 1000));
  },
});

export const listByTask = query({
  args: { taskId: v.id("tasks") },
  handler: async (ctx, args) => {
    const task = await getVisibleTask(ctx, args.taskId);
    if (!task) return [];
    return await ctx.db
      .query("messages")
      .withIndex("by_task", (q) => q.eq("taskId", args.taskId))
      .order("asc")
      .take(500);
  },
});

export const send = mutation({
  args: { projectId: v.id("projects"), content: v.string() },
  handler: async (ctx, args) => {
    await assertProjectAccess(ctx, args.projectId);
    const content = args.content.trim();
    if (!content) throw new Error("Message is required");
    if (content.length > 8000) throw new Error("Message is too long");
    return await ctx.db.insert("messages", {
      projectId: args.projectId,
      authorType: "user",
      content,
    });
  },
});
