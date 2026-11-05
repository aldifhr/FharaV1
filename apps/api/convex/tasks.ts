import { query, mutation, internalMutation, internalQuery } from "./_generated/server";
import { v } from "convex/values";

export const listByProject = query({
  args: { projectId: v.id("projects") },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("tasks")
      .filter((q) => q.eq(q.field("projectId"), args.projectId))
      .order("desc")
      .collect();
  },
});

export const get = query({
  args: { taskId: v.id("tasks") },
  handler: async (ctx, args) => {
    return await ctx.db.get(args.taskId);
  },
});

export const createFromCommand = mutation({
  args: { projectId: v.id("projects"), command: v.string() },
  handler: async (ctx, args) => {
    const title =
      args.command.length > 80
        ? args.command.slice(0, 80) + "..."
        : args.command;
    const taskId = await ctx.db.insert("tasks", {
      projectId: args.projectId,
      title,
      command: args.command,
      status: "queued",
    });
    await ctx.db.insert("messages", {
      projectId: args.projectId,
      taskId,
      authorType: "user",
      content: args.command,
    });
    return taskId;
  },
});

export const updateStatus = mutation({
  args: {
    taskId: v.id("tasks"),
    status: v.union(
      v.literal("queued"),
      v.literal("running"),
      v.literal("needs_approval"),
      v.literal("done"),
      v.literal("rejected"),
      v.literal("failed")
    ),
  },
  handler: async (ctx, args) => {
    const { taskId, status } = args;
    return await ctx.db.patch(taskId, { status });
  },
});

export const failRunning = mutation({
  args: { taskId: v.id("tasks") },
  handler: async (ctx, args) => {
    const task = await ctx.db.get(args.taskId);
    if (!task || task.status !== "running") return false;
    await ctx.db.patch(args.taskId, { status: "failed" });
    return true;
  },
});

export const recoverRunning = mutation({
  args: {},
  handler: async (ctx) => {
    const running = await ctx.db
      .query("tasks")
      .filter((q) => q.eq(q.field("status"), "running"))
      .collect();
    for (const task of running) {
      await ctx.db.patch(task._id, { status: "failed" });
    }
    return running.length;
  },
});

export const claimNextQueued = mutation({
  args: {},
  handler: async (ctx) => {
    const tasks = await ctx.db
      .query("tasks")
      .filter((q) => q.eq(q.field("status"), "queued"))
      .order("asc")
      .collect();
    const task = tasks[0];
    if (!task) return null;
    await ctx.db.patch(task._id, { status: "running" });
    return task;
  },
});

export const getForWorker = query({
  args: { taskId: v.id("tasks") },
  handler: async (ctx, args) => {
    const task = await ctx.db.get(args.taskId);
    if (!task) return null;
    const project = await ctx.db.get(task.projectId);
    const allAgents = await ctx.db.query("agents").collect();
    const agents = project?.agentIds
      ? allAgents.filter((agent) => project.agentIds?.includes(agent._id))
      : allAgents;
    return { task, project, agents };
  },
});
