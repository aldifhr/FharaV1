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
    preferredAgentIds: v.optional(v.array(v.id("agents"))),
    conversationId: v.optional(v.id("conversations")),
  },
  handler: async (ctx, args): Promise<{ messageId: string; conversationId: string }> => {
    // Plan 007: resolve (or create) the project's active conversation and sync
    // the caller's participant selection into it before the reply runs, so
    // participation is persisted rather than recomputed per message.
    const conversationId = await ctx.runMutation(internal.conversations.ensureForChat, {
      projectId: args.projectId,
      conversationId: args.conversationId,
      preferredAgentIds: args.preferredAgentIds,
    });
    const messageId = await ctx.runMutation(internal.chatContext.insertUserMessage, {
      projectId: args.projectId,
      content: args.content,
      conversationId,
    });
    ctx.scheduler.runAfter(0, internal.chat.replyToChat, {
      projectId: args.projectId,
      conversationId,
      userMessageId: messageId,
    });
    return { messageId: messageId as string, conversationId: conversationId as string };
  },
});
