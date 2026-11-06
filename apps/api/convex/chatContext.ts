import { internalMutation, internalQuery } from "./_generated/server";
import { v } from "convex/values";

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
  },
  handler: async (ctx, args) => {
    const content = args.content.trim();
    if (!content) return null;
    return await ctx.db.insert("messages", {
      projectId: args.projectId,
      agentId: args.agentId,
      authorType: "agent",
      content,
    });
  },
});

export const getContext = internalQuery({
  args: { projectId: v.id("projects"), preferredAgentId: v.optional(v.id("agents")) },
  handler: async (ctx, args) => {
    const project = await ctx.db.get(args.projectId);
    if (!project) return { agent: null, projectName: "", history: [] };

    const all = await ctx.db.query("agents").collect();
    const inProject = project.agentIds?.length
      ? all.filter((a) => project.agentIds?.includes(a._id))
      : all;
    const enabled = inProject.filter((a) => a.isEnabled !== false);
    const pool = enabled.length ? enabled : inProject;
    const preferred = pool.find((a) => a._id === args.preferredAgentId);
    const lead = pool.find((a) => /orchestrator|planner|manager|cto|lead|architect/i.test(a.role));
    const agent = preferred ?? lead ?? pool[0] ?? null;

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

    return {
      agent: agent
        ? {
            _id: agent._id,
            name: agent.name,
            role: agent.role,
            systemPrompt: agent.systemPrompt,
            llmProvider: agent.llmProvider,
            llmModel: agent.llmModel,
            llmBaseUrl: agent.llmBaseUrl,
            llmApiKey: agent.llmApiKey,
          }
        : null,
      projectName: project.name,
      history,
    };
  },
});
