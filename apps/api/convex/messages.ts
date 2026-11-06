import { query, action } from "./_generated/server";
import { v } from "convex/values";
import { assertProjectAccess, getVisibleTask } from "./authz";
import { internal } from "./_generated/api";

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

export const send = action({
  args: {
    projectId: v.id("projects"),
    content: v.string(),
    preferredAgentId: v.optional(v.id("agents")),
  },
  handler: async (ctx, args): Promise<{ messageId: string }> => {
    const messageId = await ctx.runMutation(internal.chatContext.insertUserMessage, {
      projectId: args.projectId,
      content: args.content,
    });
    // Let the agent team answer the conversation asynchronously.
    ctx.scheduler.runAfter(0, internal.chat.replyToChat, {
      projectId: args.projectId,
      preferredAgentId: args.preferredAgentId,
      userMessageId: messageId,
    });
    return { messageId: messageId as string };
  },
});
