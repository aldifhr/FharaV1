import { mutation, query } from "./_generated/server";
import { v } from "convex/values";

export const create = mutation({
  args: {
    name: v.string(),
    workspacePath: v.string(),
    agentIds: v.optional(v.array(v.id("agents"))),
  },
  handler: async (ctx, args) => {
    const name = args.name.trim();
    const workspacePath = args.workspacePath.trim();
    if (!name) throw new Error("Project name is required");
    if (!workspacePath) throw new Error("Project path is required");

    return await ctx.db.insert("projects", {
      name,
      workspacePath,
      ...(args.agentIds ? { agentIds: args.agentIds } : {}),
    });
  },
});

export const updateTeam = mutation({
  args: {
    projectId: v.id("projects"),
    agentIds: v.array(v.id("agents")),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.projectId, { agentIds: args.agentIds });
  },
});

export const list = query({
  args: {},
  handler: async (ctx) => {
    return await ctx.db.query("projects").order("desc").collect();
  },
});

export const get = query({
  args: { projectId: v.id("projects") },
  handler: async (ctx, args) => {
    return await ctx.db.get(args.projectId);
  },
});
