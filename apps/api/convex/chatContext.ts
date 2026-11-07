import { internalMutation, internalQuery } from "./_generated/server";
import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { loadProviderPool } from "./llmResolver";
import { activeParticipantRows, selectDefaultChatAgents } from "./conversations";

export const insertUserMessage = internalMutation({
  args: {
    projectId: v.id("projects"),
    content: v.string(),
    conversationId: v.optional(v.id("conversations")),
  },
  handler: async (ctx, args) => {
    const content = args.content.trim();
    if (!content) throw new Error("Message is required");
    if (content.length > 8000) throw new Error("Message is too long");
    return await ctx.db.insert("messages", {
      projectId: args.projectId,
      authorType: "user",
      content,
      conversationId: args.conversationId,
      queueStatus: "pending",
      attempts: 0,
    });
  },
});

export const insertAgentMessage = internalMutation({
  args: {
    projectId: v.id("projects"),
    agentId: v.optional(v.id("agents")),
    content: v.string(),
    replyToMessageId: v.optional(v.id("messages")),
    taskId: v.optional(v.id("tasks")),
    conversationId: v.optional(v.id("conversations")),
  },
  handler: async (ctx, args) => {
    const content = args.content.trim();
    if (!content) return null;
    return await ctx.db.insert("messages", {
      projectId: args.projectId,
      agentId: args.agentId,
      authorType: "agent",
      content,
      replyToMessageId: args.replyToMessageId,
      taskId: args.taskId,
      conversationId: args.conversationId,
    });
  },
});

export const checkAlreadyReplied = internalQuery({
  args: { userMessageId: v.id("messages") },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("messages")
      .withIndex("by_reply_to", (q) => q.eq("replyToMessageId", args.userMessageId))
      .first();
    return existing !== null;
  },
});

export const getContext = internalQuery({
  args: {
    projectId: v.id("projects"),
    conversationId: v.optional(v.id("conversations")),
    preferredAgentIds: v.optional(v.array(v.id("agents"))),
  },
  handler: async (ctx, args) => {
    const project = await ctx.db.get(args.projectId);
    if (!project) return { agents: [], projectName: "", history: [] };

    // Plan 007: when a conversation is given, participation is read from the
    // persisted participant rows (still gated on membership + enabled, since a
    // participant may have been disabled or removed from the team since it
    // joined). Without one, the historical selection runs as fallback.
    let selected: Doc<"agents">[];
    if (args.conversationId) {
      const rows = await activeParticipantRows(ctx, args.conversationId);
      const agents = await Promise.all(rows.map((row) => ctx.db.get(row.agentId)));
      const team = project.agentIds ?? [];
      selected = agents.filter((agent): agent is Doc<"agents"> => {
        if (!agent) return false;
        if (agent.isEnabled === false) return false;
        return team.includes(agent._id);
      });
    } else {
      const all = await ctx.db.query("agents").collect();
      selected = selectDefaultChatAgents(
        project.agentIds,
        all,
        args.preferredAgentIds
      );
    }

    const rows = await ctx.db
      .query("messages")
      .withIndex("by_project", (q) => q.eq("projectId", args.projectId))
      .order("desc")
      .collect();
    const history = rows
      .filter((m) => !m.taskId)
      .slice(0, 12)
      .reverse()
      .map((m) => ({ authorType: m.authorType, content: m.content }));

    // Plan 006 Phase 3: conversation summary + last 12 replaces raw history
    // for compaction. The latest summary for this conversation (if any)
    // is included so the router path can carry bounded context.
    let contextSummary: string | undefined;
    if (args.conversationId) {
      const summaries = await ctx.db
        .query("contextSummaries")
        .withIndex("by_conversation", (q) => q.eq("conversationId", args.conversationId!))
        .order("desc")
        .take(1);
      contextSummary = summaries[0]?.summary;
    }

    const agentShape = (a: Doc<"agents">) => ({
      _id: a._id,
      name: a.name,
      role: a.role,
      systemPrompt: a.systemPrompt,
    });

    // Shared pool assembly (connections + models, encrypted key only) —
    // see llmResolver.ts. chat.ts decrypts on the backend for its own call.
    const llmProviders = await loadProviderPool(ctx);

    return {
      agents: selected.map(agentShape),
      projectName: project.name,
      history,
      contextSummary,
      llmProviders,
    };
  },
});
