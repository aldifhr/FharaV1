import { query, mutation } from "./_generated/server";
import { v } from "convex/values";

export const listByProject = query({
  args: { projectId: v.id("projects") },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("messages")
      .filter((q) => q.eq(q.field("projectId"), args.projectId))
      .order("asc")
      .collect();
  },
});

export const listByTask = query({
  args: { taskId: v.id("tasks") },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("messages")
      .filter((q) => q.eq(q.field("taskId"), args.taskId))
      .order("asc")
      .collect();
  },
});

export const send = mutation({
  args: { projectId: v.id("projects"), content: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db.insert("messages", {
      projectId: args.projectId,
      authorType: "user",
      content: args.content,
    });
  },
});

export const appendAgentChunk = mutation({
  args: {
    projectId: v.id("projects"),
    taskId: v.id("tasks"),
    agentId: v.id("agents"),
    delta: v.string(),
  },
  handler: async (ctx, args) => {
    return await ctx.db.insert("messages", {
      projectId: args.projectId,
      taskId: args.taskId,
      agentId: args.agentId,
      authorType: "agent",
      content: args.delta,
    });
  },
});
