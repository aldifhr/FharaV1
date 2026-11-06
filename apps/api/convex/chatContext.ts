import { internalMutation, internalQuery } from "./_generated/server";
import { v } from "convex/values";
import { loadProviderPool } from "./llmResolver";

export const insertUserMessage = internalMutation({
  args: { projectId: v.id("projects"), content: v.string() },
  handler: async (ctx, args) => {
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

export const insertAgentMessage = internalMutation({
  args: {
    projectId: v.id("projects"),
    agentId: v.optional(v.id("agents")),
    content: v.string(),
    replyToMessageId: v.optional(v.id("messages")),
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
    preferredAgentIds: v.optional(v.array(v.id("agents"))),
  },
  handler: async (ctx, args) => {
    const project = await ctx.db.get(args.projectId);
    if (!project) return { agents: [], projectName: "", history: [] };

    const all = await ctx.db.query("agents").collect();
    const hasTeam = project.agentIds && project.agentIds.length > 0;
    const inProject = hasTeam
      ? all.filter((a) => project.agentIds!.includes(a._id))
      : [];
    const enabled = inProject.filter((a) => a.isEnabled !== false);

    const preferred = args.preferredAgentIds?.length
      ? enabled.filter((a) => args.preferredAgentIds!.includes(a._id))
      : [];

    let selected: typeof enabled;
    if (preferred.length > 0) {
      selected = preferred;
    } else if (enabled.length > 0) {
      const lead = enabled.find((a) =>
        /orchestrator|planner|manager|cto|lead|architect/i.test(a.role),
      );
      selected = [lead ?? enabled[0]];
    } else {
      selected = [];
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

    const agentShape = (a: typeof all[number]) => ({
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
      llmProviders,
    };
  },
});
