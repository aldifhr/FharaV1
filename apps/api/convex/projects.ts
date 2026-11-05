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

export const remove = mutation({
  args: { projectId: v.id("projects") },
  handler: async (ctx, args) => {
    const tasks = await ctx.db
      .query("tasks")
      .filter((q) => q.eq(q.field("projectId"), args.projectId))
      .collect();
    const taskIds = new Set(tasks.map((task) => task._id));

    for (const task of tasks) {
      const approvals = await ctx.db
        .query("approvals")
        .filter((q) => q.eq(q.field("taskId"), task._id))
        .collect();
      for (const approval of approvals) await ctx.db.delete(approval._id);

      const events = await ctx.db
        .query("taskEvents")
        .filter((q) => q.eq(q.field("taskId"), task._id))
        .collect();
      for (const event of events) await ctx.db.delete(event._id);

      const fileChanges = await ctx.db
        .query("fileChanges")
        .filter((q) => q.eq(q.field("taskId"), task._id))
        .collect();
      for (const fileChange of fileChanges) await ctx.db.delete(fileChange._id);
      await ctx.db.delete(task._id);
    }

    const messages = await ctx.db
      .query("messages")
      .filter((q) => q.eq(q.field("projectId"), args.projectId))
      .collect();
    for (const message of messages) await ctx.db.delete(message._id);

    const projectApprovals = await ctx.db
      .query("approvals")
      .filter((q) => q.eq(q.field("projectId"), args.projectId))
      .collect();
    for (const approval of projectApprovals) await ctx.db.delete(approval._id);

    const projectEvents = await ctx.db
      .query("taskEvents")
      .filter((q) => q.eq(q.field("projectId"), args.projectId))
      .collect();
    for (const event of projectEvents) await ctx.db.delete(event._id);

    await ctx.db.delete(args.projectId);
    return { deletedTasks: taskIds.size };
  },
});
